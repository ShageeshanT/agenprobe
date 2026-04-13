/**
 * In-process scheduler for automated doctor + scenario runs.
 *
 * Each bot instance can declare a doctorInterval and scenarioInterval
 * (e.g. "15m", "1h", "6h"). The scheduler converts these to milliseconds
 * and sets a recurring timer for each. When a timer fires:
 *
 *   1. Run the check suite (doctor or scenarios).
 *   2. Persist the report.
 *   3. If the run has failures AND the instance has a webhookUrl,
 *      POST a compact JSON summary to that URL.
 *
 * The scheduler is started once from the web server's boot sequence and
 * manages its own timer map. Adding / removing / updating an instance's
 * schedule is done by calling reschedule(instance) — the scheduler
 * clears any existing timers for that instance and sets new ones from
 * the current config.
 *
 * Design choices:
 *   - setInterval, not cron. Simple interval strings ("15m") are easier
 *     to explain to non-technical users than "0/15 * * * *". Full cron
 *     can be a Phase 4.5 upgrade if anyone asks.
 *   - Sequential execution per instance. If the previous scheduled run
 *     for an instance hasn't finished when the next tick fires, we skip
 *     the tick rather than queue. This prevents pileup on slow bots.
 *   - Webhook failures are logged and ignored — they don't affect the
 *     run or the report. The user will notice the missing notification
 *     and fix the URL.
 */

export type RunKind = "doctor" | "scenarios";

export interface ScheduledRunResult {
  instance: string;
  runKind: RunKind;
  passed: boolean;
  summary: string;
  timestamp: string;
  durationMs: number;
}

export interface SchedulerCallbacks {
  /** Run the doctor for an instance. Returns { passed, summary }. */
  runDoctor: (instanceName: string) => Promise<{ passed: boolean; summary: string; durationMs: number }>;
  /** Run the full scenario suite for an instance. Returns { passed, summary }. */
  runScenarios: (instanceName: string) => Promise<{ passed: boolean; summary: string; durationMs: number }>;
  /** Called after every scheduled run (for logging). */
  onRunComplete?: (result: ScheduledRunResult) => void;
}

interface InstanceTimers {
  doctor?: ReturnType<typeof setInterval>;
  scenarios?: ReturnType<typeof setInterval>;
  doctorRunning: boolean;
  scenariosRunning: boolean;
}

export class Scheduler {
  private readonly timers = new Map<string, InstanceTimers>();
  private readonly callbacks: SchedulerCallbacks;

