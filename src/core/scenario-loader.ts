import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { Assertion, Scenario, ScenarioStep } from "./scenario.js";

export class ScenarioLoadError extends Error {
  constructor(message: string, public readonly filePath: string) {
    super(`${basename(filePath)}: ${message}`);
    this.name = "ScenarioLoadError";
  }
}

/**
 * Load and validate a single scenario from a YAML file.
 *
 * Validation is minimal on purpose: enough to catch obvious shape errors
 * (wrong types, missing required fields, unknown assertion types) with
 * actionable messages. We do not build a full JSON schema here — if a
 * scenario file is malformed the error message should be good enough that
 * the user can fix it in their editor.
 */
export function loadScenario(filePath: string): Scenario {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ScenarioLoadError(
      `invalid YAML: ${(err as Error).message}`,
      filePath,
    );
  }

  if (!isObject(parsed)) {
    throw new ScenarioLoadError("root must be an object", filePath);
  }

  const name = parsed.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new ScenarioLoadError("missing or empty 'name'", filePath);
  }

  const description =
    typeof parsed.description === "string" ? parsed.description : undefined;

  const defaultTimeoutMs =
    typeof parsed.defaultTimeoutMs === "number"
      ? parsed.defaultTimeoutMs
      : undefined;

  const session =
    parsed.session === "shared" || parsed.session === "per-step"
      ? parsed.session
      : undefined;

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new ScenarioLoadError("'steps' must be a non-empty array", filePath);
  }

  const steps: ScenarioStep[] = parsed.steps.map((rawStep, i) => {
    const stepLabel = `step[${i}]`;
    if (!isObject(rawStep)) {
      throw new ScenarioLoadError(`${stepLabel} must be an object`, filePath);
    }
    const send = rawStep.send;
    if (typeof send !== "string" || send.length === 0) {
      throw new ScenarioLoadError(
        `${stepLabel}.send must be a non-empty string`,
        filePath,
      );
    }
    const stepName =
      typeof rawStep.name === "string" ? rawStep.name : undefined;
    const timeoutMs =
      typeof rawStep.timeoutMs === "number" ? rawStep.timeoutMs : undefined;

    const rawAssertions = rawStep.assertions;
    if (!Array.isArray(rawAssertions)) {
      throw new ScenarioLoadError(
        `${stepLabel}.assertions must be an array`,
        filePath,
      );
    }
    const assertions = rawAssertions.map((rawA, j) =>
      parseAssertion(rawA, `${stepLabel}.assertions[${j}]`, filePath),
    );

    const step: ScenarioStep = { send, assertions };
    if (stepName !== undefined) step.name = stepName;
    if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
    return step;
  });

  const scenario: Scenario = { name, steps };
  if (description !== undefined) scenario.description = description;
  if (defaultTimeoutMs !== undefined)
    scenario.defaultTimeoutMs = defaultTimeoutMs;
  if (session !== undefined) scenario.session = session;
  return scenario;
}

/**
 * Load every *.yaml / *.yml scenario in a directory. Files are returned in
 * filename order, which is usually what users want when running a suite.
 *
 * Does NOT recurse — only loads YAMLs in the given directory. For the
 * multi-platform layout (scenarios/common + scenarios/<adapter>) use
 * loadScenariosForAdapter instead.
 */
export function loadScenariosFromDir(dir: string): Scenario[] {
  const entries = readdirSync(dir).sort();
  const scenarios: Scenario[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    const ext = extname(entry).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") continue;
    scenarios.push(loadScenario(full));
  }
  return scenarios;
}

/**
 * Multi-platform scenario loader.
 *
 * If `root` is a directory containing `common/` and/or `<adapter>/` sub-
 * directories, load the union:
 *
 *     scenarios/
 *     ├── common/          → runs against every adapter
 *     ├── openclaw/        → runs only when adapter === "openclaw"
 *     └── hermes/          → runs only when adapter === "hermes"
 *
 * Otherwise (root has no known subdirectories, or is a flat dir of YAMLs),
 * fall back to loadScenariosFromDir for backwards compatibility with any
 * caller that still passes a flat directory.
 *
 * Order within the result is deterministic: common scenarios first (sorted
 * by filename), then platform scenarios (sorted by filename). Running the
 * common set first means transport/smoke issues surface before depth
 * testing.
 */
