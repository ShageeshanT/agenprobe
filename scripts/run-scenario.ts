/**
 * Run one or more scenarios against a configured bot.
 *
 * Usage:
 *   pnpm tsx scripts/run-scenario.ts <path-to-yaml>            # one file
 *   pnpm tsx scripts/run-scenario.ts scenarios/                # a directory
 *   pnpm tsx scripts/run-scenario.ts                           # default: ./scenarios
 *
 *   --adapter openclaw   (default — uses OPENCLAW_* env vars)
 *   --adapter hermes     (uses HERMES_RAILWAY_* env vars)
 *
 * Exit codes:
 *   0 — every scenario passed
 *   1 — one or more scenarios had critical failures
 *   2 — configuration / load error (before any scenario ran)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import { HermesAdapter } from "../src/adapters/hermes-adapter.js";
import { queryAgentDB } from "../src/adapters/openclaw-agentdb.js";
import { OpenClawAdapter } from "../src/adapters/openclaw-adapter.js";
import type { BotAdapter } from "../src/core/bot-adapter.js";
import { createReportStore } from "../src/core/report-store.js";
import {
  loadScenario,
  loadScenariosForAdapter,
  loadScenariosFromDir,
  ScenarioLoadError,
} from "../src/core/scenario-loader.js";
import {
  runScenario,
  type PlatformHandlers,
} from "../src/core/scenario-runner.js";
import type { ScenarioResult } from "../src/core/scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const DEFAULT_KEY_PATH = join(
  PROJECT_ROOT,
  ".agentprobe-keys",
  "openclaw-ed25519.pem",
);
const DEFAULT_SCENARIO_DIR = join(PROJECT_ROOT, "scenarios");
const DEFAULT_REPORTS_DIR = join(PROJECT_ROOT, "reports");

interface CliArgs {
  target: string;
  adapter: "openclaw" | "hermes";
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { target: DEFAULT_SCENARIO_DIR, adapter: "openclaw" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--adapter") {
      const next = argv[i + 1];
      if (next === "openclaw" || next === "hermes") {
        args.adapter = next;
        i++;
      } else {
        console.error(`--adapter expects "openclaw" or "hermes", got ${next}`);
        process.exit(2);
      }
    } else if (a && !a.startsWith("--")) {
      args.target = a;
    }
  }
  return args;
}

/**
 * Build platform-specific async assertion handlers for the scenario
 * runner. Currently only OpenClaw exposes AgentDB reads — and only if
 * the RAILWAY_PROJECT/ENVIRONMENT/SERVICE env vars are set so the
 * helper can SSH into the container. Hermes has nothing equivalent,
 * so it returns an empty handlers object and agentdb_query assertions
 * will be skipped cleanly.
 */
function buildPlatformHandlers(
  kind: "openclaw" | "hermes",
): PlatformHandlers {
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

function buildAdapter(kind: "openclaw" | "hermes"): BotAdapter {
  if (kind === "hermes") {
    const project = process.env.HERMES_RAILWAY_PROJECT;
    const environment = process.env.HERMES_RAILWAY_ENVIRONMENT;
    const service = process.env.HERMES_RAILWAY_SERVICE;
    if (!project || !environment || !service) {
      console.error(
        "HERMES_RAILWAY_PROJECT, HERMES_RAILWAY_ENVIRONMENT, HERMES_RAILWAY_SERVICE must be set. See .env.example.",
      );
      process.exit(2);
    }
    return new HermesAdapter({
      railwayProject: project,
      railwayEnvironment: environment,
      railwayService: service,
    });
  }
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) {
    console.error("OPENCLAW_GATEWAY_URL is not set. See README for setup.");
    process.exit(2);
  }
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const devicePrivateKeyPem = existsSync(DEFAULT_KEY_PATH)
    ? readFileSync(DEFAULT_KEY_PATH, "utf8")
    : undefined;
  return new OpenClawAdapter({
    gatewayUrl,
    agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
    clientName: "agentprobe-runner",
    ...(token ? { token } : {}),
    ...(devicePrivateKeyPem ? { devicePrivateKeyPem } : {}),
  });
}

