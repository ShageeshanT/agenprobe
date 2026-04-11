/**
 * One-time pairing script for an OpenClaw instance reached via `railway
 * ssh`. Delegates to the same helpers the in-browser setup wizard uses,
 * so the CLI and UI are now bug-for-bug identical. No more hand-rolled
 * quoting, no more Windows shell-escape traps.
 *
 * Usage:
 *   pnpm tsx scripts/pair-openclaw.ts                    # uses .env
 *   pnpm tsx scripts/pair-openclaw.ts "railway ssh ..."  # parse an ssh command
 *
 * Required env (first form): RAILWAY_PROJECT, RAILWAY_ENVIRONMENT,
 * RAILWAY_SERVICE.
 *
 * What this does, in order:
 *   1. Parse or read Railway coordinates.
 *   2. Load or generate the Ed25519 pairing key at
 *      .agentprobe-keys/openclaw-ed25519.pem (same path the web UI uses,
 *      so CLI and web share one identity).
 *   3. Merge an AgentProbe device record into the bot's
 *      /data/.openclaw/devices/paired.json with full operator scopes.
 *      Idempotent — replaces the record if the deviceId already exists.
 *   4. Print the resulting deviceId so the smoke test can refer to it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import {
  ensureOpenClawPairingKey,
  pairOpenClawDevice,
  parseRailwaySshCommand,
  type RailwayCoordinates,
} from "../src/core/setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");
const PRIVATE_KEY_PATH = join(
  PROJECT_ROOT,
  ".agentprobe-keys",
  "openclaw-ed25519.pem",
);

function coordsFromEnv(): RailwayCoordinates {
  const project = process.env.RAILWAY_PROJECT;
  const environment = process.env.RAILWAY_ENVIRONMENT;
  const service = process.env.RAILWAY_SERVICE;
  if (!project || !environment || !service) {
    throw new Error(
      "RAILWAY_PROJECT, RAILWAY_ENVIRONMENT, RAILWAY_SERVICE must be set in .env (or pass the full railway ssh command as an argument).",
    );
  }
  return { project, environment, service };
}

function coordsFromArgs(): RailwayCoordinates | undefined {
  const argv = process.argv.slice(2).join(" ").trim();
  if (!argv || !argv.startsWith("railway")) return undefined;
  return parseRailwaySshCommand(argv);
}

async function main() {
  const coords = coordsFromArgs() ?? coordsFromEnv();
  console.log(`-> target: ${coords.project.slice(0, 8)}… / ${coords.environment.slice(0, 8)}… / ${coords.service.slice(0, 8)}…`);

  const key = ensureOpenClawPairingKey(PRIVATE_KEY_PATH);
  console.log(`-> deviceId: ${key.deviceId}`);
  console.log(`-> publicKey (base64url raw): ${key.publicKeyRawBase64Url}`);
  console.log(`-> key at: ${PRIVATE_KEY_PATH}`);

  console.log(`-> installing device record into /data/.openclaw/devices/paired.json ...`);
  await pairOpenClawDevice(coords, key);

  console.log(`-> pairing complete.`);
  console.log();
  console.log(`Next: npm run smoke`);
}

main().catch((err) => {
  console.error("pair-openclaw failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
