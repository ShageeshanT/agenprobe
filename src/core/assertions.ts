import type {
  AgentDBQueryAssertion,
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

    case "agentdb_query": {
      // AgentDB assertions need async database access and are handled by
      // the scenario runner via a platform-specific hook. If one ever
      // lands in the sync evaluator it's a routing bug — return a
      // failure that names the problem rather than pretending it passed.
      return result(
        false,
        "agentdb_query must be evaluated asynchronously (missing platform handler)",
        null,
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
 * Evaluate an `agentdb_query` assertion given an already-fetched query
 * result. Callers (the scenario runner) run the actual SQL via the
 * platform-specific handler and feed the rows into this pure function,
 * so this module stays free of transport dependencies.
 */
export function evaluateAgentDBAssertion(
  assertion: AgentDBQueryAssertion,
  queryResult: {
    rows: Record<string, unknown>[];
    rowCount: number;
  } | { error: string },
): AssertionResult {
  const severity = assertion.severity ?? "critical";

  if ("error" in queryResult) {
    return {
      assertion,
      passed: false,
      severity,
      message: `agentdb query failed: ${queryResult.error}`,
      actual: null,
    };
  }

  const { rows, rowCount } = queryResult;

  if (assertion.expectRowCount !== undefined) {
    if (rowCount !== assertion.expectRowCount) {
      return {
        assertion,
        passed: false,
        severity,
        message: `expected exactly ${assertion.expectRowCount} row(s), got ${rowCount}`,
        actual: rowCount,
      };
    }
  }
  if (assertion.expectMinRows !== undefined) {
    if (rowCount < assertion.expectMinRows) {
      return {
        assertion,
        passed: false,
        severity,
        message: `expected at least ${assertion.expectMinRows} row(s), got ${rowCount}`,
        actual: rowCount,
      };
    }
  }
  if (assertion.expectMaxRows !== undefined) {
    if (rowCount > assertion.expectMaxRows) {
      return {
        assertion,
        passed: false,
        severity,
        message: `expected at most ${assertion.expectMaxRows} row(s), got ${rowCount}`,
        actual: rowCount,
      };
    }
  }

  if (assertion.expectFirstRow !== undefined) {
    if (rowCount === 0) {
      return {
        assertion,
        passed: false,
        severity,
        message: `expectFirstRow set but query returned 0 rows`,
        actual: null,
      };
    }
    const first = rows[0]!;
    for (const [key, expected] of Object.entries(assertion.expectFirstRow)) {
      const actualValue = first[key];
      // Loose comparison — SQLite number/string coercion is lenient and
      // YAML parsing sometimes hands us strings where SQL returns ints.
      if (String(actualValue) !== String(expected)) {
        return {
          assertion,
          passed: false,
          severity,
          message: `first row column "${key}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(actualValue)}`,
          actual: actualValue,
        };
      }
    }
  }

  const parts: string[] = [];
  parts.push(`${rowCount} row(s)`);
  if (assertion.expectRowCount !== undefined) parts.push(`== ${assertion.expectRowCount}`);
  if (assertion.expectMinRows !== undefined) parts.push(`>= ${assertion.expectMinRows}`);
  if (assertion.expectMaxRows !== undefined) parts.push(`<= ${assertion.expectMaxRows}`);
  if (assertion.expectFirstRow !== undefined) parts.push(`first row matched`);

  return {
    assertion,
    passed: true,
    severity,
    message: parts.join(", "),
    actual: rowCount,
  };
}

/**
 * Build a skipped-assertion result for platforms that don't support
 * AgentDB. Marked as info severity so it's visible in reports but
 * doesn't affect pass/fail.
 */
export function skipAgentDBAssertion(
  assertion: AgentDBQueryAssertion,
  reason: string,
): AssertionResult {
  return {
    assertion,
    passed: true,
    severity: "info",
    message: `skipped: ${reason}`,
    actual: null,
  };
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
