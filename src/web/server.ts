import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Request, type Response } from "express";

import { OpenClawAdapter } from "../adapters/openclaw-adapter.js";
import type { BotAdapter, BotReply } from "../core/bot-adapter.js";
import {
  loadScenariosFromDir,
  ScenarioLoadError,
} from "../core/scenario-loader.js";
import { runScenario } from "../core/scenario-runner.js";
import type { Scenario } from "../core/scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const PUBLIC_DIR = join(HERE, "public");
const DEFAULT_SCENARIO_DIR = join(PROJECT_ROOT, "scenarios");
const DEFAULT_KEY_PATH = join(
  PROJECT_ROOT,
  ".agentprobe-keys",
  "openclaw-ed25519.pem",
);

export interface WebServerOptions {
  port?: number;
  scenarioDir?: string;
}

/**
 * AgentProbe dashboard — minimal Express server that exposes:
 *
 *   GET  /                     → static HTML UI
 *   GET  /api/status           → gateway URL, agent id, connection state
 *   POST /api/chat             → send one message, return reply + events
 *   GET  /api/scenarios        → list available YAML scenarios
 *   POST /api/scenarios/:name  → run one scenario, return the full result
 *   POST /api/scenarios        → run every scenario, return the suite result
 *
 * The server holds a single long-lived OpenClawAdapter. All API endpoints
 * share that one connection, which means we pay the handshake cost once at
 * boot instead of per request.
 */
export async function startWebServer(opts: WebServerOptions = {}): Promise<void> {
  const port = opts.port ?? 4000;
  const scenarioDir = opts.scenarioDir ?? DEFAULT_SCENARIO_DIR;

  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) {
    throw new Error("OPENCLAW_GATEWAY_URL is not set. See README for setup.");
  }
  const agentId = process.env.OPENCLAW_AGENT_ID ?? "main";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const devicePrivateKeyPem = existsSync(DEFAULT_KEY_PATH)
    ? readFileSync(DEFAULT_KEY_PATH, "utf8")
    : undefined;

  const adapter: BotAdapter = new OpenClawAdapter({
    gatewayUrl,
    agentId,
    clientName: "agentprobe-web",
    ...(token ? { token } : {}),
    ...(devicePrivateKeyPem ? { devicePrivateKeyPem } : {}),
  });

  let connectionError: string | undefined;
  let connected = false;
  try {
    await adapter.connect();
    connected = true;
    console.log(`[web] connected to ${gatewayUrl} as agent "${agentId}"`);
  } catch (err) {
    connectionError = err instanceof Error ? err.message : String(err);
    console.error(`[web] handshake failed: ${connectionError}`);
    console.error("[web] server will start anyway; /api/status will report the error");
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/status", (_req, res) => {
    res.json({
      gatewayUrl,
      agentId,
      connected,
      connectionError: connectionError ?? null,
      scenarioDir,
    });
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    if (!connected) {
      res.status(503).json({ error: "bot adapter is not connected", details: connectionError ?? null });
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
      const reply: BotReply = await adapter.sendMessage({
        text,
        ...(sessionKey ? { sessionKey } : {}),
      });
      res.json({
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

  app.get("/api/scenarios", (_req, res) => {
    try {
      const scenarios = loadScenariosFromDir(scenarioDir);
      res.json({
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
    if (!connected) {
      res.status(503).json({ error: "bot adapter is not connected" });
      return;
    }
    try {
      const scenarios = loadScenariosFromDir(scenarioDir);
      const scenario = scenarios.find((s) => s.name === req.params.name);
      if (!scenario) {
        res.status(404).json({ error: `no scenario named "${req.params.name}"` });
        return;
      }
      const result = await runScenario(adapter, scenario);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/scenarios", async (_req: Request, res: Response) => {
    if (!connected) {
      res.status(503).json({ error: "bot adapter is not connected" });
      return;
    }
    try {
      const scenarios = loadScenariosFromDir(scenarioDir);
      const results = [];
      for (const scenario of scenarios) {
        results.push(await runScenario(adapter, scenario));
      }
      const passed = results.filter((r) => r.passed).length;
      res.json({
        passed,
        total: results.length,
        results,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.listen(port, () => {
    console.log(`[web] AgentProbe dashboard running at http://localhost:${port}`);
    console.log(`[web] scenarios: ${scenarioDir}`);
  });

  // Graceful shutdown so the WS doesn't leak on Ctrl+C.
  const shutdown = async () => {
    console.log("\n[web] shutting down");
    try {
      await adapter.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
