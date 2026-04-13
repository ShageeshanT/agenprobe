/**
 * Doctor checks specific to an OpenClaw deployment.
 *
 * Each check is a small async function that produces a status + detail.
 * They share a common context (Railway coords, gateway URL, agent id)
 * and lean on the existing setup.ts and openclaw-agentdb.ts helpers
 * for the actual SSH / SQL plumbing.
 */
import type { DoctorCheck } from "../core/doctor-runner.js";
import { queryAgentDB } from "./openclaw-agentdb.js";
import { runRemoteCommand } from "../core/setup.js";

/**
 * The minimum table set we expect on a freshly-installed OpenClaw with
 * the agentdb plugin enabled. Bots with custom tables (leads, billing,
 * deals, etc.) layer extra entries via DoctorContext.expectedAgentDBTables
 * — those get appended to this base list at runtime.
 */
const BASE_AGENTDB_TABLES = [
  "_schema_registry",
  "contacts",
  "contact_phones",
];

/**
 * The minimum plugin set we expect for a typical bot — agentdb (state)
 * plus at least one channel. Bots can override via expectedPlugins.
 */
const BASE_PLUGINS = ["agentdb"];

const ERROR_LINE_RX = /\b(error|fatal|exception|critical|crash|panic)\b/i;

// -------- gateway --------

const checkGatewayHealth: DoctorCheck = {
  id: "gateway_healthy",
  label: "Gateway HTTP /health responds",
  category: "gateway",
  applies: (ctx) => Boolean(ctx.gatewayUrl),
  async run(ctx) {
    const url = `${ctx.gatewayUrl}/health`;
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8000) });
    } catch (err) {
      return {
        status: "fail",
        detail: `unreachable: ${(err as Error).message}`,
      };
    }
    const elapsed = Date.now() - startedAt;
    if (!res.ok) {
      return {
        status: "fail",
        detail: `HTTP ${res.status} ${res.statusText} (${elapsed}ms)`,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    const ok =
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).ok === true;
    return {
      status: ok ? "ok" : "warn",
      detail: ok
        ? `${elapsed}ms — ${JSON.stringify(body)}`
        : `unexpected payload: ${JSON.stringify(body).slice(0, 120)}`,
      data: { url, elapsedMs: elapsed, body },
    };
  },
};

// -------- agentdb --------

const checkAgentDBPresent: DoctorCheck = {
  id: "agentdb_present",
  label: "AgentDB SQLite file exists",
  category: "agentdb",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    // Use queryAgentDB itself as the existence check — if the file
    // doesn't exist the helper returns a clean error message.
    try {
      const result = await queryAgentDB({
        coords: ctx.coords,
        agentId: ctx.agentId,
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1",
      });
      return {
        status: "ok",
        detail: `agentdb-${ctx.agentId}.sqlite reachable, ${result.rowCount} table(s) sampled`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "fail",
        detail: msg,
      };
    }
  },
};

const checkAgentDBSchema: DoctorCheck = {
  id: "agentdb_schema",
  label: "AgentDB has the expected base tables",
  category: "agentdb",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const expected = [
      ...BASE_AGENTDB_TABLES,
      ...(ctx.expectedAgentDBTables ?? []),
    ];

    let result;
    try {
      result = await queryAgentDB({
        coords: ctx.coords,
        agentId: ctx.agentId,
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      });
    } catch (err) {
      return {
        status: "fail",
        detail: `agentdb query failed: ${(err as Error).message}`,
      };
    }
    const present = new Set(
      result.rows
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string"),
    );
    const missing = expected.filter((t) => !present.has(t));
    if (missing.length > 0) {
      return {
        status: "fail",
        detail: `missing required table(s): ${missing.join(", ")}`,
        data: { expected, present: [...present], missing },
      };
    }
    return {
      status: "ok",
      detail: `${expected.length} expected table(s) present, ${present.size} total in DB`,
      data: { expected, present: [...present] },
    };
  },
};

// -------- plugins --------