export function loadScenariosForAdapter(
  root: string,
  adapter: string,
): Scenario[] {
  if (!statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${root}`);
  }

  const entries = new Set(readdirSync(root));
  const hasCommon = entries.has("common");
  const hasAdapter = entries.has(adapter);

  // Legacy flat layout: no known subdirs → load YAMLs directly.
  if (!hasCommon && !hasAdapter) {
    return loadScenariosFromDir(root);
  }

  const scenarios: Scenario[] = [];
  if (hasCommon) {
    const commonDir = join(root, "common");
    if (statSync(commonDir).isDirectory()) {
      scenarios.push(...loadScenariosFromDir(commonDir));
    }
  }
  if (hasAdapter) {
    const adapterDir = join(root, adapter);
    if (statSync(adapterDir).isDirectory()) {
      scenarios.push(...loadScenariosFromDir(adapterDir));
    }
  }
  return scenarios;
}

// -------- internals --------

function parseAssertion(
  raw: unknown,
  label: string,
  filePath: string,
): Assertion {
  if (!isObject(raw)) {
    throw new ScenarioLoadError(`${label} must be an object`, filePath);
  }
  const type = raw.type;
  if (typeof type !== "string") {
    throw new ScenarioLoadError(`${label}.type is required`, filePath);
  }

  const severity =
    raw.severity === "critical" ||
    raw.severity === "warning" ||
    raw.severity === "info"
      ? raw.severity
      : undefined;
  const description =
    typeof raw.description === "string" ? raw.description : undefined;

  const attach = <T extends { type: string }>(base: T): T => {
    const out = { ...base } as T & {
      severity?: string;
      description?: string;
    };
    if (severity !== undefined) out.severity = severity;
    if (description !== undefined) out.description = description;
    return out as T;
  };

  switch (type) {
    case "response_contains":
    case "response_not_contains": {
      if (typeof raw.value !== "string") {
        throw new ScenarioLoadError(
          `${label}.value must be a string`,
          filePath,
        );
      }
      const caseInsensitive =
        typeof raw.caseInsensitive === "boolean"
          ? raw.caseInsensitive
          : undefined;
      const base: Assertion =
        type === "response_contains"
          ? { type, value: raw.value }
          : { type, value: raw.value };
      if (caseInsensitive !== undefined) {
        (base as { caseInsensitive?: boolean }).caseInsensitive =
          caseInsensitive;
      }
      return attach(base);
    }

    case "response_matches": {
      if (typeof raw.pattern !== "string") {
        throw new ScenarioLoadError(
          `${label}.pattern must be a string`,
          filePath,
        );
      }
      const flags = typeof raw.flags === "string" ? raw.flags : undefined;
      const base: Assertion = { type, pattern: raw.pattern };
      if (flags !== undefined)
        (base as { flags?: string }).flags = flags;
      return attach(base);
    }

    case "response_time_under":
    case "response_time_over": {
      if (typeof raw.valueMs !== "number" || raw.valueMs <= 0) {
        throw new ScenarioLoadError(
          `${label}.valueMs must be a positive number`,
          filePath,
        );
      }
      return attach({ type, valueMs: raw.valueMs });
    }

    case "response_is_non_empty":
    case "response_is_empty": {
      return attach({ type });
    }

    case "tool_called":
    case "tool_not_called": {
      if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
        throw new ScenarioLoadError(
          `${label}.tool must be a non-empty string`,
          filePath,
        );
      }
      return attach({ type, tool: raw.tool });
    }

    case "tool_call_count": {
      const base: Assertion = { type };
      const b = base as {
        tool?: string;
        expectCount?: number;
        expectMin?: number;
        expectMax?: number;
      };
      if (typeof raw.tool === "string") b.tool = raw.tool;
      if (typeof raw.expectCount === "number") b.expectCount = raw.expectCount;
      if (typeof raw.expectMin === "number") b.expectMin = raw.expectMin;
      if (typeof raw.expectMax === "number") b.expectMax = raw.expectMax;
      return attach(base);
    }

    case "tool_params_contain": {
      if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
        throw new ScenarioLoadError(
          `${label}.tool must be a non-empty string`,
          filePath,
        );
      }
      if (typeof raw.value !== "string") {
        throw new ScenarioLoadError(
          `${label}.value must be a string`,
          filePath,
        );
      }
      const base: Assertion = { type, tool: raw.tool, value: raw.value };
      if (typeof raw.caseInsensitive === "boolean") {
        (base as { caseInsensitive?: boolean }).caseInsensitive =
          raw.caseInsensitive;
      }
      return attach(base);
    }

    case "agentdb_query": {
      if (typeof raw.sql !== "string" || raw.sql.trim() === "") {
        throw new ScenarioLoadError(
          `${label}.sql must be a non-empty string`,
          filePath,
        );
      }
      const base: Assertion = { type, sql: raw.sql };
      const b = base as AssertionWithAgentDBFields;
      if (Array.isArray(raw.params)) {
        const cleanedParams: (string | number | boolean | null)[] = [];
        for (let k = 0; k < raw.params.length; k++) {
          const p = raw.params[k];
          if (
            typeof p === "string" ||
            typeof p === "number" ||
            typeof p === "boolean" ||
            p === null
          ) {
            cleanedParams.push(p);
          } else {
            throw new ScenarioLoadError(
              `${label}.params[${k}] must be string | number | boolean | null`,
              filePath,
            );
          }
        }
        b.params = cleanedParams;
      }
      if (typeof raw.expectRowCount === "number") {
        b.expectRowCount = raw.expectRowCount;
      }
      if (typeof raw.expectMinRows === "number") {
        b.expectMinRows = raw.expectMinRows;
      }
      if (typeof raw.expectMaxRows === "number") {
        b.expectMaxRows = raw.expectMaxRows;
      }
      if (isObject(raw.expectFirstRow)) {
        const row: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(raw.expectFirstRow)) {
          if (
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean" ||
            v === null
          ) {
            row[k] = v;
          } else {
            throw new ScenarioLoadError(
              `${label}.expectFirstRow.${k} must be string | number | boolean | null`,
              filePath,
            );
          }
        }
        b.expectFirstRow = row;
      }
      return attach(base);
    }

    default:
      throw new ScenarioLoadError(
        `${label}.type "${type}" is not a known assertion type`,
        filePath,
      );
  }
}

interface AssertionWithAgentDBFields {
  params?: (string | number | boolean | null)[];
  expectRowCount?: number;
  expectMinRows?: number;
  expectMaxRows?: number;
  expectFirstRow?: Record<string, string | number | boolean | null>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