async function main() {
  const { target, adapter: adapterKind } = parseArgs(process.argv.slice(2));

  if (!existsSync(target)) {
    console.error(`scenario path does not exist: ${target}`);
    process.exit(2);
  }

  let scenarios;
  try {
    if (statSync(target).isDirectory()) {
      // Multi-platform loader understands the scenarios/common +
      // scenarios/<adapter> layout. Falls back to flat loading for legacy
      // layouts.
      scenarios = loadScenariosForAdapter(target, adapterKind);
    } else {
      scenarios = [loadScenario(target)];
    }
  } catch (err) {
    if (err instanceof ScenarioLoadError) {
      console.error(`scenario load error in ${err.filePath}: ${err.message}`);
    } else {
      console.error("scenario load error:", err);
    }
    process.exit(2);
  }

  if (scenarios.length === 0) {
    console.error(`no scenarios found in ${target}`);
    process.exit(2);
  }

  const adapter = buildAdapter(adapterKind);
  const platformHandlers = buildPlatformHandlers(adapterKind);

  console.log(`connecting via adapter: ${adapterKind}`);
  try {
    await adapter.connect();
  } catch (err) {
    console.error("connect failed:", err);
    process.exit(2);
  }
  console.log(`connected. running ${scenarios.length} scenario(s) against ${adapter.name}.`);
  if (platformHandlers.queryAgentDB) {
    console.log("platform handlers: agentdb_query enabled");
  }

  const runStartedAt = Date.now();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log();
    console.log("=".repeat(72));
    console.log(`${scenario.name}`);
    if (scenario.description) console.log(`  ${scenario.description}`);
    console.log("=".repeat(72));

    const result = await runScenario(adapter, scenario, { platformHandlers });
    results.push(result);
    printScenarioResult(result);
  }
  const runDurationMs = Date.now() - runStartedAt;

  await adapter.disconnect();

  // Persist the run to reports/<adapter>/<id>-<label>.json so the web
  // dashboard's Results tab (and future CI consumers) can read it back.
  try {
    const store = createReportStore(DEFAULT_REPORTS_DIR);
    const record = store.saveRun({
      adapter: adapterKind,
      trigger: "cli",
      scope: results.length === 1 ? "single" : "suite",
      label: results.length === 1 ? (results[0]?.scenario ?? "run") : "suite",
      startedAt: runStartedAt,
      durationMs: runDurationMs,
      results,
    });
    console.log();
    console.log(`saved run report: reports/${adapterKind}/${record.id}-*.json`);
  } catch (err) {
    console.error(
      `(warning: failed to save run report: ${(err as Error).message})`,
    );
  }

  // Summary
  console.log();
  console.log("=".repeat(72));
  console.log("SUMMARY");
  console.log("=".repeat(72));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    const warnings =
      r.warningFailures > 0 ? ` (${r.warningFailures} warnings)` : "";
    console.log(`  [${icon}] ${r.scenario}  — ${r.durationMs}ms${warnings}`);
  }
  console.log(
    `${passed}/${results.length} scenarios passed${failed > 0 ? ` (${failed} failed)` : ""}.`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

function printScenarioResult(result: ScenarioResult) {
  for (const step of result.steps) {
    const icon = step.passed ? "PASS" : "FAIL";
    console.log(
      `  [${icon}] ${step.name}  (${step.replyTimeMs}ms, ${step.eventCount} events)`,
    );
    console.log(`       send:  ${truncate(step.send, 80)}`);
    console.log(`       reply: ${truncate(step.reply, 80)}`);
    if (step.error) {
      console.log(`       ERROR: ${step.error}`);
    }
    for (const a of step.assertions) {
      const mark = a.passed ? " ok " : a.severity === "warning" ? "warn" : "FAIL";
      console.log(`         [${mark}] ${a.message}`);
    }
  }
  if (result.error) {
    console.log(`  scenario aborted: ${result.error}`);
  }
}

function truncate(s: string, max: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

main().catch((err) => {
  console.error("run-scenario crashed:", err);
  process.exit(1);
});