const checkPluginsEnabled: DoctorCheck = {
  id: "plugins_enabled",
  label: "Required plugins are enabled in openclaw.json",
  category: "plugins",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const expected = [...BASE_PLUGINS, ...(ctx.expectedPlugins ?? [])];
    const script = `
cat > /tmp/agentprobe-doctor-plugins.js <<'PLUGINS_EOF'
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("/data/.openclaw/openclaw.json", "utf8"));
const entries = (cfg.plugins && cfg.plugins.entries) || {};
const out = {};
for (const k of Object.keys(entries)) out[k] = Boolean(entries[k] && entries[k].enabled);
console.log("AGENTPROBE_PLUGINS=" + JSON.stringify(out));
PLUGINS_EOF
node /tmp/agentprobe-doctor-plugins.js
rm -f /tmp/agentprobe-doctor-plugins.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) {
      return { status: "fail", detail: `remote exit ${code}` };
    }
    const m = stdout.match(/AGENTPROBE_PLUGINS=(\{.*\})/);
    if (!m || !m[1]) {
      return { status: "fail", detail: "no parseable output from container" };
    }
    const all = JSON.parse(m[1]) as Record<string, boolean>;
    const enabled = Object.keys(all).filter((k) => all[k]);
    const missing = expected.filter((p) => !all[p]);
    if (missing.length > 0) {
      return {
        status: "fail",
        detail: `required plugin(s) not enabled: ${missing.join(", ")}`,
        data: { all, enabled, expected, missing },
      };
    }
    return {
      status: "ok",
      detail: `${enabled.length} enabled: ${enabled.join(", ")}`,
      data: { all, enabled, expected },
    };
  },
};

// -------- channels --------

const checkChannelsConfigured: DoctorCheck = {
  id: "channels_configured",
  label: "Messaging channels have credentials installed",
  category: "channels",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    // Inspect the credentials directory + the openclaw.json plugin block
    // for each channel. We don't try to verify "is the channel actively
    // RUNNING" here — that's a runtime question better answered by a
    // chat probe (which the scenarios cover). This check answers
    // "is the channel set up at all".
    const script = `
cat > /tmp/agentprobe-doctor-chan.js <<'CHAN_EOF'
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync("/data/.openclaw/openclaw.json", "utf8"));
const entries = (cfg.plugins && cfg.plugins.entries) || {};
const credDir = "/data/.openclaw/credentials";
const credFiles = fs.existsSync(credDir) ? fs.readdirSync(credDir) : [];
const channels = ["whatsapp", "telegram", "discord", "slack", "email", "signal", "imessage"];
const out = {};
for (const name of channels) {
  const enabled = Boolean(entries[name] && entries[name].enabled);
  if (!enabled) continue;
  const credsForChannel = credFiles.filter((f) => f.startsWith(name + "-"));
  let hasPairing = credsForChannel.some((f) => f.includes("pairing"));
  out[name] = {
    enabled,
    credentialFiles: credsForChannel,
    hasPairingFile: hasPairing,
  };
}
console.log("AGENTPROBE_CHANNELS=" + JSON.stringify(out));
CHAN_EOF
node /tmp/agentprobe-doctor-chan.js
rm -f /tmp/agentprobe-doctor-chan.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) {
      return { status: "fail", detail: `remote exit ${code}` };
    }
    const m = stdout.match(/AGENTPROBE_CHANNELS=(\{.*\})/);
    if (!m || !m[1]) {
      return { status: "fail", detail: "no parseable output" };
    }
    const channels = JSON.parse(m[1]) as Record<
      string,
      { enabled: boolean; credentialFiles: string[]; hasPairingFile: boolean }
    >;
    const names = Object.keys(channels);
    if (names.length === 0) {
      return {
        status: "warn",
        detail: "no messaging channels enabled in openclaw.json",
        data: { channels },
      };
    }
    const broken = names.filter((n) => !channels[n]?.hasPairingFile);
    if (broken.length > 0) {
      return {
        status: "warn",
        detail: `enabled but missing pairing creds: ${broken.join(", ")}`,
        data: { channels, broken },
      };
    }
    return {
      status: "ok",
      detail: `${names.length} channel(s) configured: ${names.join(", ")}`,
      data: { channels },
    };
  },
};

// -------- cron --------

