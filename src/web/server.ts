import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Request, type Response } from "express";

import { HermesAdapter } from "../adapters/hermes-adapter.js";
import { queryAgentDB } from "../adapters/openclaw-agentdb.js";
import { OpenClawAdapter } from "../adapters/openclaw-adapter.js";
import type { BotAdapter, BotReply } from "../core/bot-adapter.js";
import { createReportStore, type ReportStore } from "../core/report-store.js";
import {
  loadScenariosForAdapter,
  ScenarioLoadError,
} from "../core/scenario-loader.js";
import {
  runScenario,
  type PlatformHandlers,
} from "../core/scenario-runner.js";
import type { Scenario } from "../core/scenario.js";
import {
  checkOpenClawPairingStatus,
  discoverOpenClawConfig,
  ensureOpenClawPairingKey,
  pairOpenClawDevice,
  parseRailwaySshCommand,
  runStep,
  testHermesEcho,
  unpairOpenClawDevice,
  updateDotEnv,
  type RailwayCoordinates,
  type SetupResult,
  type SetupStep,
} from "../core/setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const PUBLIC_DIR = join(HERE, "public");
const DEFAULT_SCENARIO_DIR = join(PROJECT_ROOT, "scenarios");
const DEFAULT_REPORTS_DIR = join(PROJECT_ROOT, "reports");
const DEFAULT_DOTENV_PATH = join(PROJECT_ROOT, ".env");
const DEFAULT_KEY_PATH = join(
  PROJECT_ROOT,
  ".agentprobe-keys",
  "openclaw-ed25519.pem",
);

export interface WebServerOptions {
  port?: number;
  scenarioDir?: string;
  reportsDir?: string;
  dotenvPath?: string;
}

type AdapterKind = "openclaw" | "hermes";

interface AdapterEntry {
  kind: AdapterKind;
  /** Display label for UI. */
  label: string;
  /** Short description shown in the picker. */
  description: string;
  /** Whether this adapter has all the env vars it needs. */
  configured: boolean;
  /** Why it's not configured, if applicable. */
  configurationError?: string;
  /** Lazy factory — the adapter itself is only built on first use. */
  build?: () => BotAdapter;
  /** Human-readable "bot identity" for the status card. */
  botLabel: string;
  /** The transport URL or connection string shown in the status card. */
  transport: string;
}

interface AdapterRuntime {
  entry: AdapterEntry;
  instance?: BotAdapter;
  connected: boolean;
  connectPromise?: Promise<void>;
  connectError?: string;
}

/**
 * AgentProbe dashboard — Express server that speaks to both OpenClaw and
 * Hermes through a shared BotAdapter interface.
 *
 * Routes:
 *   GET  /                              static HTML UI
 *   GET  /api/adapters                  list available adapters + configured flag
 *   GET  /api/status?adapter=<kind>     connection state for one adapter
 *   POST /api/chat                      { adapter, text, sessionKey? }
 *   GET  /api/scenarios?adapter=<kind>  list scenarios for one adapter
 *   POST /api/scenarios/:name?adapter=<kind>   run one
 *   POST /api/scenarios?adapter=<kind>         run whole suite for one adapter
 *
 * Adapter lifecycle:
 *   - OpenClaw is connected eagerly at server boot (fast handshake).
 *   - Hermes is connected lazily on first request (every SSH call costs
 *     a few seconds, so we don't pay the price until the user actually
 *     picks it).
 *
 * The `adapter` param defaults to "openclaw" on every route so older
 * clients that don't know about the picker continue to work.
 */
