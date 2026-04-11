/**
 * Scenario run history persistence.
 *
 * Every time a scenario (or a whole suite) finishes, we write one JSON file
 * to `reports/<adapter>/<id>.json`. The file holds the full ScenarioResult[]
 * plus a summary header so listing is cheap: we only parse each file once
 * on first read and the records are small.
 *
 * Design notes:
 *   - No index file. `listRuns` reads the directory and parses each JSON.
 *     For the expected scale (tens to hundreds of runs per install) this is
 *     plenty fast and avoids index corruption issues.
 *   - Each run is independent — nothing in here is append-only or needs
 *     locking. Two concurrent writes end up as two distinct files.
 *   - File name starts with an ISO-ish timestamp so lexicographic sort =
 *     chronological sort. `listRuns` returns newest first.
 *   - Adapter is part of the directory structure, not just a field, so a
 *     single store can hold runs from OpenClaw and Hermes without mixing
 *     them in list queries.
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
import { basename, extname, join } from "node:path";

import type { ScenarioResult, StepResult } from "./scenario.js";

export type RunTrigger = "cli" | "web-single" | "web-suite";
export type RunScope = "single" | "suite";

export interface RunSummary {
  id: string;
  timestamp: string; // ISO 8601
  adapter: string;
  trigger: RunTrigger;
  scope: RunScope;
  /** Scenario name for single runs; "suite" for multi-scenario runs. */
  label: string;
  durationMs: number;
  /** Number of scenarios executed in this run. */
  totalScenarios: number;
  passedScenarios: number;
  warnedScenarios: number;
  failedScenarios: number;
  criticalFailures: number;
  warningFailures: number;
}

export interface RunRecord extends RunSummary {
  results: ScenarioResult[];
}

export interface AggregateStats {
  adapter: string;
  totalRuns: number;
  totalScenarios: number;
  passedScenarios: number;
  warnedScenarios: number;
  failedScenarios: number;
  passRatePct: number;
  avgRunDurationMs: number;
  avgStepLatencyMs: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  flakiest: {
    scenarioName: string;
    runs: number;
    passes: number;
    fails: number;
    passRatePct: number;
  }[];
}

export interface SaveRunParams {
  adapter: string;
  trigger: RunTrigger;
  scope: RunScope;
  label: string;
  startedAt: number;
  durationMs: number;
  results: ScenarioResult[];
}

export interface ReportStore {
  saveRun(params: SaveRunParams): RunRecord;
  listRuns(adapter: string, opts?: { limit?: number }): RunSummary[];
  getRun(adapter: string, id: string): RunRecord | undefined;
  computeAggregate(adapter: string): AggregateStats;
}

/**
 * Filesystem-backed store under a given root directory. The root itself is
 * created lazily on first save so callers don't need to mkdir beforehand.
 */