const checkCronJobs: DoctorCheck = {
  id: "cron_jobs",
  label: "Cron jobs are loaded",
  category: "cron",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const script = `
cat > /tmp/agentprobe-doctor-cron.js <<'CRON_EOF'
const fs = require("fs");
const p = "/data/.openclaw/cron/jobs.json";
if (!fs.existsSync(p)) {
  console.log("AGENTPROBE_CRON=" + JSON.stringify({ exists: false, count: 0, jobs: [] }));
  process.exit(0);
}
let parsed;
try { parsed = JSON.parse(fs.readFileSync(p, "utf8")); }
catch (err) { console.log("AGENTPROBE_CRON=" + JSON.stringify({ error: "parse failed: " + err.message })); process.exit(0); }
const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : (Array.isArray(parsed) ? parsed : []);
const summaries = jobs.slice(0, 20).map((j) => ({
  name: j.name || j.id || "(unnamed)",
  schedule: j.cron || j.schedule || "?",
  enabled: j.enabled !== false,
}));
console.log("AGENTPROBE_CRON=" + JSON.stringify({ exists: true, count: jobs.length, sample: summaries }));
CRON_EOF
node /tmp/agentprobe-doctor-cron.js
rm -f /tmp/agentprobe-doctor-cron.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) {
      return { status: "fail", detail: `remote exit ${code}` };
    }
    const m = stdout.match(/AGENTPROBE_CRON=(\{.*\})/);
    if (!m || !m[1]) {
      return { status: "fail", detail: "no parseable output" };
    }
    const data = JSON.parse(m[1]) as
      | { error: string }
      | { exists: boolean; count: number; sample?: unknown[] };
    if ("error" in data) {
      return { status: "fail", detail: data.error };
    }
    if (!data.exists) {
      return {
        status: "warn",
        detail: "no cron/jobs.json file (no scheduled jobs configured)",
        data,
      };
    }
    if (data.count === 0) {
      return {
        status: "warn",
        detail: "cron file exists but contains zero jobs",
        data,
      };
    }
    return {
      status: "ok",
      detail: `${data.count} cron job(s) loaded`,
      data,
    };
  },
};

// -------- logs --------

const checkRecentErrors: DoctorCheck = {
  id: "recent_errors",
  label: "Server log free of recent ERROR / FATAL lines",
  category: "logs",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    // Tail the most recent 800 lines of server.log (≈48 hours of activity
    // on a typical bot) and count lines containing common error markers.
    // We classify by severity:
    //   0      → ok
    //   1-9    → warn ("a few errors but possibly transient")
    //   10+    → fail
    // We also report the timestamp of the most recent error line so the
    // user can quickly investigate when it happened.
    const script = `
cat > /tmp/agentprobe-doctor-logs.js <<'LOGS_EOF'
const fs = require("fs");
const path = "/data/.openclaw/server.log";
if (!fs.existsSync(path)) {
  console.log("AGENTPROBE_LOGS=" + JSON.stringify({ exists: false }));
  process.exit(0);
}
const stat = fs.statSync(path);
const buf = fs.readFileSync(path, "utf8");
const lines = buf.split(/\\r?\\n/);
const tail = lines.slice(-800);
const rx = /\\b(ERROR|FATAL|EXCEPTION|CRITICAL|CRASH|PANIC)\\b/i;
let count = 0;
let lastErrorLine = null;
for (const l of tail) {
  if (rx.test(l)) {
    count += 1;
    lastErrorLine = l.length > 240 ? l.slice(0, 240) + "..." : l;
  }
}
console.log("AGENTPROBE_LOGS=" + JSON.stringify({
  exists: true,
  sizeBytes: stat.size,
  modifiedAt: stat.mtime.toISOString(),
  linesScanned: tail.length,
  errorCount: count,
  lastErrorLine: lastErrorLine
}));
LOGS_EOF
node /tmp/agentprobe-doctor-logs.js
rm -f /tmp/agentprobe-doctor-logs.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 20_000);
    if (code !== 0) {
      return { status: "fail", detail: `remote exit ${code}` };
    }
    const m = stdout.match(/AGENTPROBE_LOGS=(\{.*\})/);
    if (!m || !m[1]) {
      return { status: "fail", detail: "no parseable output" };
    }
    const data = JSON.parse(m[1]) as
      | { exists: false }
      | {
          exists: true;
          sizeBytes: number;
          modifiedAt: string;
          linesScanned: number;
          errorCount: number;
          lastErrorLine: string | null;
        };
    if (!data.exists) {
      return { status: "warn", detail: "server.log not found" };
    }
    if (data.errorCount === 0) {
      return {
        status: "ok",
        detail: `0 error lines in last ${data.linesScanned} lines (log last touched ${data.modifiedAt})`,
        data,
      };
    }
    if (data.errorCount < 10) {
      return {
        status: "warn",
        detail: `${data.errorCount} error line(s) in last ${data.linesScanned} lines`,
        data,
      };
    }
    return {
      status: "fail",
      detail: `${data.errorCount} error line(s) in last ${data.linesScanned} lines — most recent: ${(data.lastErrorLine || "").slice(0, 120)}`,
      data,
    };
  },
};

