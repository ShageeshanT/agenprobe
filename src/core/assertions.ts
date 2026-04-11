import type {
  AgentDBQueryAssertion,
  Assertion,
  AssertionResult,
  AssertionSeverity,
  ToolCallCountAssertion,
  ToolCalledAssertion,
  ToolNotCalledAssertion,
  ToolParamsContainAssertion,
} from "./scenario.js";
import type { BotEvent, BotReply } from "./bot-adapter.js";

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

    case "tool_called": {
      const calls = collectToolCalls(reply.events);
      const matching = calls.filter((c) => c.name === assertion.tool);
      const ok = matching.length > 0;
      return result(
        ok,
        ok
          ? `tool "${assertion.tool}" called ${matching.length} time(s)`
          : `tool "${assertion.tool}" was not called (observed: ${summarizeCalls(calls)})`,
        matching.length,
      );
    }

    case "tool_not_called": {
      const calls = collectToolCalls(reply.events);
      const matching = calls.filter((c) => c.name === assertion.tool);
      const ok = matching.length === 0;
      return result(
        ok,
        ok
          ? `tool "${assertion.tool}" correctly not called`
          : `tool "${assertion.tool}" was unexpectedly called ${matching.length} time(s)`,
        matching.length,
      );
    }

    case "tool_call_count": {
      const calls = collectToolCalls(reply.events);
      const filtered = assertion.tool
        ? calls.filter((c) => c.name === assertion.tool)
        : calls;
      const count = filtered.length;
      const toolLabel = assertion.tool ?? "(any)";
      if (assertion.expectCount !== undefined && count !== assertion.expectCount) {
        return result(
          false,
          `tool "${toolLabel}" called ${count} time(s), expected exactly ${assertion.expectCount}`,
          count,
        );
      }
      if (assertion.expectMin !== undefined && count < assertion.expectMin) {
        return result(
          false,
          `tool "${toolLabel}" called ${count} time(s), expected at least ${assertion.expectMin}`,
          count,
        );
      }
      if (assertion.expectMax !== undefined && count > assertion.expectMax) {
        return result(
          false,
          `tool "${toolLabel}" called ${count} time(s), expected at most ${assertion.expectMax}`,
          count,
        );
      }
      return result(
        true,
        `tool "${toolLabel}" called ${count} time(s) (within bounds)`,
        count,
      );
    }

    case "tool_params_contain": {
      const calls = collectToolCalls(reply.events).filter(
        (c) => c.name === assertion.tool,
      );
      if (calls.length === 0) {
        return result(
          false,
          `tool "${assertion.tool}" was not called, so params cannot contain anything`,
          null,
        );
      }
      const needle = assertion.caseInsensitive
        ? assertion.value.toLowerCase()
        : assertion.value;
      const hit = calls.some((c) => {
        const haystack = assertion.caseInsensitive
          ? c.argsText.toLowerCase()
          : c.argsText;
        return haystack.includes(needle);
      });
      return result(
        hit,
        hit
          ? `at least one "${assertion.tool}" call had args containing ${JSON.stringify(assertion.value)}`
          : `no "${assertion.tool}" invocation had args containing ${JSON.stringify(assertion.value)} (${calls.length} call(s) inspected)`,
        calls.map((c) => c.argsText.slice(0, 120)),
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

// -------- tool-call event inspection --------

interface ObservedToolCall {
  name: string;
  argsText: string; // JSON.stringified for substring matching
  /** ms offset from the start of the request. */
  offsetMs: number;
}

/**
 * Pull the list of tool-call invocations out of a BotReply's event
 * stream. OpenClaw emits `agent` events with `stream: "tool"` and a
 * `data.phase` of "start" (at invocation time, with args) or "result"
 * (on return, with isError). We count one observed tool call per
 * "start" event — the matching "result" event can be ignored here
 * since we only need to know what the bot TRIED to call, not whether
 * it succeeded (the reply text / downstream assertions cover that).
 */
function collectToolCalls(events: BotEvent[]): ObservedToolCall[] {
  const out: ObservedToolCall[] = [];
  for (const ev of events) {
    if (ev.type !== "agent") continue;
    const payload = ev.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") continue;
    if (payload.stream !== "tool") continue;
    const data = payload.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== "object") continue;
    if (data.phase !== "start") continue;
    const name = typeof data.name === "string" ? data.name : "";
    if (!name) continue;
    const argsText = data.args !== undefined ? JSON.stringify(data.args) : "";
    out.push({ name, argsText, offsetMs: ev.offsetMs });
  }
  return out;
}

function summarizeCalls(calls: ObservedToolCall[]): string {
  if (calls.length === 0) return "no tool calls observed";
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const parts = Array.from(counts.entries()).map(
    ([name, n]) => `${name}×${n}`,
  );
  return parts.join(", ");
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