export async function startWebServer(opts: WebServerOptions = {}): Promise<void> {
  const port = opts.port ?? 4000;
  const scenarioDir = opts.scenarioDir ?? DEFAULT_SCENARIO_DIR;
  const reportsDir = opts.reportsDir ?? DEFAULT_REPORTS_DIR;
  const dotenvPath = opts.dotenvPath ?? DEFAULT_DOTENV_PATH;
  const reports: ReportStore = createReportStore(reportsDir);

  // Adapter entries are rebuildable at runtime because the setup wizard
  // can reconfigure an adapter without restarting the server. `entries`
  // is the flat list for the /api/adapters route; `runtime` holds the
  // (possibly connected) instance for each kind. Both get swapped when
  // reloadAdapter(kind) is called.
  let entries = buildAdapterEntries();
  const runtime = new Map<AdapterKind, AdapterRuntime>();
  for (const entry of entries) {
    runtime.set(entry.kind, { entry, connected: false });
  }

  /**
   * Build platform handlers for the given adapter kind based on the
   * current process.env. Only OpenClaw gets AgentDB query support, and
   * only when RAILWAY_PROJECT/ENVIRONMENT/SERVICE are all set.
   */
  function buildPlatformHandlers(kind: AdapterKind): PlatformHandlers {
    if (kind !== "openclaw") return {};
    const project = process.env.RAILWAY_PROJECT;
    const environment = process.env.RAILWAY_ENVIRONMENT;
    const service = process.env.RAILWAY_SERVICE;
    if (!project || !environment || !service) return {};
    const coords = { project, environment, service };
    const agentId = process.env.OPENCLAW_AGENT_ID ?? "main";
    return {
      queryAgentDB: async (assertion) => {
        try {
          const result = await queryAgentDB({
            coords,
            agentId,
            sql: assertion.sql,
            ...(assertion.params ? { params: assertion.params } : {}),
          });
          return { rows: result.rows, rowCount: result.rowCount };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };
  }

  /**
   * Rebuild a single adapter entry from current process.env and replace
   * it in the runtime map. Disconnects the previous instance (if any) so
   * the next request runs a fresh handshake with the new config.
   */
  async function reloadAdapter(kind: AdapterKind): Promise<AdapterRuntime> {
    const fresh = buildAdapterEntries().find((e) => e.kind === kind);
    if (!fresh) throw new Error(`unknown adapter kind: ${kind}`);
    const prior = runtime.get(kind);
    if (prior?.instance) {
      try {
        await prior.instance.disconnect();
      } catch {
        /* ignore */
      }
    }
    entries = entries.map((e) => (e.kind === kind ? fresh : e));
    const next: AdapterRuntime = { entry: fresh, connected: false };
    runtime.set(kind, next);
    return next;
  }

  // Eagerly connect OpenClaw at boot — the handshake is quick and the UI
  // defaults to it, so the first page load shouldn't stall on a cold connect.
  const openclawRt = runtime.get("openclaw");
  if (openclawRt?.entry.configured) {
    try {
      await getOrConnect(openclawRt);
      console.log(
        `[web] connected to openclaw at ${openclawRt.entry.transport}`,
      );
    } catch (err) {
      console.error(
        `[web] openclaw connect failed at boot: ${(err as Error).message}`,
      );
      console.error(`[web] server will start anyway; /api/status reports the error`);
    }
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/adapters", (_req, res) => {
    res.json({
      adapters: entries.map((e) => ({
        kind: e.kind,
        label: e.label,
        description: e.description,
        configured: e.configured,
        configurationError: e.configurationError ?? null,
        botLabel: e.botLabel,
        transport: e.transport,
      })),
    });
  });

  app.get("/api/status", async (req, res) => {
    const kind = resolveAdapterKind(req);
    const rt = runtime.get(kind);
    if (!rt) {
      res.status(400).json({ error: `unknown adapter: ${kind}` });
      return;
    }
    if (!rt.entry.configured) {
      res.json({
        adapter: kind,
        botLabel: rt.entry.botLabel,
        transport: rt.entry.transport,
        connected: false,
        connectionError: rt.entry.configurationError ?? "not configured",
        scenarioDir,
        pairing: null,
      });
      return;
    }
    // Lazily connect Hermes on first status check so the UI reflects a real
    // connection state once the user switches to it.
    try {
      await getOrConnect(rt);
    } catch {
      /* error is already captured on rt */
    }

    // Pairing status is OpenClaw-only — Hermes uses a simple shell-out
    // with no device attestation. For OpenClaw, we fire a short SSH
    // check-and-return against the target paired.json. Failures (SSH
    // down, file missing, etc.) are non-fatal: we return pairing: null
    // and the UI just doesn't render the card.
    let pairing: null | {
      deviceId: string;
      deviceIdShort: string;
      paired: boolean;
      totalPairedDevices: number;
    } = null;
    if (kind === "openclaw") {
      try {
        const coords = readOpenClawCoords();
        if (coords) {
          const key = ensureOpenClawPairingKey(DEFAULT_KEY_PATH);
          const status = await checkOpenClawPairingStatus(coords, key.deviceId);
          pairing = {
            deviceId: key.deviceId,
            deviceIdShort: key.deviceId.slice(0, 16) + "…",
            paired: status.paired,
            totalPairedDevices: status.totalPairedDevices,
          };
        }
      } catch {
        /* swallow — pairing status is best-effort */
      }
    }

    res.json({
      adapter: kind,
      botLabel: rt.entry.botLabel,
      transport: rt.entry.transport,
      connected: rt.connected,
      connectionError: rt.connectError ?? null,
      scenarioDir,
      pairing,
    });
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    const kind = resolveAdapterKind(req);
    const rt = runtime.get(kind);
    if (!rt || !rt.entry.configured) {
      res
        .status(503)
        .json({ error: `adapter "${kind}" is not configured`, details: rt?.entry.configurationError ?? null });
      return;
    }

    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
      res.status(400).json({ error: "body.text must be a non-empty string" });
      return;
    }
    const sessionKey =
      typeof req.body?.sessionKey === "string" && req.body.sessionKey.length > 0
        ? (req.body.sessionKey as string)
        : undefined;

    try {
      const adapter = await getOrConnect(rt);
      const reply: BotReply = await adapter.sendMessage({
        text,
        ...(sessionKey ? { sessionKey } : {}),
      });
      res.json({
        adapter: kind,
        text: reply.text,
        responseTimeMs: reply.responseTimeMs,
        events: reply.events,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/scenarios", (req, res) => {
    const kind = resolveAdapterKind(req);
    try {
      const scenarios = loadScenariosForAdapter(scenarioDir, kind);
      res.json({
        adapter: kind,
        scenarios: scenarios.map((s) => summarizeScenario(s)),
      });
    } catch (err) {
      if (err instanceof ScenarioLoadError) {
        res.status(500).json({ error: err.message, filePath: err.filePath });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  app.post("/api/scenarios/:name", async (req: Request, res: Response) => {
    const kind = resolveAdapterKind(req);
    const rt = runtime.get(kind);
    if (!rt || !rt.entry.configured) {
      res.status(503).json({ error: `adapter "${kind}" is not configured` });
      return;
    }
    try {
      const scenarios = loadScenariosForAdapter(scenarioDir, kind);
      const scenario = scenarios.find((s) => s.name === req.params.name);
      if (!scenario) {
        res.status(404).json({ error: `no scenario named "${req.params.name}" for adapter "${kind}"` });
        return;
      }
      const adapter = await getOrConnect(rt);
      const startedAt = Date.now();
      const result = await runScenario(adapter, scenario, {
        platformHandlers: buildPlatformHandlers(kind),
      });
      const durationMs = Date.now() - startedAt;
      // Persist so the Results tab can read the run back.
      try {
        const record = reports.saveRun({
          adapter: kind,
          trigger: "web-single",
          scope: "single",
          label: scenario.name,
          startedAt,
          durationMs,
          results: [result],
        });
        res.json({ ...result, runId: record.id });
      } catch (saveErr) {
        console.error(`[web] failed to persist run: ${(saveErr as Error).message}`);
        res.json(result);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/scenarios", async (req: Request, res: Response) => {
    const kind = resolveAdapterKind(req);
    const rt = runtime.get(kind);
    if (!rt || !rt.entry.configured) {
      res.status(503).json({ error: `adapter "${kind}" is not configured` });
      return;
    }
    try {
      const scenarios = loadScenariosForAdapter(scenarioDir, kind);
      const adapter = await getOrConnect(rt);
      const handlers = buildPlatformHandlers(kind);
      const startedAt = Date.now();
      const results = [];
      for (const scenario of scenarios) {
        results.push(
          await runScenario(adapter, scenario, { platformHandlers: handlers }),
        );
      }
      const durationMs = Date.now() - startedAt;
      const passed = results.filter((r) => r.passed).length;
      let runId: string | undefined;
      try {
        const record = reports.saveRun({
          adapter: kind,
          trigger: "web-suite",
          scope: "suite",
          label: "suite",
          startedAt,
          durationMs,
          results,
        });
        runId = record.id;
      } catch (saveErr) {
        console.error(`[web] failed to persist suite run: ${(saveErr as Error).message}`);
      }
      res.json({
        adapter: kind,
        passed,
        total: results.length,
        results,
        ...(runId ? { runId } : {}),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/history", (req, res) => {
    const kind = resolveAdapterKind(req);
    const limitParam = req.query.limit;
    const limit =
      typeof limitParam === "string" && /^\d+$/.test(limitParam)
        ? Math.min(Number.parseInt(limitParam, 10), 500)
        : 50;
    try {
      const runs = reports.listRuns(kind, { limit });
      const aggregate = reports.computeAggregate(kind);
      res.json({ adapter: kind, runs, aggregate });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/setup/connect", async (req: Request, res: Response) => {
    // Payload: { platform: "openclaw" | "hermes", sshCommand: string }
    const platformRaw = req.body?.platform;
    const sshCommandRaw = req.body?.sshCommand;
    if (platformRaw !== "openclaw" && platformRaw !== "hermes") {
      res.status(400).json({ error: "platform must be 'openclaw' or 'hermes'" });
      return;
    }
    if (typeof sshCommandRaw !== "string" || !sshCommandRaw.trim()) {
      res.status(400).json({ error: "sshCommand must be a non-empty string" });
      return;
    }
    const platform = platformRaw as AdapterKind;
    const sshCommand = sshCommandRaw;

    const steps: SetupStep[] = [];
    const envUpdates: Record<string, string> = {};
    const result: SetupResult = {
      platform,
      success: false,
      steps,
      envUpdates,
    };

    // 1. Parse the railway ssh command → coordinates
    const parsed = await runStep("parse", "Parse railway ssh command", () =>
      parseRailwaySshCommand(sshCommand),
    );
    steps.push(parsed.step);
    if (!parsed.value) {
      result.error = parsed.step.detail ?? "unknown error";
      res.json(result);
      return;
    }
    const coords = parsed.value;
    parsed.step.detail = `project=${coords.project.slice(0, 8)}… env=${coords.environment.slice(0, 8)}… service=${coords.service.slice(0, 8)}…`;

    if (platform === "openclaw") {
      // 2. Discover gateway URL + token + agent id from inside the container
      const discovered = await runStep(
        "discover",
        "Discover gateway URL, token, agent",
        () => discoverOpenClawConfig(coords),
      );
      steps.push(discovered.step);
      if (!discovered.value) {
        result.error = discovered.step.detail ?? "unknown error";
        res.json(result);
        return;
      }
      discovered.step.detail = `gatewayUrl=${discovered.value.gatewayUrl} agent=${discovered.value.agentId}`;

      // 3. Generate (or load) pairing key
      const keyStep = await runStep(
        "key",
        "Load or generate Ed25519 pairing key",
        () => ensureOpenClawPairingKey(DEFAULT_KEY_PATH),
      );
      steps.push(keyStep.step);
      if (!keyStep.value) {
        result.error = keyStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }
      keyStep.step.detail = `deviceId=${keyStep.value.deviceId.slice(0, 16)}…`;

      // 4. Inject device record into paired.json
      const pairStep = await runStep(
        "pair",
        "Install device record in OpenClaw paired.json",
        () => pairOpenClawDevice(coords, keyStep.value!),
      );
      steps.push(pairStep.step);
      if (pairStep.step.status !== "ok") {
        result.error = pairStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }

      // 5. Write env updates
      const writeStep = await runStep("env", "Write credentials to .env", () => {
        envUpdates.OPENCLAW_GATEWAY_URL = discovered.value!.gatewayUrl;
        envUpdates.OPENCLAW_GATEWAY_TOKEN = discovered.value!.gatewayToken;
        envUpdates.OPENCLAW_AGENT_ID = discovered.value!.agentId;
        envUpdates.RAILWAY_PROJECT = coords.project;
        envUpdates.RAILWAY_ENVIRONMENT = coords.environment;
        envUpdates.RAILWAY_SERVICE = coords.service;
        updateDotEnv(dotenvPath, envUpdates);
        // Apply in-memory so the rebuilt adapter entry sees the new values
        for (const [k, v] of Object.entries(envUpdates)) {
          process.env[k] = v;
        }
      });
      steps.push(writeStep.step);
      if (writeStep.step.status !== "ok") {
        result.error = writeStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }

      // 6. Rebuild adapter and connect
      const connectStep = await runStep(
        "connect",
        "Reload adapter and run handshake",
        async () => {
          const rt = await reloadAdapter("openclaw");
          await getOrConnect(rt);
        },
      );
      steps.push(connectStep.step);
      if (connectStep.step.status !== "ok") {
        result.error = connectStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }

      // 7. Send a probe message to prove end-to-end
      const pingStep = await runStep(
        "ping",
        "Send a probe message and wait for a reply",
        async () => {
          const rt = runtime.get("openclaw");
          if (!rt?.instance) throw new Error("adapter missing after reload");
          const reply = await rt.instance.sendMessage({
            text: "respond with exactly: AGENTPROBE_OPENCLAW_SETUP_OK",
            timeoutMs: 60_000,
          });
          if (!reply.text || !reply.text.includes("AGENTPROBE_OPENCLAW_SETUP_OK")) {
            throw new Error(
              `unexpected reply (first 120 chars): ${(reply.text || "").slice(0, 120)}`,
            );
          }
          return reply.text;
        },
      );
      steps.push(pingStep.step);
      if (pingStep.step.status !== "ok") {
        result.error = pingStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }
      if (pingStep.value) {
        pingStep.step.detail = `reply: ${pingStep.value.slice(0, 80)}`;
      }
    } else {
      // Hermes path — no discovery needed, no pairing. Just save coords
      // and run a probe query through the shell-out transport.
      const writeStep = await runStep("env", "Write Railway coords to .env", () => {
        envUpdates.HERMES_RAILWAY_PROJECT = coords.project;
        envUpdates.HERMES_RAILWAY_ENVIRONMENT = coords.environment;
        envUpdates.HERMES_RAILWAY_SERVICE = coords.service;
        updateDotEnv(dotenvPath, envUpdates);
        for (const [k, v] of Object.entries(envUpdates)) {
          process.env[k] = v;
        }
      });
      steps.push(writeStep.step);
      if (writeStep.step.status !== "ok") {
        result.error = writeStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }

      const connectStep = await runStep(
        "connect",
        "Reload adapter and run preflight",
        async () => {
          const rt = await reloadAdapter("hermes");
          await getOrConnect(rt);
        },
      );
      steps.push(connectStep.step);
      if (connectStep.step.status !== "ok") {
        result.error = connectStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }

      const pingStep = await runStep(
        "ping",
        "Send a probe message and wait for a reply",
        () => testHermesEcho(coords),
      );
      steps.push(pingStep.step);
      if (pingStep.step.status !== "ok") {
        result.error = pingStep.step.detail ?? "unknown error";
        res.json(result);
        return;
      }
      pingStep.step.detail = "reply: AGENTPROBE_HERMES_OK";
    }

    // Mask secrets before returning — the UI shouldn't see the raw token.
    const maskedEnvUpdates: Record<string, string> = {};
    for (const [k, v] of Object.entries(envUpdates)) {
      if (/token|key|secret|password/i.test(k)) {
        maskedEnvUpdates[k] = v.length > 8 ? v.slice(0, 4) + "…" + v.slice(-4) : "****";
      } else {
        maskedEnvUpdates[k] = v;
      }
    }
    result.envUpdates = maskedEnvUpdates;
    result.success = true;
    res.json(result);
  });

  app.post("/api/setup/unpair", async (req: Request, res: Response) => {
    // Payload: { platform: "openclaw" } — Hermes has nothing to unpair.
    if (req.body?.platform !== "openclaw") {
      res.status(400).json({
        error: "unpair is only supported for the openclaw platform",
      });
      return;
    }
    try {
      const coords = readOpenClawCoords();
      if (!coords) {
        res.status(400).json({
          error:
            "RAILWAY_PROJECT / ENVIRONMENT / SERVICE env vars must be set",
        });
        return;
      }
      const key = ensureOpenClawPairingKey(DEFAULT_KEY_PATH);
      const result = await unpairOpenClawDevice(coords, key.deviceId);

      // Force a fresh adapter build on the next connect so the cached
      // (potentially unauthorised) instance gets thrown away.
      await reloadAdapter("openclaw");

      res.json({
        success: true,
        deviceId: key.deviceId,
        deviceIdShort: key.deviceId.slice(0, 16) + "…",
        removed: result.removed,
        remainingDeviceCount: result.remainingDeviceCount,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/history/:id", (req: Request, res: Response) => {
    const kind = resolveAdapterKind(req);
    const idRaw = req.params.id;
    const id = typeof idRaw === "string" ? idRaw : "";
    if (!id) {
      res.status(400).json({ error: "missing run id" });
      return;
    }
    try {
      const record = reports.getRun(kind, id);
      if (!record) {
        res.status(404).json({ error: `no run with id "${id}" for adapter "${kind}"` });
        return;
      }
      res.json(record);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.listen(port, () => {
    console.log(`[web] AgentProbe dashboard running at http://localhost:${port}`);
    console.log(`[web] scenarios: ${scenarioDir}`);
  });

  // Graceful shutdown so connections don't leak on Ctrl+C.
  const shutdown = async () => {
    console.log("\n[web] shutting down");
    for (const rt of runtime.values()) {
      if (rt.instance) {
        try {
          await rt.instance.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// -------- adapter construction --------

function buildAdapterEntries(): AdapterEntry[] {
  return [buildOpenClawEntry(), buildHermesEntry()];
}

function buildOpenClawEntry(): AdapterEntry {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const agentId = process.env.OPENCLAW_AGENT_ID ?? "main";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const devicePrivateKeyPem = existsSync(DEFAULT_KEY_PATH)
    ? readFileSync(DEFAULT_KEY_PATH, "utf8")
    : undefined;

  if (!gatewayUrl) {
    return {
      kind: "openclaw",
      label: "OpenClaw",
      description: "Native WebSocket RPC with Ed25519 device attestation.",
      configured: false,
      configurationError: "OPENCLAW_GATEWAY_URL is not set",
      botLabel: "—",
      transport: "not configured",
    };
  }

  return {
    kind: "openclaw",
    label: "OpenClaw",
    description: "Native WebSocket RPC with Ed25519 device attestation.",
    configured: true,
    botLabel: `agent: ${agentId}`,
    transport: gatewayUrl,
    build: () =>
      new OpenClawAdapter({
        gatewayUrl,
        agentId,
        clientName: "agentprobe-web",
        ...(token ? { token } : {}),
        ...(devicePrivateKeyPem ? { devicePrivateKeyPem } : {}),
      }),
  };
}

function buildHermesEntry(): AdapterEntry {
  const project = process.env.HERMES_RAILWAY_PROJECT;
  const environment = process.env.HERMES_RAILWAY_ENVIRONMENT;
  const service = process.env.HERMES_RAILWAY_SERVICE;

  if (!project || !environment || !service) {
    return {
      kind: "hermes",
      label: "Hermes",
      description: "Shell-out to `hermes chat` over railway ssh.",
      configured: false,
      configurationError:
        "HERMES_RAILWAY_PROJECT / ENVIRONMENT / SERVICE not set",
      botLabel: "—",
      transport: "not configured",
    };
  }

  return {
    kind: "hermes",
    label: "Hermes",
    description: "Shell-out to `hermes chat` over railway ssh.",
    configured: true,
    botLabel: `service: ${service.slice(0, 8)}…`,
    transport: `railway ssh → ${service.slice(0, 8)}…`,
    build: () =>
      new HermesAdapter({
        railwayProject: project,
        railwayEnvironment: environment,
        railwayService: service,
      }),
  };
}

// -------- runtime helpers --------

async function getOrConnect(rt: AdapterRuntime): Promise<BotAdapter> {
  if (!rt.entry.build) {
    throw new Error(`adapter "${rt.entry.kind}" is not configured`);
  }
  if (rt.instance && rt.connected) return rt.instance;

  // De-duplicate in-flight connects so two simultaneous requests don't
  // both run the handshake. This matters for Hermes where the handshake
  // involves a real SSH invocation.
  if (rt.connectPromise) {
    await rt.connectPromise;
    if (!rt.instance) throw new Error(rt.connectError ?? "connect failed");
    return rt.instance;
  }

  const instance = rt.entry.build();
  rt.instance = instance;
  rt.connectPromise = (async () => {
    try {
      await instance.connect();
      rt.connected = true;
      delete rt.connectError;
    } catch (err) {
      rt.connected = false;
      rt.connectError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      delete rt.connectPromise;
    }
  })();

  await rt.connectPromise;
  return instance;
}

function resolveAdapterKind(req: Request): AdapterKind {
  const raw =
    (typeof req.query?.adapter === "string" && req.query.adapter) ||
    (typeof req.body?.adapter === "string" && req.body.adapter) ||
    "openclaw";
  if (raw === "openclaw" || raw === "hermes") return raw;
  return "openclaw";
}

function readOpenClawCoords(): RailwayCoordinates | undefined {
  const project = process.env.RAILWAY_PROJECT;
  const environment = process.env.RAILWAY_ENVIRONMENT;
  const service = process.env.RAILWAY_SERVICE;
  if (!project || !environment || !service) return undefined;
  return { project, environment, service };
}

function summarizeScenario(s: Scenario) {
  return {
    name: s.name,
    description: s.description ?? null,
    session: s.session ?? "shared",
    stepCount: s.steps.length,
    assertionCount: s.steps.reduce((n, step) => n + step.assertions.length, 0),
  };
}