// -------- system --------

const checkDiskSpace: DoctorCheck = {
  id: "disk_space",
  label: "/data volume has free space",
  category: "system",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const script = `df -B1 /data | tail -1`;
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 10_000);
    if (code !== 0) {
      return { status: "fail", detail: `remote exit ${code}` };
    }
    // df output: filesystem  size  used  avail  use%  mountpoint
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 5) {
      return { status: "warn", detail: `unexpected df output: ${stdout.trim().slice(0, 120)}` };
    }
    const totalRaw = parts[1] ?? "";
    const usedRaw = parts[2] ?? "";
    const availRaw = parts[3] ?? "";
    const usePctRaw = parts[4] ?? "";
    const total = Number.parseInt(totalRaw, 10);
    const used = Number.parseInt(usedRaw, 10);
    const avail = Number.parseInt(availRaw, 10);
    const usePct = Number.parseInt(usePctRaw.replace("%", ""), 10);
    const data = { totalBytes: total, usedBytes: used, availBytes: avail, usePct };

    if (Number.isNaN(usePct)) {
      return { status: "warn", detail: `couldn't parse usage`, data };
    }
    if (usePct >= 90) {
      return {
        status: "fail",
        detail: `${usePct}% used (${formatBytes(avail)} free of ${formatBytes(total)})`,
        data,
      };
    }
    if (usePct >= 75) {
      return {
        status: "warn",
        detail: `${usePct}% used (${formatBytes(avail)} free of ${formatBytes(total)})`,
        data,
      };
    }
    return {
      status: "ok",
      detail: `${usePct}% used (${formatBytes(avail)} free of ${formatBytes(total)})`,
      data,
    };
  },
};

// -------- pairing --------

