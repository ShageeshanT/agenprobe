/**
 * Scenario + assertion types.
 *
 * A Scenario is a sequence of steps. Each step sends one message to the bot
 * and asserts on the reply. Steps within a single scenario share a session
 * key by default, so the bot has continuity across the conversation.
 *
 * Assertion severities:
 *   - critical: a failure fails the whole scenario and sets exit code 1.
 *   - warning:  logged but does not fail the run.
 *   - info:     always reported as info, never affects pass/fail.
 */
export interface Scenario {
  /** Short identifier, used in reports. */
  name: string;

  /** Human-readable description of what this scenario tests. */
  description?: string;

  /** Default per-step timeout in ms. Steps may override. */
  defaultTimeoutMs?: number;

  /**
   * Session continuity. "shared" (default) means all steps use one session
   * key so the bot remembers context. "per-step" means each step gets a
   * fresh session — useful for probing stateless behaviour.
   */
  session?: "shared" | "per-step";

  /** Ordered steps to run. */
  steps: ScenarioStep[];
}

export interface ScenarioStep {
  /** Optional step label. Defaults to "Step N" if omitted. */
  name?: string;

  /** The user message to send. */
  send: string;

  /** Override the scenario's default timeout for this step. */
  timeoutMs?: number;

  /** Assertions to run against the reply. */
  assertions: Assertion[];
}

/**
 * Discriminated union of assertion shapes.
 *
 * Each variant carries exactly the fields it needs — kept flat to make
 * YAML authoring simple:
 *
 *   - type: response_contains
 *     value: "hello"
 *     caseInsensitive: true
 *     severity: critical
 */
export type Assertion =
  | ResponseContainsAssertion
  | ResponseNotContainsAssertion
  | ResponseMatchesAssertion
  | ResponseTimeUnderAssertion
  | ResponseTimeOverAssertion
  | ResponseIsNonEmptyAssertion
  | ResponseIsEmptyAssertion
  | AgentDBQueryAssertion
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ToolCallCountAssertion
  | ToolParamsContainAssertion;

export type AssertionSeverity = "critical" | "warning" | "info";

export interface AssertionBase {
  severity?: AssertionSeverity;
  /** Optional human description, shown in reports. */
  description?: string;
}

export interface ResponseContainsAssertion extends AssertionBase {
  type: "response_contains";
  value: string;
  caseInsensitive?: boolean;
}

export interface ResponseNotContainsAssertion extends AssertionBase {
  type: "response_not_contains";
  value: string;
  caseInsensitive?: boolean;
}

export interface ResponseMatchesAssertion extends AssertionBase {
  type: "response_matches";
  pattern: string;
  flags?: string;
}

export interface ResponseTimeUnderAssertion extends AssertionBase {
  type: "response_time_under";
  valueMs: number;
}

export interface ResponseTimeOverAssertion extends AssertionBase {
  type: "response_time_over";
  valueMs: number;
}

export interface ResponseIsNonEmptyAssertion extends AssertionBase {
  type: "response_is_non_empty";
}

export interface ResponseIsEmptyAssertion extends AssertionBase {
  type: "response_is_empty";
}

/**
 * Assert on OpenClaw AgentDB state after a scenario step runs.
 *
 * Only meaningful when the scenario runs against an OpenClaw adapter
 * connected via `railway ssh`. For other adapters (Hermes, future n8n,
 * etc.) this assertion is automatically marked "skipped" with an
 * explanatory message rather than failing the scenario.
 *
 * Example (all contacts with phone starting "+1555"):
 *
 *   - type: agentdb_query
 *     sql: "SELECT * FROM contacts WHERE primary_phone LIKE ?"
 *     params: ["+1555%"]
 *     expectMinRows: 1
 *     severity: critical
 *
 * Example (check a specific field on a specific row):
 *
 *   - type: agentdb_query
 *     sql: "SELECT name FROM contacts WHERE primary_phone = ?"
 *     params: ["+94766130939"]
 *     expectRowCount: 1
 *     expectFirstRow:
 *       name: "Shagee"
 *     severity: critical
 */
export interface AgentDBQueryAssertion extends AssertionBase {
  type: "agentdb_query";
  /** SQL SELECT / PRAGMA statement. Runs inside the container, read-only. */
  sql: string;
  /** Positional parameters bound to `?` placeholders in the SQL. */
  params?: (string | number | boolean | null)[];
  /** Require exactly this many rows. */
  expectRowCount?: number;
  /** Require at least this many rows. */
  expectMinRows?: number;
  /** Require at most this many rows. */
  expectMaxRows?: number;
  /**
   * Require each listed field on the FIRST row to equal the given value.
   * Loose equality (string/number coercion). Ignored when the query
   * returned zero rows.
   */
  expectFirstRow?: Record<string, string | number | boolean | null>;
}

/**
 * Assert that the bot invoked a specific tool at least once during the
 * current step. Matches on the tool NAME (OpenClaw's `agent`-stream
 * `tool` events carry `data.name`). Case-sensitive by default.
 */
export interface ToolCalledAssertion extends AssertionBase {
  type: "tool_called";
  /** Tool name to match on. e.g. "db_query", "web_search". */
  tool: string;
}

/**
 * Inverse of ToolCalledAssertion. Asserts the bot DID NOT call a tool
 * with this name. Useful for refusal tests — "when asked X, don't
 * invoke tool Y" — and for hallucination guards.
 */
export interface ToolNotCalledAssertion extends AssertionBase {
  type: "tool_not_called";
  tool: string;
}

/**
 * Assert a bound on how many times a specific tool was called. Helps
 * catch tool-call loops (where the bot gets stuck calling the same tool
 * 10+ times without converging) and under-use (where the bot should
 * have called a tool but hallucinated instead).
 */
export interface ToolCallCountAssertion extends AssertionBase {
  type: "tool_call_count";
  /** Tool name. Omit to count total tool calls regardless of name. */
  tool?: string;
  /** Require exactly this many calls. */
  expectCount?: number;
  /** Require at least this many calls. */
  expectMin?: number;
  /** Require at most this many calls. */
  expectMax?: number;
}

/**
 * Assert that at least one invocation of a tool was called with args
 * whose JSON-stringified form contains a specific substring. Rough but
 * effective for "was the query parameterised correctly" / "did the
 * email recipient field get the right address" checks.
 */
export interface ToolParamsContainAssertion extends AssertionBase {
  type: "tool_params_contain";
  tool: string;
  value: string;
  caseInsensitive?: boolean;
}

// -------- Results --------

export interface ScenarioResult {
  scenario: string;
  description: string | undefined;
  startedAt: number;
  durationMs: number;
  steps: StepResult[];
  passed: boolean;
  criticalFailures: number;
  warningFailures: number;
  error: string | undefined;
}

export interface StepResult {
  stepIndex: number;
  name: string;
  send: string;
  reply: string;
  replyTimeMs: number;
  eventCount: number;
  assertions: AssertionResult[];
  passed: boolean;
  error: string | undefined;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  severity: AssertionSeverity;
  message: string;
  actual: unknown;
}
