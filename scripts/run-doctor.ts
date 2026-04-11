/**
 * Run the OpenClaw doctor against the configured bot and print a report.
 *
 * Usage:
 *   npm run doctor
 *   npx tsx scripts/run-doctor.ts
 *
 * Exit codes:
 *   0 — every check passed (no `fail`; `warn` is allowed)
 *   1 — one or more checks failed
 *   2 — configuration error (missing env vars)
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import { buildOpenClawDoctorChecks } from "../src/adapters/openclaw-doctor.js";
import {
  createDoctorReportStore,
  runDoctor,
  type DoctorContext,
} from "../src/core/doctor-runner.js";
import type { DoctorReport } from "../src/core/doctor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const REPORTS_DIR = join(PROJECT_ROOT, "reports");

async function main() {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const project = process.env.RAILWAY_PROJECT;
  const environment = process.env.RAILWAY_ENVIRONMENT;
  const service = process.env.RAILWAY_SERVICE;
  const agentId = process.env.OPENCLAW_AGENT_ID ?? "main";

  if (!gatewayUrl) {
    console.error("OPENCLAW_GATEWAY_URL is not set. See README.");
    process.exit(2);
  }
  if (!project || !environment || !service) {
    console.error(
      "RAILWAY_PROJECT, RAILWAY_ENVIRONMENT, RAILWAY_SERVICE must be set so doctor can read container state.",
    );
    process.exit(2);
  }

  const ctx: DoctorContext = {
    adapter: "openclaw",
    coords: { project, environment, service },
    gatewayUrl,
    agentId,
  };
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (token) ctx.gatewayToken = token;

  const checks = buildOpenClawDoctorChecks();

  console.log(`OpenClaw doctor — ${gatewayUrl}`);
  console.log(`agent: ${agentId} · ${checks.length} check(s)`);
  console.log();

  const report = await runDoctor(ctx, checks);

  printReport(report);

  // Persist
  try {
    const store = createDoctorReportStore(REPORTS_DIR);
    store.saveReport(report);
    console.log();
    console.log(`saved doctor report: reports/openclaw/doctor/${report.id}.json`);
  } catch (err) {
    console.error(
      `(warning: failed to save doctor report: ${(err as Error).message})`,
    );
  }

  process.exit(report.passed ? 0 : 1);
}

function printReport(report: DoctorReport) {
  // Group checks by category for readability.
  const byCategory = new Map<string, typeof report.checks>();
  for (const c of report.checks) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }

  for (const [category, checks] of byCategory) {
    console.log("=".repeat(72));
    console.log(category.toUpperCase());
    console.log("=".repeat(72));
    for (const c of checks) {
      const icon =
        c.status === "ok"
          ? "[ ok ]"
          : c.status === "warn"
            ? "[warn]"
            : c.status === "fail"
              ? "[FAIL]"
              : "[skip]";
      console.log(`  ${icon}  ${c.label}  (${c.durationMs}ms)`);
      console.log(`         ${c.detail}`);
    }
    console.log();
  }

  console.log("=".repeat(72));
  console.log("SUMMARY");
  console.log("=".repeat(72));
  const s = report.summary;
  console.log(
    `  ${s.ok} ok, ${s.warn} warn, ${s.fail} fail, ${s.skip} skip — ${s.total} total`,
  );
  console.log(
    `  duration: ${(report.durationMs / 1000).toFixed(1)}s · verdict: ${report.passed ? "PASS" : "FAIL"}`,
  );
}

main().catch((err) => {
  console.error("doctor crashed:", err);
  process.exit(1);
});
