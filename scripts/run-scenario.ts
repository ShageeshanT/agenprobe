/**
 * Run one or more scenarios against the configured OpenClaw bot.
 *
 * Usage:
 *   pnpm tsx scripts/run-scenario.ts <path-to-yaml>            # one file
 *   pnpm tsx scripts/run-scenario.ts scenarios/                # a directory
 *   pnpm tsx scripts/run-scenario.ts                           # default: ./scenarios
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

import { OpenClawAdapter } from "../src/adapters/openclaw-adapter.js";
import {
  loadScenario,
  loadScenariosFromDir,
  ScenarioLoadError,
} from "../src/core/scenario-loader.js";
import { runScenario } from "../src/core/scenario-runner.js";
import type { ScenarioResult } from "../src/core/scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const DEFAULT_KEY_PATH = join(
  PROJECT_ROOT,
  ".agentprobe-keys",
  "openclaw-ed25519.pem",
);
const DEFAULT_SCENARIO_DIR = join(PROJECT_ROOT, "scenarios");

async function main() {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) {
    console.error("OPENCLAW_GATEWAY_URL is not set. See README for setup.");
    process.exit(2);
  }

  const target = process.argv[2] ?? DEFAULT_SCENARIO_DIR;
  if (!existsSync(target)) {
    console.error(`scenario path does not exist: ${target}`);
    process.exit(2);
  }

  let scenarios;
  try {
    scenarios = statSync(target).isDirectory()
      ? loadScenariosFromDir(target)
      : [loadScenario(target)];
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

  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const devicePrivateKeyPem = existsSync(DEFAULT_KEY_PATH)
    ? readFileSync(DEFAULT_KEY_PATH, "utf8")
    : undefined;

  const adapter = new OpenClawAdapter({
    gatewayUrl,
    agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
    clientName: "agentprobe-runner",
    ...(token ? { token } : {}),
    ...(devicePrivateKeyPem ? { devicePrivateKeyPem } : {}),
  });

  console.log(`connecting to ${gatewayUrl} ...`);
  try {
    await adapter.connect();
  } catch (err) {
    console.error("handshake failed:", err);
    process.exit(2);
  }
  console.log(`connected. running ${scenarios.length} scenario(s).`);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log();
    console.log("=".repeat(72));
    console.log(`${scenario.name}`);
    if (scenario.description) console.log(`  ${scenario.description}`);
    console.log("=".repeat(72));

    const result = await runScenario(adapter, scenario);
    results.push(result);
    printScenarioResult(result);
  }

  await adapter.disconnect();

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