  constructor(callbacks: SchedulerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Set up (or replace) the schedule for one instance. Pass the instance
   * name plus its current interval + webhook config. Clears any previous
   * timers for this instance before setting new ones.
   */
  reschedule(opts: {
    instanceName: string;
    doctorInterval?: string;
    scenarioInterval?: string;
    webhookUrl?: string;
  }): void {
    this.clear(opts.instanceName);
    const entry: InstanceTimers = {
      doctorRunning: false,
      scenariosRunning: false,
    };

    const doctorMs = parseDuration(opts.doctorInterval);
    if (doctorMs > 0) {
      console.log(
        `[scheduler] ${opts.instanceName}: doctor every ${opts.doctorInterval} (${doctorMs}ms)`,
      );
      entry.doctor = setInterval(() => {
        this.tick(opts.instanceName, "doctor", opts.webhookUrl, entry);
      }, doctorMs);
      entry.doctor.unref?.();
    }

    const scenarioMs = parseDuration(opts.scenarioInterval);
    if (scenarioMs > 0) {
      console.log(
        `[scheduler] ${opts.instanceName}: scenarios every ${opts.scenarioInterval} (${scenarioMs}ms)`,
      );
      entry.scenarios = setInterval(() => {
        this.tick(opts.instanceName, "scenarios", opts.webhookUrl, entry);
      }, scenarioMs);
      entry.scenarios.unref?.();
    }

    if (doctorMs > 0 || scenarioMs > 0) {
      this.timers.set(opts.instanceName, entry);
    }
  }

  /** Remove all timers for one instance. */
  clear(instanceName: string): void {
    const entry = this.timers.get(instanceName);
    if (!entry) return;
    if (entry.doctor) clearInterval(entry.doctor);
    if (entry.scenarios) clearInterval(entry.scenarios);
    this.timers.delete(instanceName);
  }

  /** Remove all timers for all instances. */
  shutdown(): void {
    for (const [name] of this.timers) {
      this.clear(name);
    }
  }

  /** List actively scheduled instances with their intervals. */
  status(): { instanceName: string; doctor: boolean; scenarios: boolean }[] {
    const out: { instanceName: string; doctor: boolean; scenarios: boolean }[] =
      [];
    for (const [name, entry] of this.timers) {
      out.push({
        instanceName: name,
        doctor: Boolean(entry.doctor),
        scenarios: Boolean(entry.scenarios),
      });
    }
    return out;
  }

  // -------- internals --------

  private async tick(
    instanceName: string,
    kind: RunKind,
    webhookUrl: string | undefined,
    entry: InstanceTimers,
  ): Promise<void> {
    // Guard: skip if the previous run of this kind is still in flight.
    const flagKey = kind === "doctor" ? "doctorRunning" : "scenariosRunning";
    if (entry[flagKey]) {
      console.log(
        `[scheduler] ${instanceName}/${kind}: skipped (previous run still in flight)`,
      );
      return;
    }
    entry[flagKey] = true;

    let result: ScheduledRunResult;
    try {
      const fn =
        kind === "doctor"
          ? this.callbacks.runDoctor
          : this.callbacks.runScenarios;
      const outcome = await fn(instanceName);
      result = {
        instance: instanceName,
        runKind: kind,
        passed: outcome.passed,
        summary: outcome.summary,
        timestamp: new Date().toISOString(),
        durationMs: outcome.durationMs,
      };
    } catch (err) {
      result = {
        instance: instanceName,
        runKind: kind,
        passed: false,
        summary: `scheduler ${kind} crashed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
        durationMs: 0,
      };
    } finally {
      entry[flagKey] = false;
    }

    console.log(
      `[scheduler] ${instanceName}/${kind}: ${result.passed ? "PASS" : "FAIL"} (${result.durationMs}ms)`,
    );
    this.callbacks.onRunComplete?.(result);

    // Fire webhook on failure (non-blocking).
    if (!result.passed && webhookUrl) {
      fireWebhook(webhookUrl, result).catch((err) => {
        console.error(
          `[scheduler] webhook to ${webhookUrl} failed: ${(err as Error).message}`,
        );
      });
    }
  }
}

// -------- webhook --------

async function fireWebhook(
  url: string,
  result: ScheduledRunResult,
): Promise<void> {
  // Detect Slack-style webhooks (they expect { text: "..." }).
  const isSlack =
    url.includes("hooks.slack.com") || url.includes("slack.com/api");
  const isDiscord = url.includes("discord.com/api/webhooks");

  const emoji = result.passed ? "white_check_mark" : "x";
  const plainText =
    `[AgentProbe] ${result.instance} / ${result.runKind}: ${result.passed ? "PASS" : "FAIL"}\n` +
    `${result.summary}\n` +
    `${result.timestamp} · ${result.durationMs}ms`;

  let body: unknown;
  if (isSlack) {
    body = { text: plainText };
  } else if (isDiscord) {
    body = { content: plainText };
  } else {
    // Generic JSON webhook.
    body = {
      event: "agentprobe.scheduled_run",
      ...result,
    };
  }

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

// -------- duration parser --------

/**
 * Parse a simple duration string into milliseconds.
 *
 *   "5m"  → 300000
 *   "15m" → 900000
 *   "1h"  → 3600000
 *   "6h"  → 21600000
 *   "1d"  → 86400000
 *
 * Returns 0 for empty / unparseable values (which the scheduler
 * interprets as "don't schedule").
 */
export function parseDuration(s: string | undefined | null): number {
  if (!s) return 0;
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return 0;
  const m = trimmed.match(/^(\d+)\s*(m|min|h|hr|d|day|s|sec)s?$/);
  if (!m) return 0;
  const n = Number.parseInt(m[1]!, 10);
  if (Number.isNaN(n) || n <= 0) return 0;
  const unit = m[2]!;
  switch (unit) {
    case "s":
    case "sec":
      return n * 1000;
    case "m":
    case "min":
      return n * 60 * 1000;
    case "h":
    case "hr":
      return n * 60 * 60 * 1000;
    case "d":
    case "day":
      return n * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}
