/**
 * Doctor — infrastructure-level health checks for an agent platform.
 *
 * Where scenarios test BEHAVIOUR ("does the bot reply correctly to X"),
 * doctor checks test STATE ("is the gateway up, is AgentDB present, are
 * the channels actually running, are there crashes in the logs"). Doctor
 * runs first; if doctor fails, scenarios are typically meaningless.
 *
 * Each platform contributes its own list of `DoctorCheck` objects via the
 * adapters/ directory (e.g. `openclaw-doctor.ts`). The runner here is
 * platform-agnostic — it just executes a list of checks against a context
 * and produces a structured report.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type CheckCategory =
  | "gateway"
  | "agentdb"
  | "channels"
  | "plugins"
  | "cron"
  | "logs"
  | "system"
  | "composio";

/**
 * Result of running a single check. The runner fills in id/label/category/
 * durationMs from the DoctorCheck definition; the check function only
 * needs to return status + detail (and optionally extra structured data).
 */
export interface DoctorCheckResult {
  id: string;
  label: string;
  category: CheckCategory;
  status: CheckStatus;
  detail: string;
  durationMs: number;
  /**
   * Optional structured payload the dashboard can render. Examples:
   *   - { count: 13 } for a count check
   *   - { tables: [...] } for an AgentDB schema check
   *   - { channels: { whatsapp: {...}, telegram: {...} } } for channels
   */
  data?: Record<string, unknown>;
}

/**
 * The full doctor run output. Persisted to disk and shown in the UI.
 */
export interface DoctorReport {
  /** Run id, lexicographically sortable as a timestamp. */
  id: string;
  /** ISO 8601 string of when the run started. */
  timestamp: string;
  /** Adapter the doctor ran against. Currently always "openclaw" but
   * present for forward-compat with multi-platform doctors. */
  adapter: string;
  /** Optional human-readable instance label (used by Phase 3 multi-bot). */
  instanceLabel?: string;
  /** Wall-clock duration of the whole run. */
  durationMs: number;
  /** Per-check results in declaration order. */
  checks: DoctorCheckResult[];
  /** Overall verdict: true iff no `fail`. Warnings do not flip this. */
  passed: boolean;
  /** Tally for fast UI rendering. */
  summary: {
    total: number;
    ok: number;
    warn: number;
    fail: number;
    skip: number;
  };
}
