import { randomUUID } from "node:crypto";

import type { BotAdapter } from "./bot-adapter.js";
import {
  evaluateAgentDBAssertion,
  evaluateAssertion,
  skipAgentDBAssertion,
  summarizeAssertions,
} from "./assertions.js";
import type {
  AgentDBQueryAssertion,
  AssertionResult,
  Scenario,
  ScenarioResult,
  StepResult,
} from "./scenario.js";

/**
 * Platform-specific async assertion handlers. The runner calls these
 * when it encounters an assertion that needs side-effects (e.g. an
 * `agentdb_query` that has to SSH into the container).
 *
 * When a handler is missing for an assertion type that requires one,
 * the assertion is marked as `info: skipped` so multi-platform suites
 * don't fail just because one adapter lacks the feature.
 */
export interface PlatformHandlers {
  /**
   * Given an `agentdb_query` assertion, run the SQL and return
   * { rows, rowCount } — or { error } on failure. The pure assertion
   * evaluator in assertions.ts turns that into an AssertionResult.
   */
  queryAgentDB?: (assertion: AgentDBQueryAssertion) => Promise<
    { rows: Record<string, unknown>[]; rowCount: number } | { error: string }
  >;
}

export interface RunScenarioOptions {
  /** Called after each step finishes (for UI progress streaming). */
  onStepComplete?: (step: StepResult) => void;
  /** Platform-specific handlers for assertions that need side effects. */
  platformHandlers?: PlatformHandlers;
}

/**
 * Execute a scenario against a connected bot adapter.
 *
 * Does not manage adapter lifecycle — callers are responsible for calling
 * adapter.connect() before and adapter.disconnect() after. This keeps the
 * runner reusable for "run many scenarios in one adapter session" as well
 * as one-shot CLI runs.
 */
export async function runScenario(
  adapter: BotAdapter,
  scenario: Scenario,
  opts: RunScenarioOptions = {},
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const stepResults: StepResult[] = [];
  let criticalFailures = 0;
  let warningFailures = 0;
  let fatalError: string | undefined;

  // Shared session key so the bot has continuity across steps. Per-step
  // scenarios get a fresh key for each step.
  const sharedSessionKey =
    scenario.session === "per-step" ? undefined : `agentprobe-${randomUUID()}`;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    const stepName = step.name ?? `Step ${i + 1}`;
    const sessionKey =
      sharedSessionKey ?? `agentprobe-${randomUUID()}`;
    const timeoutMs =
      step.timeoutMs ?? scenario.defaultTimeoutMs ?? 60_000;

    let stepResult: StepResult;

    try {
      const reply = await adapter.sendMessage({
        text: step.send,
        sessionKey,
        timeoutMs,
      });

      // Evaluate assertions one at a time. Sync response-based ones go
      // through evaluateAssertion; async platform-specific ones (currently
      // just agentdb_query) get dispatched to the matching handler in
      // opts.platformHandlers. Missing handlers produce a "skipped" info
      // result so cross-platform suites don't break.
      const assertionResults: AssertionResult[] = [];
      for (const a of step.assertions) {
        if (a.type === "agentdb_query") {
          if (opts.platformHandlers?.queryAgentDB) {
            try {
              const queryResult = await opts.platformHandlers.queryAgentDB(a);
              assertionResults.push(evaluateAgentDBAssertion(a, queryResult));
            } catch (err) {
              assertionResults.push(
                evaluateAgentDBAssertion(a, {
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          } else {
            assertionResults.push(
              skipAgentDBAssertion(
                a,
                "adapter does not support AgentDB queries",
              ),
            );
          }
        } else {
          assertionResults.push(evaluateAssertion(a, reply));
        }
      }
      const summary = summarizeAssertions(assertionResults);
      criticalFailures += summary.critical;
      warningFailures += summary.warnings;

      stepResult = {
        stepIndex: i,
        name: stepName,
        send: step.send,
        reply: reply.text,
        replyTimeMs: reply.responseTimeMs,
        eventCount: reply.events.length,
        assertions: assertionResults,
        passed: summary.passed,
        error: undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      criticalFailures += 1;
      stepResult = {
        stepIndex: i,
        name: stepName,
        send: step.send,
        reply: "",
        replyTimeMs: 0,
        eventCount: 0,
        assertions: [],
        passed: false,
        error: message,
      };
      // A transport/protocol failure mid-scenario typically means the
      // remaining steps can't run either. Record the fatal error on the
      // scenario result and stop the loop.
      fatalError = message;
    }

    stepResults.push(stepResult);
    opts.onStepComplete?.(stepResult);

    if (fatalError) break;
  }

  return {
    scenario: scenario.name,
    description: scenario.description,
    startedAt,
    durationMs: Date.now() - startedAt,
    steps: stepResults,
    passed: criticalFailures === 0 && fatalError === undefined,
    criticalFailures,
    warningFailures,
    error: fatalError,
  };
}