export function createReportStore(rootDir: string): ReportStore {
  const ensureDir = (adapter: string): string => {
    const dir = join(rootDir, adapter);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  };

  const listAdapterDir = (adapter: string): string[] => {
    const dir = join(rootDir, adapter);
    if (!existsSync(dir)) return [];
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => extname(f).toLowerCase() === ".json")
      .sort()
      .reverse();
  };

  const readRecord = (adapter: string, file: string): RunRecord | undefined => {
    const full = join(rootDir, adapter, file);
    try {
      const raw = readFileSync(full, "utf8");
      const parsed = JSON.parse(raw);
      if (isRunRecord(parsed)) return parsed;
    } catch {
      /* ignore malformed or partial files */
    }
    return undefined;
  };

  return {
    saveRun(params) {
      const id = buildRunId(params.startedAt);
      const summary = summarizeResults(params.results);
      const record: RunRecord = {
        id,
        timestamp: new Date(params.startedAt).toISOString(),
        adapter: params.adapter,
        trigger: params.trigger,
        scope: params.scope,
        label: params.label,
        durationMs: params.durationMs,
        totalScenarios: summary.totalScenarios,
        passedScenarios: summary.passedScenarios,
        warnedScenarios: summary.warnedScenarios,
        failedScenarios: summary.failedScenarios,
        criticalFailures: summary.criticalFailures,
        warningFailures: summary.warningFailures,
        results: params.results,
      };

      const dir = ensureDir(params.adapter);
      const filename = `${id}-${sanitizeLabel(params.label)}.json`;
      writeFileSync(join(dir, filename), JSON.stringify(record, null, 2), {
        encoding: "utf8",
      });
      return record;
    },

    listRuns(adapter, opts = {}) {
      const files = listAdapterDir(adapter);
      const limit = opts.limit ?? files.length;
      const summaries: RunSummary[] = [];
      for (const file of files) {
        if (summaries.length >= limit) break;
        const rec = readRecord(adapter, file);
        if (!rec) continue;
        const { results, ...summary } = rec;
        void results;
        summaries.push(summary);
      }
      return summaries;
    },

    getRun(adapter, id) {
      // Filename is `<id>-<sanitized-label>.json`. Scan the directory for a
      // file that starts with the id.
      const files = listAdapterDir(adapter);
      const match = files.find((f) => f.startsWith(id + "-") || f.startsWith(id + "."));
      if (!match) return undefined;
      return readRecord(adapter, match);
    },

    computeAggregate(adapter) {
      const files = listAdapterDir(adapter);
      const base: AggregateStats = {
        adapter,
        totalRuns: 0,
        totalScenarios: 0,
        passedScenarios: 0,
        warnedScenarios: 0,
        failedScenarios: 0,
        passRatePct: 0,
        avgRunDurationMs: 0,
        avgStepLatencyMs: 0,
        firstRunAt: null,
        lastRunAt: null,
        flakiest: [],
      };
      if (files.length === 0) return base;

      let runDurationSum = 0;
      let stepLatencySum = 0;
      let stepCount = 0;
      let firstTs: string | null = null;
      let lastTs: string | null = null;
      const perScenario = new Map<
        string,
        { runs: number; passes: number; fails: number }
      >();

      for (const file of files) {
        const rec = readRecord(adapter, file);
        if (!rec) continue;
        base.totalRuns += 1;
        base.totalScenarios += rec.totalScenarios;
        base.passedScenarios += rec.passedScenarios;
        base.warnedScenarios += rec.warnedScenarios;
        base.failedScenarios += rec.failedScenarios;
        runDurationSum += rec.durationMs;

        if (!lastTs || rec.timestamp > lastTs) lastTs = rec.timestamp;
        if (!firstTs || rec.timestamp < firstTs) firstTs = rec.timestamp;

        for (const scenarioResult of rec.results) {
          const slot =
            perScenario.get(scenarioResult.scenario) ??
            { runs: 0, passes: 0, fails: 0 };
          slot.runs += 1;
          if (scenarioResult.passed) slot.passes += 1;
          else slot.fails += 1;
          perScenario.set(scenarioResult.scenario, slot);

          for (const step of scenarioResult.steps) {
            if (step.replyTimeMs > 0) {
              stepLatencySum += step.replyTimeMs;
              stepCount += 1;
            }
          }
        }
      }

      base.passRatePct =
        base.totalScenarios === 0
          ? 0
          : Math.round((base.passedScenarios / base.totalScenarios) * 1000) / 10;
      base.avgRunDurationMs =
        base.totalRuns === 0 ? 0 : Math.round(runDurationSum / base.totalRuns);
      base.avgStepLatencyMs =
        stepCount === 0 ? 0 : Math.round(stepLatencySum / stepCount);
      base.firstRunAt = firstTs;
      base.lastRunAt = lastTs;

      // "Flakiest" = scenarios that have failed at least once but not
      // always, ranked by lowest pass-rate first.
      const ranked = Array.from(perScenario.entries())
        .filter(([, s]) => s.fails > 0 && s.runs >= 2)
        .map(([name, s]) => ({
          scenarioName: name,
          runs: s.runs,
          passes: s.passes,
          fails: s.fails,
          passRatePct: Math.round((s.passes / s.runs) * 1000) / 10,
        }))
        .sort((a, b) => a.passRatePct - b.passRatePct)
        .slice(0, 5);
      base.flakiest = ranked;

      return base;
    },
  };
}

// -------- helpers --------

function buildRunId(startedAt: number): string {
  // YYYYMMDD-HHMMSS-random6 — lexicographic = chronological.
  const d = new Date(startedAt);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
  return `${stamp}-${suffix}`;
}

function sanitizeLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "run"
  );
}

function summarizeResults(results: ScenarioResult[]): {
  totalScenarios: number;
  passedScenarios: number;
  warnedScenarios: number;
  failedScenarios: number;
  criticalFailures: number;
  warningFailures: number;
} {
  let passed = 0;
  let warned = 0;
  let failed = 0;
  let critical = 0;
  let warnings = 0;
  for (const r of results) {
    critical += r.criticalFailures;
    warnings += r.warningFailures;
    if (!r.passed) failed += 1;
    else if (r.warningFailures > 0) warned += 1;
    else passed += 1;
  }
  return {
    totalScenarios: results.length,
    passedScenarios: passed,
    warnedScenarios: warned,
    failedScenarios: failed,
    criticalFailures: critical,
    warningFailures: warnings,
  };
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.adapter === "string" &&
    Array.isArray(v.results)
  );
}

// StepResult is referenced in the aggregate logic; re-exporting so
// downstream callers (e.g. the web UI contract file) can type-import without
// fishing in scenario.ts.
export type { StepResult };
