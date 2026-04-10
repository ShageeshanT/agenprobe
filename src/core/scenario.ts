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
  | ResponseIsEmptyAssertion;

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