const checkPairingPresent: DoctorCheck = {
  id: "pairing_present",
  label: "AgentProbe is paired with this gateway",
  category: "gateway",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const script = `
cat > /tmp/agentprobe-doctor-pair.js <<'PAIR_EOF'
const fs = require("fs");
const p = "/data/.openclaw/devices/paired.json";
if (!fs.existsSync(p)) {
  console.log("AGENTPROBE_PAIR_DOC=" + JSON.stringify({ exists: false, count: 0, hasAgentProbe: false }));
  process.exit(0);
}
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, "utf8")); }
catch (err) { console.log("AGENTPROBE_PAIR_DOC=" + JSON.stringify({ error: err.message })); process.exit(0); }
const ids = Object.keys(obj);
const hasAgentProbe = ids.some((id) =>
  obj[id] && (obj[id].deviceFamily === "agentprobe" || obj[id].clientId === "openclaw-probe")
);
console.log("AGENTPROBE_PAIR_DOC=" + JSON.stringify({ exists: true, count: ids.length, hasAgentProbe }));
PAIR_EOF
node /tmp/agentprobe-doctor-pair.js
rm -f /tmp/agentprobe-doctor-pair.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) {
      return { status: "fail", detail: `remote exit ${code}` };
    }
    const m = stdout.match(/AGENTPROBE_PAIR_DOC=(\{.*\})/);
    if (!m || !m[1]) {
      return { status: "fail", detail: "no parseable output" };
    }
    const data = JSON.parse(m[1]) as
      | { error: string }
      | { exists: boolean; count: number; hasAgentProbe: boolean };
    if ("error" in data) {
      return { status: "fail", detail: data.error };
    }
    if (!data.exists) {
      return {
        status: "warn",
        detail: "no paired.json — no devices have been paired yet",
        data,
      };
    }
    if (!data.hasAgentProbe) {
      return {
        status: "warn",
        detail: `${data.count} device(s) paired, but none look like AgentProbe`,
        data,
      };
    }
    return {
      status: "ok",
      detail: `${data.count} device(s) paired, including AgentProbe`,
      data,
    };
  },
};

// -------- composio --------

/**
 * Check that the Composio plugin has a consumer key configured — either
 * in openclaw.json plugins.entries.composio.config.consumerKey or in the
 * COMPOSIO_CONSUMER_KEY env var. Without a key the plugin is enabled but
 * dead; the MCP endpoint returns 401 and no tools are available.
 *
 * On success this check stores the discovered key + MCP URL in
 * ctx.composio (a transient field) so subsequent Composio checks can
 * reuse them without another SSH call.
 */
const checkComposioKeyConfigured: DoctorCheck = {
  id: "composio_key_configured",
  label: "Composio consumer key is set",
  category: "composio",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const script = `
cat > /tmp/agentprobe-composio-key.js <<'COMPKEY_EOF'
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("/data/.openclaw/openclaw.json", "utf8"));
const entry = c.plugins && c.plugins.entries && c.plugins.entries.composio;
const cfg = entry && entry.config;
const keyFromConfig = (cfg && cfg.consumerKey) || null;
const keyFromEnv = process.env.COMPOSIO_CONSUMER_KEY || null;
const key = keyFromConfig || keyFromEnv;
console.log("COMPOSIO_KEY=" + JSON.stringify({
  enabled: Boolean(entry && entry.enabled),
  hasKey: Boolean(key),
  keyPrefix: key ? key.slice(0, 6) + "..." : null,
  keyFull: key || null,
  mcpUrl: (cfg && cfg.mcpUrl) || "https://connect.composio.dev/mcp"
}));
COMPKEY_EOF
node /tmp/agentprobe-composio-key.js
rm -f /tmp/agentprobe-composio-key.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) {
      return { status: "fail", detail: `remote exit ${code}` };
    }
    const m = stdout.match(/COMPOSIO_KEY=(\{.*\})/);
    if (!m || !m[1]) {
      return { status: "fail", detail: "no parseable output" };
    }
    const info = JSON.parse(m[1]) as {
      enabled: boolean;
      hasKey: boolean;
      keyPrefix: string | null;
      keyFull: string | null;
      mcpUrl: string;
    };

    // Stash key + URL for the subsequent Composio checks so they don't
    // need to SSH again.
    if (info.keyFull) {
      (ctx as ComposioAwareContext)._composioKey = info.keyFull;
      (ctx as ComposioAwareContext)._composioMcpUrl = info.mcpUrl;
    }

    if (!info.enabled) {
      return {
        status: "skip",
        detail: "composio plugin is not enabled",
        data: info,
      };
    }
    if (!info.hasKey) {
      return {
        status: "warn",
        detail: "composio plugin is enabled but no consumer key is configured (config or COMPOSIO_CONSUMER_KEY env)",
        data: info,
      };
    }
    return {
      status: "ok",
      detail: `consumer key: ${info.keyPrefix} · MCP URL: ${info.mcpUrl}`,
      data: { keyPrefix: info.keyPrefix, mcpUrl: info.mcpUrl },
    };
  },
};

/** Transient extension of DoctorContext for passing the key between checks. */
interface ComposioAwareContext {
  _composioKey?: string;
  _composioMcpUrl?: string;
}

/**
 * Verify the Composio MCP endpoint is reachable by POSTing an MCP
 * `initialize` request. If the consumer key is wrong or expired the
 * endpoint returns 401 — which is itself a useful finding.
 *
 * This runs from AgentProbe's own process, not from the container,
 * because the endpoint is a public HTTPS URL. No SSH needed.
 */
const checkComposioMcpReachable: DoctorCheck = {
  id: "composio_mcp_reachable",
  label: "Composio MCP endpoint is reachable",
  category: "composio",
  applies: (ctx) => Boolean((ctx as ComposioAwareContext)._composioKey),
  async run(ctx) {
    const key = (ctx as ComposioAwareContext)._composioKey;
    const mcpUrl = (ctx as ComposioAwareContext)._composioMcpUrl ?? "https://connect.composio.dev/mcp";
    if (!key) return { status: "skip", detail: "no consumer key discovered" };

    const initPayload = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentprobe-doctor", version: "1.0" },
      },
      id: 1,
    };

    try {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-consumer-api-key": key,
        },
        body: JSON.stringify(initPayload),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 401) {
        return {
          status: "fail",
          detail: "MCP endpoint returned 401 — consumer key is invalid or expired",
          data: { mcpUrl, httpStatus: res.status },
        };
      }
      if (!res.ok) {
        return {
          status: "warn",
          detail: `MCP endpoint returned HTTP ${res.status} ${res.statusText}`,
          data: { mcpUrl, httpStatus: res.status },
        };
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      return {
        status: "ok",
        detail: `MCP endpoint responded (HTTP ${res.status})`,
        data: { mcpUrl, httpStatus: res.status, body },
      };
    } catch (err) {
      return {
        status: "fail",
        detail: `MCP endpoint unreachable: ${(err as Error).message}`,
        data: { mcpUrl },
      };
    }
  },
};

