import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Request, type Response } from "express";

import { HermesAdapter } from "../adapters/hermes-adapter.js";
import { OpenClawAdapter } from "../adapters/openclaw-adapter.js";
import type { BotAdapter, BotReply } from "../core/bot-adapter.js";
import { createReportStore, type ReportStore } from "../core/report-store.js";
import {
  loadScenariosForAdapter,
  ScenarioLoadError,
} from "../core/scenario-loader.js";
import { runScenario } from "../core/scenario-runner.js";
import type { Scenario } from "../core/scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const PUBLIC_DIR = join(HERE, "public");
const DEFAULT_SCENARIO_DIR = join(PROJECT_ROOT, "scenarios");
const DEFAULT_REPORTS_DIR = join(PROJECT_ROOT, "reports");
const DEFAULT_KEY_PATH = join(
  PROJECT_ROOT,
  ".agentprobe-keys",
  "openclaw-ed25519.pem",
);

export interface WebServerOptions {
  port?: number;
  scenarioDir?: string;
  reportsDir?: string;
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
  const reports: ReportStore = createReportStore(reportsDir);

  const entries = buildAdapterEntries();
  const runtime = new Map<AdapterKind, AdapterRuntime>();
  for (const entry of entries) {
    runtime.set(entry.kind, { entry, connected: false });
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
    res.json({
      adapter: kind,
      botLabel: rt.entry.botLabel,
      transport: rt.entry.transport,
      connected: rt.connected,
      connectionError: rt.connectError ?? null,
      scenarioDir,
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
      const result = await runScenario(adapter, scenario);
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
      const startedAt = Date.now();
      const results = [];
      for (const scenario of scenarios) {
        results.push(await runScenario(adapter, scenario));
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

function summarizeScenario(s: Scenario) {
  return {
    name: s.name,
    description: s.description ?? null,
    session: s.session ?? "shared",
    stepCount: s.steps.length,
    assertionCount: s.steps.reduce((n, step) => n + step.assertions.length, 0),
  };
}
