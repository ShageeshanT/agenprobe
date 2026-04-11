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

// -------- export --------

/**
 * The default OpenClaw doctor profile. Order matters here only for the
 * cosmetic order of cards in the dashboard — checks are independent and
 * the runner will execute every one regardless of earlier failures.
 */
export function buildOpenClawDoctorChecks(): DoctorCheck[] {
  return [
    checkGatewayHealth,
    checkPairingPresent,
    checkAgentDBPresent,
    checkAgentDBSchema,
    checkPluginsEnabled,
    checkChannelsConfigured,
    checkCronJobs,
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
