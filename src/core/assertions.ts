import type {
  Assertion,
  AssertionResult,
  AssertionSeverity,
} from "./scenario.js";
import type { BotReply } from "./bot-adapter.js";

/**
 * Evaluate a single assertion against a bot reply.
 *
 * Returns a structured result with enough context for both humans (the
 * message) and programs (actual + passed flag). Never throws — a broken
 * assertion (e.g. invalid regex) resolves to passed=false with an error
 * message, so one bad assertion doesn't take down the whole scenario.
 */
export function evaluateAssertion(
  assertion: Assertion,
  reply: BotReply,
): AssertionResult {
  const severity = assertion.severity ?? "critical";
  const result = (
    passed: boolean,
    message: string,
    actual: unknown,
  ): AssertionResult => ({ assertion, passed, severity, message, actual });

  switch (assertion.type) {
    case "response_contains": {
      const haystack = assertion.caseInsensitive
        ? reply.text.toLowerCase()
        : reply.text;
      const needle = assertion.caseInsensitive
        ? assertion.value.toLowerCase()
        : assertion.value;
      const ok = haystack.includes(needle);
      return result(
        ok,
        ok
          ? `reply contains ${JSON.stringify(assertion.value)}`
          : `reply does not contain ${JSON.stringify(assertion.value)}`,
        reply.text,
      );
    }

    case "response_not_contains": {
      const haystack = assertion.caseInsensitive
        ? reply.text.toLowerCase()
        : reply.text;
      const needle = assertion.caseInsensitive
        ? assertion.value.toLowerCase()
        : assertion.value;
      const ok = !haystack.includes(needle);
      return result(
        ok,
        ok
          ? `reply correctly does not contain ${JSON.stringify(assertion.value)}`
          : `reply unexpectedly contains ${JSON.stringify(assertion.value)}`,
        reply.text,
      );
    }

    case "response_matches": {
      let re: RegExp;
      try {
        re = new RegExp(assertion.pattern, assertion.flags ?? "");
      } catch (err) {
        return result(
          false,
          `invalid regex ${JSON.stringify(assertion.pattern)}: ${(err as Error).message}`,
          reply.text,
        );
      }
      const ok = re.test(reply.text);
      return result(
        ok,
        ok
          ? `reply matches /${assertion.pattern}/${assertion.flags ?? ""}`
          : `reply does not match /${assertion.pattern}/${assertion.flags ?? ""}`,
        reply.text,
      );
    }

    case "response_time_under": {
      const ok = reply.responseTimeMs < assertion.valueMs;
      return result(
        ok,
        ok
          ? `replied in ${reply.responseTimeMs}ms (< ${assertion.valueMs}ms)`
          : `replied in ${reply.responseTimeMs}ms (>= ${assertion.valueMs}ms)`,
        reply.responseTimeMs,
      );
    }

    case "response_time_over": {
      const ok = reply.responseTimeMs > assertion.valueMs;
      return result(
        ok,
        ok
          ? `replied in ${reply.responseTimeMs}ms (> ${assertion.valueMs}ms)`
          : `replied in ${reply.responseTimeMs}ms (<= ${assertion.valueMs}ms)`,
        reply.responseTimeMs,
      );
    }

    case "response_is_non_empty": {
      const ok = reply.text.trim().length > 0;
      return result(
        ok,
        ok ? "reply is non-empty" : "reply is empty",
        reply.text,
      );
    }

    case "response_is_empty": {
      const ok = reply.text.trim().length === 0;
      return result(
        ok,
        ok ? "reply is empty (as expected)" : "reply is non-empty",
        reply.text,
      );
    }

    default: {
      // Exhaustiveness check — if a new assertion type is added to the
      // discriminated union but not handled here, TS flags it.
      const _exhaustive: never = assertion;
      void _exhaustive;
      return {
        assertion,
        passed: false,
        severity: "critical",
        message: `unknown assertion type`,
        actual: null,
      };
    }
  }
}

/**
 * Roll up a list of assertion results into a pass/fail verdict.
 * Only critical failures count against "passed"; warnings are reported
 * separately.
 */
export function summarizeAssertions(results: AssertionResult[]): {
  passed: boolean;
  critical: number;
  warnings: number;
} {
  let critical = 0;
  let warnings = 0;
  for (const r of results) {
    if (r.passed) continue;
    if (r.severity === "critical") critical++;
    else if (r.severity === "warning") warnings++;
  }
  return { passed: critical === 0, critical, warnings };
}