/**
 * Ask the MCP endpoint for the list of available tools — i.e., which
 * Composio connectors are actually wired up. An empty list means the
 * consumer key is valid but no apps have been connected on the Composio
 * dashboard.
 *
 * The output is the most useful card in the Composio section of the
 * dashboard: "12 tools available: GMAIL_SEND_EMAIL, GMAIL_LIST_EMAILS,
 * GOOGLE_SHEETS_CREATE_ROW, ..."
 */
const checkComposioToolsList: DoctorCheck = {
  id: "composio_tools_list",
  label: "Composio connected tools",
  category: "composio",
  applies: (ctx) => Boolean((ctx as ComposioAwareContext)._composioKey),
  async run(ctx) {
    const key = (ctx as ComposioAwareContext)._composioKey;
    const mcpUrl = (ctx as ComposioAwareContext)._composioMcpUrl ?? "https://connect.composio.dev/mcp";
    if (!key) return { status: "skip", detail: "no consumer key discovered" };

    // MCP tools/list request (JSON-RPC 2.0)
    const listPayload = {
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2,
    };

    try {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-consumer-api-key": key,
        },
        body: JSON.stringify(listPayload),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        return {
          status: "warn",
          detail: `MCP endpoint returned HTTP ${res.status} when listing tools`,
          data: { httpStatus: res.status },
        };
      }
      const body = (await res.json()) as {
        result?: { tools?: { name: string }[] };
        error?: { message?: string };
      };
      if (body.error) {
        return {
          status: "warn",
          detail: `MCP tools/list returned error: ${body.error.message ?? JSON.stringify(body.error)}`,
          data: { error: body.error },
        };
      }
      const tools = body.result?.tools ?? [];
      const toolNames = tools.map((t) => t.name);

      // Group by app prefix (e.g. GMAIL_, GOOGLE_SHEETS_, SLACK_)
      const apps = new Set<string>();
      for (const name of toolNames) {
        const parts = name.split("_");
        // Heuristic: the "app" is everything before the last action word(s).
        // GMAIL_SEND_EMAIL → GMAIL, GOOGLE_SHEETS_CREATE_ROW → GOOGLE_SHEETS
        // For better grouping, take the first 1-2 segments as the app prefix
        // unless the name is short.
        if (parts.length >= 3) {
          // Check if second part looks like a sub-service
          const candidate = parts.slice(0, 2).join("_");
          if (parts.length >= 4) apps.add(candidate);
          else apps.add(parts[0] ?? name);
        } else {
          apps.add(parts[0] ?? name);
        }
      }

      if (toolNames.length === 0) {
        return {
          status: "warn",
          detail: "consumer key is valid but no Composio tools are connected — connect apps on the Composio dashboard",
          data: { toolCount: 0, tools: toolNames, apps: [...apps] },
        };
      }
      return {
        status: "ok",
        detail: `${toolNames.length} tool(s) from ${apps.size} app(s): ${[...apps].slice(0, 8).join(", ")}${apps.size > 8 ? " +" + (apps.size - 8) + " more" : ""}`,
        data: { toolCount: toolNames.length, appCount: apps.size, apps: [...apps], tools: toolNames },
      };
    } catch (err) {
      return {
        status: "fail",
        detail: `MCP tools/list call failed: ${(err as Error).message}`,
      };
    }
  },
};

// -------- workspace integrity --------

