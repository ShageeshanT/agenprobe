/**
 * In-browser setup helpers.
 *
 * Drives the "Connect a bot" form on the dashboard: parses a Railway SSH
 * command, talks to the target container to discover the pieces that are
 * normally filled in by hand in .env, and (for OpenClaw) performs the
 * device-pairing dance. Every call returns a structured step log so the
 * UI can render progress as it happens.
 *
 * This module owns the side-effects that the server route needs to stitch
 * together. It does not know about Express.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";

import {
  generateDeviceKey,
  loadDeviceKey,
  type DeviceKeyMaterial,
} from "../adapters/openclaw-device-auth.js";

// -------- types --------

export interface RailwayCoordinates {
  project: string;
  environment: string;
  service: string;
}

export type SetupPlatform = "openclaw" | "hermes";

export interface SetupStep {
  /** Machine-readable step id for the UI progress log. */
  id: string;
  /** Human-readable label shown to the user. */
  label: string;
  status: "ok" | "fail" | "skipped";
  /** Optional free-form detail string (error message or discovered value). */
  detail?: string;
  /** ms spent in this step. */
  durationMs: number;
}

export interface SetupResult {
  platform: SetupPlatform;
  success: boolean;
  steps: SetupStep[];
  /** What got written to .env, masked. Useful for the UI confirmation. */
  envUpdates: Record<string, string>;
  /** Final error message if success=false. */
  error?: string;
}

// -------- command parsing --------

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a `railway ssh --project=<uuid> --environment=<uuid> --service=<uuid>`
 * command line string into its three UUIDs. Tolerates any argument order,
 * `--flag=value` or `--flag value`, extra whitespace, quoted values.
 *
 * Rejects anything that doesn't look like a valid railway ssh invocation
 * so the server route never shells out on attacker-controlled input.
 */
export function parseRailwaySshCommand(raw: string): RailwayCoordinates {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty command");
  }

  // Split into tokens while respecting simple quote pairs.
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  if (tokens.length < 2) {
    throw new Error("command is too short to be a railway ssh invocation");
  }

  // Must start with `railway ssh`. Some users paste `railway.exe ssh` or
  // with an absolute path; accept any "railway" final path segment.
  const first = tokens[0] ?? "";
  const second = tokens[1] ?? "";
  const firstName = first.split(/[\\/]/).pop() ?? first;
  if (!/^railway(\.exe)?$/i.test(firstName) || second !== "ssh") {
    throw new Error(`expected "railway ssh ..." but got "${firstName} ${second}"`);
  }

  const flags: Record<string, string> = {};
  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.startsWith("--")) {
      const eqIdx = tok.indexOf("=");
      if (eqIdx > 0) {
        const key = tok.slice(2, eqIdx);
        const value = tok.slice(eqIdx + 1);
        flags[key] = value;
      } else {
        const key = tok.slice(2);
        const value = tokens[i + 1] ?? "";
        flags[key] = value;
        i += 1;
      }
    }
  }

  const project = flags.project ?? "";
  const environment = flags.environment ?? "";
  const service = flags.service ?? "";

  if (!UUID_RX.test(project)) {
    throw new Error("missing or invalid --project UUID");
  }
  if (!UUID_RX.test(environment)) {
    throw new Error("missing or invalid --environment UUID");
  }
  if (!UUID_RX.test(service)) {
    throw new Error("missing or invalid --service UUID");
  }

  return { project, environment, service };
}

// -------- remote exec --------

/**
 * Run a single bash command inside the target Railway container. The
 * command is base64-encoded so arbitrary content (including quotes, pipes,
 * $variables) survives the Windows cmd.exe → railway ssh → remote bash
 * chain without any quoting nightmares.
 *
 * Retries up to `maxRetries` times (default 2) with exponential backoff
 * on transient failures: spawn errors (ENOENT when railway CLI is
 * temporarily unreachable), SSH connection resets, and timeouts. Non-zero
 * exit codes from the remote script are NOT retried — those usually mean
 * the script itself failed, and retrying won't help.
 */
