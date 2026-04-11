/**
 * Doctor runner + filesystem persistence.
 *
 * The runner is platform-agnostic. It takes a context (whatever the
 * checks need — coordinates, agent id, expected schema, etc.) and a
 * list of `DoctorCheck` objects, and produces a `DoctorReport` by
 * executing them in order, capturing failures, and tallying results.
 *
 * Persistence mirrors the existing report-store.ts pattern: one JSON
 * file per run under `reports/<adapter>/doctor/<id>.json`. We deliberately
 * keep doctor reports separate from scenario runs even though they share
 * a parent directory — they have different shapes and should be queried
 * independently.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import type {
  DoctorCheckResult,
  DoctorReport,
} from "./doctor.js";

import type { RailwayCoordinates } from "./setup.js";

// -------- check definitions --------

export interface DoctorContext {
  /** Adapter we're running against. Currently always "openclaw". */
  adapter: string;
  /** Railway SSH coordinates for remote checks (file reads, log greps). */
  coords?: RailwayCoordinates;
  /** Public gateway URL for HTTP checks. */
  gatewayUrl?: string;
  /** Gateway auth token, when needed for non-public endpoints. */
  gatewayToken?: string;
  /** Active agent id — used to resolve per-agent files like agentdb. */
  agentId: string;
  /**
   * Tables that MUST exist in AgentDB. The base set lives on the
   * default check; callers can extend it for bots with custom tables.
   */
  expectedAgentDBTables?: string[];
  /** Plugins (by config key) that MUST be enabled in openclaw.json. */
  expectedPlugins?: string[];
}

/**
 * A single doctor check. The `applies` predicate gates the check —
 * checks return `skip` (rather than `fail`) when the context doesn't
 * give them what they need to run.
 */
export interface DoctorCheck {
  id: string;
  label: string;
  category: DoctorCheckResult["category"];
  applies: (ctx: DoctorContext) => boolean;
  run: (
    ctx: DoctorContext,
  ) => Promise<
    Pick<DoctorCheckResult, "status" | "detail"> &
      Partial<Pick<DoctorCheckResult, "data">>
  >;
}

/**
 * Run every check in order against the given context and produce a
 * report. Checks are run sequentially because most of them shell out
 * to `railway ssh` and we don't want to overwhelm the SSH tunnel with
 * parallel requests; the cost is small (~1s per check on a healthy bot).
 */
export async function runDoctor(
  ctx: DoctorContext,
  checks: DoctorCheck[],
  options: { instanceLabel?: string } = {},
): Promise<DoctorReport> {
  const startedAt = Date.now();
  const checkResults: DoctorCheckResult[] = [];

  for (const check of checks) {
    if (!check.applies(ctx)) {
      checkResults.push({
        id: check.id,
        label: check.label,
        category: check.category,
        status: "skip",
        detail: "not applicable for this context",
        durationMs: 0,
      });
      continue;
    }

    const stepStart = Date.now();
    try {
      const partial = await check.run(ctx);
      const result: DoctorCheckResult = {
        id: check.id,
        label: check.label,
        category: check.category,
        status: partial.status,
        detail: partial.detail,
        durationMs: Date.now() - stepStart,
      };
      if (partial.data !== undefined) {
        result.data = partial.data;
      }
      checkResults.push(result);
    } catch (err) {
      checkResults.push({
        id: check.id,
        label: check.label,
        category: check.category,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - stepStart,
      });
    }
  }

  const summary = {
    total: checkResults.length,
    ok: checkResults.filter((r) => r.status === "ok").length,
    warn: checkResults.filter((r) => r.status === "warn").length,
    fail: checkResults.filter((r) => r.status === "fail").length,
    skip: checkResults.filter((r) => r.status === "skip").length,
  };

  const report: DoctorReport = {
    id: buildRunId(startedAt),
    timestamp: new Date(startedAt).toISOString(),
    adapter: ctx.adapter,
    durationMs: Date.now() - startedAt,
    checks: checkResults,
    passed: summary.fail === 0,
    summary,
  };
  if (options.instanceLabel !== undefined) {
    report.instanceLabel = options.instanceLabel;
  }
  return report;
}

// -------- persistence --------

export interface DoctorReportStore {
  saveReport(report: DoctorReport): void;
  listReports(adapter: string, opts?: { limit?: number }): DoctorReport[];
  getReport(adapter: string, id: string): DoctorReport | undefined;
}

/**
 * Filesystem-backed doctor report store. Files live at
 * `<rootDir>/<adapter>/doctor/<id>.json`. Newest first when listing.
 */
export function createDoctorReportStore(rootDir: string): DoctorReportStore {
  const adapterDir = (adapter: string) => join(rootDir, adapter, "doctor");
  const ensureDir = (adapter: string) => {
    const dir = adapterDir(adapter);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  };
  const listFiles = (adapter: string): string[] => {
    const dir = adapterDir(adapter);
    if (!existsSync(dir)) return [];
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => extname(f).toLowerCase() === ".json")
      .sort()
      .reverse();
  };

  return {
    saveReport(report) {
      const dir = ensureDir(report.adapter);
      const filename = `${report.id}.json`;
      writeFileSync(join(dir, filename), JSON.stringify(report, null, 2), {
        encoding: "utf8",
      });
    },

    listReports(adapter, opts = {}) {
      const files = listFiles(adapter);
      const limit = opts.limit ?? files.length;
      const reports: DoctorReport[] = [];
      for (const file of files) {
        if (reports.length >= limit) break;
        try {
          const raw = readFileSync(join(adapterDir(adapter), file), "utf8");
          const parsed = JSON.parse(raw) as DoctorReport;
          if (
            typeof parsed.id === "string" &&
            Array.isArray(parsed.checks)
          ) {
            reports.push(parsed);
          }
        } catch {
          /* skip malformed files */
        }
      }
      return reports;
    },

    getReport(adapter, id) {
      const dir = adapterDir(adapter);
      const filePath = join(dir, `${id}.json`);
      if (!existsSync(filePath)) return undefined;
      try {
        const raw = readFileSync(filePath, "utf8");
        return JSON.parse(raw) as DoctorReport;
      } catch {
        return undefined;
      }
    },
  };
}

// -------- helpers --------

function buildRunId(startedAt: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
  return `doctor-${stamp}-${suffix}`;
}