const checkWorkspaceFiles: DoctorCheck = {
  id: "workspace_files",
  label: "Required workspace files are present",
  category: "agentdb",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const script = `
cat > /tmp/agentprobe-doctor-ws.js <<'WS_EOF'
const fs = require("fs");
const path = require("path");
const home = process.env.HOME || "/root";
const ws = process.env.OPENCLAW_WORKSPACE_DIR || path.join(home, ".openclaw", "workspace");
const required = [
  "SOUL.md", "MEMORY.md", "IDENTITY.md", "HEARTBEAT.md",
  "TOOLS.md", "AGENTS.md", "USER.md"
];
const found = [];
const missing = [];
for (const f of required) {
  const fp = path.join(ws, f);
  if (fs.existsSync(fp) && fs.statSync(fp).size > 0) found.push(f);
  else missing.push(f);
}
const dirs = [".learnings", "memory"];
const missingDirs = [];
for (const d of dirs) {
  if (!fs.existsSync(path.join(ws, d))) missingDirs.push(d);
}
console.log("AGENTPROBE_WS=" + JSON.stringify({ ws, found, missing, missingDirs }));
WS_EOF
node /tmp/agentprobe-doctor-ws.js
rm -f /tmp/agentprobe-doctor-ws.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) return { status: "fail", detail: `remote exit ${code}` };
    const m = stdout.match(/AGENTPROBE_WS=(\{.*\})/);
    if (!m || !m[1]) return { status: "fail", detail: "no parseable output" };
    const data = JSON.parse(m[1]) as {
      ws: string; found: string[]; missing: string[]; missingDirs: string[];
    };
    const issues = [...data.missing, ...data.missingDirs.map((d: string) => `${d}/`)];
    if (issues.length > 0) {
      return {
        status: "fail",
        detail: `missing: ${issues.join(", ")}`,
        data,
      };
    }
    return {
      status: "ok",
      detail: `${data.found.length} files present in ${data.ws}`,
      data,
    };
  },
};

// -------- agentdb config compliance --------

const checkAgentDBConfig: DoctorCheck = {
  id: "agentdb_config_compliance",
  label: "AgentDB safety flags are enabled",
  category: "agentdb",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const script = `
cat > /tmp/agentprobe-doctor-dbcfg.js <<'DBCFG_EOF'
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("/data/.openclaw/openclaw.json", "utf8"));
const entry = c.plugins && c.plugins.entries && c.plugins.entries.agentdb;
const cfg = entry && entry.config;
if (!cfg) { console.log("AGENTPROBE_DBCFG=" + JSON.stringify({ error: "no agentdb config" })); process.exit(0); }
console.log("AGENTPROBE_DBCFG=" + JSON.stringify({
  enabled: Boolean(entry.enabled),
  blockOnUnknownNumber: Boolean(cfg.blockOnUnknownNumber),
  blockOnRoutingConfusion: Boolean(cfg.blockOnRoutingConfusion),
  injectContactContext: Boolean(cfg.injectContactContext),
  allowAgentSchemaChanges: Boolean(cfg.allowAgentSchemaChanges)
}));
DBCFG_EOF
node /tmp/agentprobe-doctor-dbcfg.js
rm -f /tmp/agentprobe-doctor-dbcfg.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) return { status: "fail", detail: `remote exit ${code}` };
    const m = stdout.match(/AGENTPROBE_DBCFG=(\{.*\})/);
    if (!m || !m[1]) return { status: "fail", detail: "no parseable output" };
    const data = JSON.parse(m[1]) as Record<string, boolean | string>;
    if ("error" in data) return { status: "fail", detail: String(data.error) };

    const critical = [];
    if (!data.blockOnUnknownNumber) critical.push("blockOnUnknownNumber is OFF");
    if (!data.blockOnRoutingConfusion) critical.push("blockOnRoutingConfusion is OFF");
    if (!data.injectContactContext) critical.push("injectContactContext is OFF");

    if (critical.length > 0) {
      return {
        status: "fail",
        detail: `safety flags missing: ${critical.join(", ")}`,
        data,
      };
    }
    return {
      status: "ok",
      detail: "all safety flags enabled (blockOnUnknown, blockOnRouting, injectContext)",
      data,
    };
  },
};

// -------- skill installation --------