export async function runRemoteCommand(
  coords: RailwayCoordinates,
  remoteBashScript: string,
  timeoutMs: number = 45_000,
  opts: { maxRetries?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const maxRetries = opts.maxRetries ?? 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 10_000);
      console.log(
        `[remote] retry ${attempt}/${maxRetries} after ${backoff}ms backoff`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }

    try {
      const result = await runRemoteCommandOnce(
        coords,
        remoteBashScript,
        timeoutMs,
      );
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      // Only retry on transport-level failures, not on remote script errors.
      const isTransient =
        msg.includes("timed out") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ENOENT") ||
        msg.includes("fetch failed") ||
        msg.includes("spawn") ||
        msg.includes("EPIPE");
      if (!isTransient) throw lastError;
    }
  }
  throw lastError ?? new Error("runRemoteCommand exhausted retries");
}

async function runRemoteCommandOnce(
  coords: RailwayCoordinates,
  remoteBashScript: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const b64 = Buffer.from(remoteBashScript, "utf8").toString("base64");
  const wrapped = `echo ${b64} | base64 -d | bash`;

  const cmdLine =
    `railway ssh` +
    ` --project=${coords.project}` +
    ` --environment=${coords.environment}` +
    ` --service=${coords.service}` +
    ` "${wrapped}"`;

  return new Promise((resolve, reject) => {
    const child = spawn(cmdLine, [], { shell: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`remote command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// -------- discovery --------

export interface OpenClawDiscovered {
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
}

/**
 * Read the OpenClaw container's runtime config and build a complete
 * OpenClaw connection profile. Uses one remote command that emits a
 * single JSON blob so we parse it once instead of running several SSH
 * round-trips.
 */
export async function discoverOpenClawConfig(
  coords: RailwayCoordinates,
): Promise<OpenClawDiscovered> {
  // Determine the runtime agent id by looking at what the gateway has
  // actually CREATED on disk, rather than what's declared in
  // openclaw.json. The agentdb plugin writes one file per agent at
  // ~/.openclaw/agentdb-<agentId>.sqlite, so whatever files exist there
  // are the real runtime agent names. "main" is the gateway's hardcoded
  // default — openclaw.json may carry a different key like "defaults"
  // which is a *config template*, not an agent id.
  //
  // We pipe the JS through a quoted heredoc temp file to sidestep the
  // single-quote-in-SQL/JS hell inside `node -e '...'` over an ssh tunnel.
  const script = `
cat > /tmp/agentprobe-discover.js <<'DISCOVER_EOF'
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync("/data/.openclaw/openclaw.json", "utf8"));
const gatewayToken = cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
const gatewayUrl = domain ? "https://" + domain : null;

// Scan the agentdb directory for real runtime agent ids.
let agentId = "main";
try {
  const home = process.env.HOME || "/home/openclaw";
  const dir = path.join(home, ".openclaw");
  const files = fs.readdirSync(dir);
  const dbFiles = files
    .filter((f) => f.startsWith("agentdb-") && f.endsWith(".sqlite"))
    .map((f) => f.slice("agentdb-".length, -".sqlite".length));
  if (dbFiles.length > 0) {
    agentId = dbFiles.includes("main") ? "main" : dbFiles[0];
  }
} catch (err) {
  // Fall through with "main" default.
}

const out = { gatewayUrl, gatewayToken, agentId };
if (!gatewayUrl) throw new Error("RAILWAY_PUBLIC_DOMAIN not set in container env");
if (!gatewayToken) throw new Error("gateway.auth.token missing from openclaw.json");
console.log("AGENTPROBE_DISCOVERY_JSON=" + JSON.stringify(out));
DISCOVER_EOF
node /tmp/agentprobe-discover.js
rm -f /tmp/agentprobe-discover.js
`.trim();

  const { stdout, stderr, code } = await runRemoteCommand(coords, script, 30_000);
  if (code !== 0) {
    throw new Error(
      `openclaw discovery failed (exit ${code}): ${(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(" ")}`,
    );
  }
  const match = stdout.match(/AGENTPROBE_DISCOVERY_JSON=(\{.*\})/);
  if (!match || !match[1]) {
    throw new Error("openclaw discovery produced no parseable output");
  }
  const parsed = JSON.parse(match[1]);
  if (
    typeof parsed.gatewayUrl !== "string" ||
    typeof parsed.gatewayToken !== "string" ||
    typeof parsed.agentId !== "string"
  ) {
    throw new Error("openclaw discovery payload missing expected fields");
  }
  return parsed as OpenClawDiscovered;
}

/**
 * Inject an AgentProbe device record into the OpenClaw gateway's
 * paired.json so that handshakes from this keypair land as a fully-paired
 * operator with all scopes. Idempotent — replaces the record if the
 * deviceId already exists.
 */
export async function pairOpenClawDevice(
  coords: RailwayCoordinates,
  key: DeviceKeyMaterial,
): Promise<void> {
  const record = {
    deviceId: key.deviceId,
    publicKey: key.publicKeyRawBase64Url,
    platform: "node",
    clientId: "openclaw-probe",
    clientMode: "webchat",
    role: "operator",
    roles: ["operator"],
    scopes: [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ],
    deviceFamily: "agentprobe",
    name: "agentprobe",
    pairedAt: new Date().toISOString(),
  };
  const recordB64 = Buffer.from(JSON.stringify(record), "utf8").toString(
    "base64",
  );
  const script = `
echo ${recordB64} | base64 -d > /tmp/agentprobe-device.json
node -e '
const fs = require("fs");
const p = "/data/.openclaw/devices/paired.json";
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const d = JSON.parse(fs.readFileSync("/tmp/agentprobe-device.json", "utf8"));
obj[d.deviceId] = d;
fs.writeFileSync(p, JSON.stringify(obj, null, 2));
console.log("AGENTPROBE_PAIR_OK=" + d.deviceId);
'
`.trim();

  const { stdout, stderr, code } = await runRemoteCommand(coords, script, 30_000);
  if (code !== 0 || !stdout.includes("AGENTPROBE_PAIR_OK=")) {
    throw new Error(
      `openclaw pairing failed (exit ${code}): ${(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(" ")}`,
    );
  }
}

/**
 * Remove an AgentProbe device record from the OpenClaw gateway's
 * paired.json. Idempotent: if the deviceId isn't there, the call
 * returns `{ removed: false }` and does not fail.
 *
 * Callers typically want to follow up by deleting their local pairing
 * key (.agentprobe-keys/openclaw-ed25519.pem) — but that's a separate
 * decision because the same key might still be used by another AgentProbe
 * install against the same bot. This function only touches the remote
 * state.
 */
export async function unpairOpenClawDevice(
  coords: RailwayCoordinates,
  deviceId: string,
): Promise<{ removed: boolean; remainingDeviceCount: number }> {
  const deviceIdB64 = Buffer.from(deviceId, "utf8").toString("base64");
  const script = `
cat > /tmp/agentprobe-unpair.js <<'UNPAIR_EOF'
const fs = require("fs");
const p = "/data/.openclaw/devices/paired.json";
const target = Buffer.from(process.argv[2], "base64").toString("utf8");
let obj = {};
try {
  obj = JSON.parse(fs.readFileSync(p, "utf8"));
} catch {
  // paired.json doesn't exist yet — nothing to remove.
  console.log("AGENTPROBE_UNPAIR=" + JSON.stringify({ removed: false, remainingDeviceCount: 0 }));
  process.exit(0);
}
const existed = Object.prototype.hasOwnProperty.call(obj, target);
if (existed) {
  delete obj[target];
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
console.log("AGENTPROBE_UNPAIR=" + JSON.stringify({
  removed: existed,
  remainingDeviceCount: Object.keys(obj).length
}));
UNPAIR_EOF
node /tmp/agentprobe-unpair.js ${deviceIdB64}
rm -f /tmp/agentprobe-unpair.js
`.trim();

  const { stdout, stderr, code } = await runRemoteCommand(coords, script, 30_000);
  if (code !== 0) {
    throw new Error(
      `openclaw unpair failed (exit ${code}): ${(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(" ")}`,
    );
  }
  const match = stdout.match(/AGENTPROBE_UNPAIR=(\{.*\})/);
  if (!match || !match[1]) {
    throw new Error("openclaw unpair produced no parseable output");
  }
  const parsed = JSON.parse(match[1]) as {
    removed: boolean;
    remainingDeviceCount: number;
  };
  return parsed;
}

/**
 * Check whether a given deviceId is present in the gateway's paired.json.
 * Read-only. Used to render pairing status in the Setup tab.
 */
export async function checkOpenClawPairingStatus(
  coords: RailwayCoordinates,
  deviceId: string,
): Promise<{ paired: boolean; totalPairedDevices: number }> {
  const deviceIdB64 = Buffer.from(deviceId, "utf8").toString("base64");
  const script = `
cat > /tmp/agentprobe-check-pair.js <<'CHECK_EOF'
const fs = require("fs");
const p = "/data/.openclaw/devices/paired.json";
const target = Buffer.from(process.argv[2], "base64").toString("utf8");
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const paired = Object.prototype.hasOwnProperty.call(obj, target);
console.log("AGENTPROBE_PAIR_STATUS=" + JSON.stringify({
  paired,
  totalPairedDevices: Object.keys(obj).length
}));
CHECK_EOF
node /tmp/agentprobe-check-pair.js ${deviceIdB64}
rm -f /tmp/agentprobe-check-pair.js
`.trim();

  const { stdout, stderr, code } = await runRemoteCommand(coords, script, 20_000);
  if (code !== 0) {
    throw new Error(
      `openclaw pair-status check failed (exit ${code}): ${(stderr || stdout).trim().slice(-200)}`,
    );
  }
  const match = stdout.match(/AGENTPROBE_PAIR_STATUS=(\{.*\})/);
  if (!match || !match[1]) {
    throw new Error("openclaw pair-status produced no parseable output");
  }
  return JSON.parse(match[1]) as {
    paired: boolean;
    totalPairedDevices: number;
  };
}

/**
 * Run a trivial `hermes chat` round-trip from inside the container. If
 * the reply starts with the expected sentinel, we've proven the Hermes
 * shell-out transport works without writing a full adapter instance.
 */
export async function testHermesEcho(
  coords: RailwayCoordinates,
): Promise<{ text: string }> {
  const script = `/usr/local/bin/hermes chat -q 'reply with exactly: AGENTPROBE_HERMES_OK' -Q --source tool --yolo 2>&1`;
  const { stdout, stderr, code } = await runRemoteCommand(coords, script, 120_000);
  if (code !== 0) {
    throw new Error(
      `hermes test exited with code ${code}: ${(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(" ")}`,
    );
  }
  if (!stdout.includes("AGENTPROBE_HERMES_OK")) {
    throw new Error(
      `hermes test reply did not contain sentinel. First 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  return { text: "AGENTPROBE_HERMES_OK" };
}

// -------- .env persistence --------

/**
 * Upsert keys into a .env file in-place. Creates the file if absent,
 * preserves existing unrelated lines and comments, and replaces the first
 * occurrence of each key. Values are written verbatim — the caller is
 * responsible for any escaping (UUIDs and URLs don't need it).
 */
export function updateDotEnv(
  envPath: string,
  updates: Record<string, string>,
): void {
  const lines = existsSync(envPath)
    ? readFileSync(envPath, "utf8").split(/\r?\n/)
    : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m && m[1] && updates[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      out.push(`${key}=${value}`);
    }
  }
  writeFileSync(envPath, out.filter((l, i) => !(i === out.length - 1 && l === "")).join("\n") + "\n", { encoding: "utf8" });
}

/**
 * Load or generate the pairing private key used for OpenClaw. The key
 * stays on disk at `.agentprobe-keys/openclaw-ed25519.pem` — same path
 * the CLI smoke script reads — so CLI and web share one identity.
 */
export function ensureOpenClawPairingKey(keyPath: string): DeviceKeyMaterial {
  if (existsSync(keyPath)) {
    return loadDeviceKey(readFileSync(keyPath, "utf8"));
  }
  const dir = keyPath.replace(/[\\/][^\\/]+$/, "");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = generateDeviceKey();
  writeFileSync(keyPath, key.privateKeyPem, { mode: 0o600 });
  return key;
}

// -------- step helper --------

/**
 * Run a function and wrap the result as a SetupStep. Never throws —
 * failures are captured in the step's status.
 */
export async function runStep<T>(
  id: string,
  label: string,
  fn: () => Promise<T> | T,
): Promise<{ step: SetupStep; value?: T }> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    return {
      step: {
        id,
        label,
        status: "ok",
        durationMs: Date.now() - startedAt,
      },
      value,
    };
  } catch (err) {
    return {
      step: {
        id,
        label,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      },
    };
  }
}
