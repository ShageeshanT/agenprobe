/**
 * Smoke test: open a WebSocket against the real OpenClaw bot, complete the
 * handshake, send one message, print the reply. No test framework, no
 * scenario engine — just proof the adapter reaches the bot end-to-end.
 *
 * Run: pnpm tsx scripts/smoke-openclaw.ts "your message"
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import { OpenClawAdapter } from "../src/adapters/openclaw-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_PATH = join(HERE, "..", ".agentprobe-keys", "openclaw-ed25519.pem");

async function main() {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) {
    console.error("OPENCLAW_GATEWAY_URL is not set. Copy .env.example to .env first.");
    process.exit(2);
  }

  const message = process.argv.slice(2).join(" ") || "ping from agentprobe smoke test";

  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  const devicePrivateKeyPem = existsSync(DEFAULT_KEY_PATH)
    ? readFileSync(DEFAULT_KEY_PATH, "utf8")
    : undefined;
  if (!devicePrivateKeyPem) {
    console.warn(
      `-> no device key at ${DEFAULT_KEY_PATH}; handshake will likely succeed but chat.send will fail. Run: pnpm tsx scripts/pair-openclaw.ts`,
    );
  }

  const adapter = new OpenClawAdapter({
    gatewayUrl,
    agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
    clientName: "agentprobe-smoke",
    ...(token ? { token } : {}),
    ...(devicePrivateKeyPem ? { devicePrivateKeyPem } : {}),
  });

  console.log(`-> connecting to ${gatewayUrl} ...`);
  try {
    await adapter.connect();
  } catch (err) {
    console.error("handshake failed:", err);
    process.exit(1);
  }
  console.log("-> handshake ok");

  console.log(`-> sending: ${JSON.stringify(message)}`);
  try {
    const reply = await adapter.sendMessage({ text: message });
    console.log(`-> reply (${reply.responseTimeMs}ms):`);
    console.log(reply.text || "(empty)");
    if (reply.events.length > 0) {
      console.log(`-> ${reply.events.length} intermediate events:`);
      for (const ev of reply.events) {
        console.log(`   [${ev.offsetMs}ms] ${ev.type}`);
        const json = JSON.stringify(ev.payload, null, 2);
        if (json && json !== "undefined") {
          console.log(
            json
              .split("\n")
              .map((l) => "      " + l)
              .join("\n"),
          );
        }
      }
    }
    console.log("-> raw final payload:");
    console.log(JSON.stringify(reply.raw, null, 2).slice(0, 2000));
  } catch (err) {
    console.error("sendMessage failed:", err);
    process.exitCode = 1;
  } finally {
    await adapter.disconnect();
  }
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