const checkSkillsInstalled: DoctorCheck = {
  id: "skills_installed",
  label: "Required skills are installed",
  category: "plugins",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    const script = `
cat > /tmp/agentprobe-doctor-skills.js <<'SKILLS_EOF'
const fs = require("fs");
const path = require("path");
const home = process.env.HOME || "/root";
const checks = [
  { name: "agentdb-skill", path: "/data/.openclaw/plugins/agentdb/skills/agentdb/SKILL.md" },
  { name: "self-improving", path: path.join(home, "self-improving", "SKILL.md") },
];
const found = [];
const missing = [];
for (const c of checks) {
  if (fs.existsSync(c.path)) found.push(c.name);
  else missing.push(c.name);
}
// Also check skills/ directory for any installed skills
let skillCount = 0;
const skillsDir = "/data/.openclaw/skills";
try {
  if (fs.existsSync(skillsDir)) {
    skillCount = fs.readdirSync(skillsDir).filter(f => fs.statSync(path.join(skillsDir, f)).isDirectory()).length;
  }
} catch {}
console.log("AGENTPROBE_SKILLS=" + JSON.stringify({ found, missing, totalSkillDirs: skillCount }));
SKILLS_EOF
node /tmp/agentprobe-doctor-skills.js
rm -f /tmp/agentprobe-doctor-skills.js
`.trim();
    const { stdout, code } = await runRemoteCommand(ctx.coords, script, 15_000);
    if (code !== 0) return { status: "fail", detail: `remote exit ${code}` };
    const m = stdout.match(/AGENTPROBE_SKILLS=(\{.*\})/);
    if (!m || !m[1]) return { status: "fail", detail: "no parseable output" };
    const data = JSON.parse(m[1]) as {
      found: string[]; missing: string[]; totalSkillDirs: number;
    };
    if (data.missing.length > 0) {
      return {
        status: "warn",
        detail: `missing skill(s): ${data.missing.join(", ")}`,
        data,
      };
    }
    return {
      status: "ok",
      detail: `${data.found.length} required skill(s) present, ${data.totalSkillDirs} total in skills/`,
      data,
    };
  },
};

// -------- forwarder + owner contacts --------

const checkForwarderList: DoctorCheck = {
  id: "forwarder_list",
  label: "Forwarder list has at least one contact",
  category: "agentdb",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    try {
      const result = await queryAgentDB({
        coords: ctx.coords,
        agentId: ctx.agentId,
        sql: "SELECT COUNT(*) as n FROM contacts WHERE role = 'forwarder' AND is_active = 1",
      });
      const count = (result.rows[0] as Record<string, unknown>)?.n;
      const n = typeof count === "number" ? count : 0;
      if (n === 0) {
        return {
          status: "warn",
          detail: "no forwarders in AgentDB — quotation requests won't be routed to anyone",
          data: { forwarderCount: n },
        };
      }
      return {
        status: "ok",
        detail: `${n} active forwarder(s)`,
        data: { forwarderCount: n },
      };
    } catch (err) {
      return {
        status: "warn",
        detail: `couldn't query forwarders: ${(err as Error).message}`,
      };
    }
  },
};

const checkOwnerContact: DoctorCheck = {
  id: "owner_contact",
  label: "Owner is registered as admin in AgentDB",
  category: "agentdb",
  applies: (ctx) => Boolean(ctx.coords),
  async run(ctx) {
    if (!ctx.coords) return { status: "skip", detail: "no coords" };
    try {
      const result = await queryAgentDB({
        coords: ctx.coords,
        agentId: ctx.agentId,
        sql: "SELECT COUNT(*) as n FROM contacts WHERE access_level = 'admin' AND is_active = 1",
      });
      const count = (result.rows[0] as Record<string, unknown>)?.n;
      const n = typeof count === "number" ? count : 0;
      if (n === 0) {
        return {
          status: "fail",
          detail: "no admin contacts in AgentDB — bot has no owner to escalate to",
          data: { adminCount: n },
        };
      }
      return {
        status: "ok",
        detail: `${n} admin contact(s)`,
        data: { adminCount: n },
      };
    } catch (err) {
      return {
        status: "warn",
        detail: `couldn't query admin contacts: ${(err as Error).message}`,
      };
    }
  },
};

// -------- export --------

/**
 * The default OpenClaw doctor profile. Order matters here only for the
 * cosmetic order of cards in the dashboard — checks are independent and
 * the runner will execute every one regardless of earlier failures.
 */
export function buildOpenClawDoctorChecks(): DoctorCheck[] {
  return [
    // Gateway
    checkGatewayHealth,
    checkPairingPresent,
    // AgentDB
    checkAgentDBPresent,
    checkAgentDBSchema,
    checkAgentDBConfig,
    checkForwarderList,
    checkOwnerContact,
    // Workspace
    checkWorkspaceFiles,
    // Plugins & Skills
    checkPluginsEnabled,
    checkSkillsInstalled,
    // Channels
    checkChannelsConfigured,
    // Composio
    checkComposioKeyConfigured,
    checkComposioMcpReachable,
    checkComposioToolsList,
    // Cron
    checkCronJobs,
    // Logs & System
    checkRecentErrors,
    checkDiskSpace,
  ];
}

// -------- helpers --------

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)}${units[i]}`;
}
