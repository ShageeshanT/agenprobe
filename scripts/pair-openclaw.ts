/**
 * One-time pairing for AgentProbe against an OpenClaw instance.
 *
 * What it does:
 *   1. Generate an Ed25519 keypair (or reuse an existing one on disk).
 *   2. Compute the gateway's deviceId = sha256hex(rawPublicKey).
 *   3. SSH into the container via `railway ssh` and merge a new device
 *      record into /data/.openclaw/devices/paired.json with full operator
 *      scopes.
 *   4. Print the resulting deviceId so the smoke test can use it.
 *
 * Key material is stored under .agentprobe-keys/ (gitignored). Re-running
 * the script is idempotent: it preserves the existing key and overwrites
 * the device record with the current metadata.
 *
 * Usage:
 *   pnpm tsx scripts/pair-openclaw.ts
 *
 * Required env:
 *   RAILWAY_PROJECT, RAILWAY_ENVIRONMENT, RAILWAY_SERVICE
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import {
  generateDeviceKey,
  loadDeviceKey,
  type DeviceKeyMaterial,
} from "../src/adapters/openclaw-device-auth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");
const KEYS_DIR = join(PROJECT_ROOT, ".agentprobe-keys");
const PRIVATE_KEY_PATH = join(KEYS_DIR, "openclaw-ed25519.pem");

const DEVICE_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

function loadOrCreateKey(): DeviceKeyMaterial {
  if (existsSync(PRIVATE_KEY_PATH)) {
    const pem = readFileSync(PRIVATE_KEY_PATH, "utf8");
    return loadDeviceKey(pem);
  }
  const key = generateDeviceKey();
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(PRIVATE_KEY_PATH, key.privateKeyPem, { mode: 0o600 });
  console.log(`-> generated new Ed25519 keypair at ${PRIVATE_KEY_PATH}`);
  return key;
}

function railwaySsh(command: string): string {
  const project = process.env.RAILWAY_PROJECT;
  const environment = process.env.RAILWAY_ENVIRONMENT;
  const service = process.env.RAILWAY_SERVICE;
  if (!project || !environment || !service) {
    throw new Error(
      "RAILWAY_PROJECT, RAILWAY_ENVIRONMENT, RAILWAY_SERVICE must be set in .env",
    );
  }
  // `shell: true` so Windows can resolve `railway.cmd`. We quote the args
  // ourselves since a shell is now interpreting the command line.
  const quoted = [
    "railway",
    "ssh",
    `--project=${project}`,
    `--environment=${environment}`,
    `--service=${service}`,
    quoteForShell(command),
  ].join(" ");
  return execFileSync(quoted, { encoding: "utf8", shell: true });
}

function quoteForShell(s: string): string {
  // Cross-platform-ish single-quote-safe quoting. Bash-style single quotes
  // work on Git Bash / MSYS and on POSIX. Railway CLI on Windows launches
  // cmd, but the inner command is forwarded as a single arg to SSH so the
  // remote shell (bash in the container) sees it correctly.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function injectDevice(key: DeviceKeyMaterial) {
  // Build the new device record to merge.
  const record = {
    deviceId: key.deviceId,
    publicKey: key.publicKeyRawBase64Url,
    platform: "node",
    clientId: "openclaw-probe",
    clientMode: "webchat",
    role: "operator",
    roles: ["operator"],
    scopes: DEVICE_SCOPES,
    deviceFamily: "agentprobe",
    name: "agentprobe",
    pairedAt: new Date().toISOString(),
  };

  // We write a short Node script and execute it inside the container so the
  // merge is atomic and we don't have to stream the whole paired.json back
  // and forth.
  const escaped = JSON.stringify(record).replace(/'/g, "'\\''");
  const remoteScript = `
node -e '
const fs = require("fs");
const p = "/data/.openclaw/devices/paired.json";
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const rec = ${escaped};
obj[rec.deviceId] = rec;
fs.writeFileSync(p, JSON.stringify(obj, null, 2));
console.log("paired devices after merge:", Object.keys(obj).length);
'
`.trim();

  console.log(`-> writing device ${key.deviceId} to paired.json via railway ssh ...`);
  const output = railwaySsh(remoteScript);
  console.log(output.trim());
}

async function main() {
  const key = loadOrCreateKey();
  console.log(`-> deviceId: ${key.deviceId}`);
  console.log(`-> publicKey (base64url raw): ${key.publicKeyRawBase64Url}`);
  injectDevice(key);
  console.log("-> pairing complete. Run: pnpm smoke");
}

main().catch((err) => {
  console.error("pair-openclaw failed:", err);
  process.exit(1);
});
