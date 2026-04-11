/**
 * Read-only AgentDB query helper for OpenClaw.
 *
 * OpenClaw agents persist structured state (contacts, message logs, custom
 * tables) in a SQLite database managed by the agentdb plugin. The plugin
 * resolves its path from `~/.openclaw/agentdb-{agentId}.sqlite` on the
 * container, using the openclaw user's home (NOT the OPENCLAW_STATE_DIR
 * env var). So the canonical path on a Railway deployment is:
 *
 *     /home/openclaw/.openclaw/agentdb-main.sqlite
 *
 * To query the file from outside the container we shell out to node on
 * the container via `railway ssh`, loading the bundled better-sqlite3
 * from the agentdb plugin's own node_modules. That avoids needing a
 * system sqlite3 CLI (which is not installed on the Railway image).
 *
 * This module is READ-ONLY on purpose. AgentProbe should never mutate
 * production agent state; assertions that want to verify mutations run
 * AFTER the bot performs them, checking what the agent itself wrote.
 */
import {
  runRemoteCommand,
  type RailwayCoordinates,
} from "../core/setup.js";

const DEFAULT_DB_PATH = "/home/openclaw/.openclaw/agentdb-{agentId}.sqlite";
const BETTER_SQLITE3_PATH =
  "/data/.openclaw/plugins/agentdb/node_modules/better-sqlite3";

export interface AgentDBQueryOptions {
  /** Railway container coordinates. */
  coords: RailwayCoordinates;
  /** Agent id used to resolve the SQLite file path. Defaults to "main". */
  agentId?: string;
  /** SQL statement. Only SELECT/PRAGMA is expected; the helper opens the DB read-only. */
  sql: string;
  /** Positional parameters. Values are passed through better-sqlite3's binding. */
  params?: readonly (string | number | boolean | null)[];
  /** Wall-clock cap for the whole SSH round-trip. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Override path template if the bot is on a non-standard layout. */
  dbPathTemplate?: string;
}

export interface AgentDBQueryResult {
  /** Rows returned by the query, as plain JSON objects. */
  rows: Record<string, unknown>[];
  /** Number of rows. Convenience for assertions. */
  rowCount: number;
  /** Wall-clock duration of the remote query. */
  durationMs: number;
}

/**
 * Run a read-only SQL query against the OpenClaw AgentDB via `railway ssh`.
 *
 * The query itself runs on the container inside a small node -e script
 * that opens the SQLite file with `readonly: true` and prints a single
 * AGENTDB_JSON=... line. We parse that line out and ignore anything else
 * (better-sqlite3 is noisy on stderr sometimes).
 */
export async function queryAgentDB(
  opts: AgentDBQueryOptions,
): Promise<AgentDBQueryResult> {
  const agentId = opts.agentId ?? "main";
  const template = opts.dbPathTemplate ?? DEFAULT_DB_PATH;
  const dbPath = template.replace("{agentId}", agentId);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const params = opts.params ?? [];

  // Previous attempts embedded the JS inline in `node -e '...'`, but SQL
  // strings containing single quotes (e.g. `WHERE type = 'table'`) broke
  // the outer bash single-quoted argument. We now write the JS to a
  // tempfile via a quoted heredoc — heredocs with a quoted delimiter
  // treat the body as literal text, so no character inside the script
  // is interpreted by bash.
  //
  // The SQL and params are injected as JSON.stringify'd values so
  // arbitrary strings, backslashes, and Unicode survive unchanged.
  const sqlJson = JSON.stringify(opts.sql);
  const paramsJson = JSON.stringify(params);
  const dbPathJson = JSON.stringify(dbPath);
  const betterPathJson = JSON.stringify(BETTER_SQLITE3_PATH);

  const remoteScript = `
cat > /tmp/agentprobe-agentdb-query.js <<'AGENTDB_SCRIPT_EOF'
const start = Date.now();
const better = require(${betterPathJson});
const fs = require("fs");
const path = ${dbPathJson};
if (!fs.existsSync(path)) {
  console.log("AGENTDB_JSON=" + JSON.stringify({ error: "db file not found: " + path }));
  process.exit(0);
}
let db;
try {
  db = new better(path, { readonly: true });
} catch (err) {
  console.log("AGENTDB_JSON=" + JSON.stringify({ error: "open failed: " + err.message }));
  process.exit(0);
}
try {
  const sql = ${sqlJson};
  const params = ${paramsJson};
  const stmt = db.prepare(sql);
  let rows;
  try {
    rows = params.length > 0 ? stmt.all(...params) : stmt.all();
  } catch (err) {
    const info = params.length > 0 ? stmt.run(...params) : stmt.run();
    rows = [{ changes: info.changes, lastInsertRowid: String(info.lastInsertRowid) }];
  }
  console.log("AGENTDB_JSON=" + JSON.stringify({ rows: rows, durationMs: Date.now() - start }));
} catch (err) {
  console.log("AGENTDB_JSON=" + JSON.stringify({ error: err.message || String(err) }));
} finally {
  db.close();
}
AGENTDB_SCRIPT_EOF
node /tmp/agentprobe-agentdb-query.js
rm -f /tmp/agentprobe-agentdb-query.js
`.trim();

  const { stdout, stderr, code } = await runRemoteCommand(
    opts.coords,
    remoteScript,
    timeoutMs,
  );
  if (code !== 0) {
    throw new Error(
      `agentdb query remote exited ${code}: ${(stderr || stdout).trim().slice(-300)}`,
    );
  }

  const match = stdout.match(/AGENTDB_JSON=(\{.*\})/);
  if (!match || !match[1]) {
    throw new Error(
      `agentdb query produced no parseable output. stdout: ${stdout.slice(0, 300)}`,
    );
  }
  const payload = JSON.parse(match[1]) as
    | { error: string }
    | { rows: Record<string, unknown>[]; durationMs: number };

  if ("error" in payload) {
    throw new Error(`agentdb query error: ${payload.error}`);
  }

  return {
    rows: payload.rows,
    rowCount: payload.rows.length,
    durationMs: payload.durationMs,
  };
}

/**
 * Convenience: get the list of tables in the AgentDB. Handy for diagnosing
 * "is the plugin even loaded" questions from a scenario setup step.
 */
export async function listAgentDBTables(
  coords: RailwayCoordinates,
  agentId: string = "main",
): Promise<string[]> {
  const result = await queryAgentDB({
    coords,
    agentId,
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  });
  return result.rows
    .map((r) => r.name)
    .filter((n): n is string => typeof n === "string");
}
