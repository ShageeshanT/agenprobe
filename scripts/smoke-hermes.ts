/**
 * Smoke test for the Hermes adapter. Sends one message via `railway ssh`
 * + `hermes chat -q ... -Q --source tool --yolo` and prints the reply.
 *
 * Run: pnpm tsx scripts/smoke-hermes.ts "your message"
 */
import "dotenv/config";

import { HermesAdapter } from "../src/adapters/hermes-adapter.js";

async function main() {
  const project = process.env.HERMES_RAILWAY_PROJECT;
  const environment = process.env.HERMES_RAILWAY_ENVIRONMENT;
  const service = process.env.HERMES_RAILWAY_SERVICE;

  if (!project || !environment || !service) {
    console.error(
      "HERMES_RAILWAY_PROJECT, HERMES_RAILWAY_ENVIRONMENT, HERMES_RAILWAY_SERVICE must be set. See .env.example.",
    );
    process.exit(2);
  }

  const message =
    process.argv.slice(2).join(" ") || "ping from agentprobe hermes smoke test";

  const adapter = new HermesAdapter({
    railwayProject: project,
    railwayEnvironment: environment,
    railwayService: service,
  });

  console.log(`-> hermes preflight via railway ssh ...`);
  try {
    await adapter.connect();
  } catch (err) {
    console.error("preflight failed:", err);
    process.exit(1);
  }
  console.log("-> preflight ok");

  console.log(`-> sending: ${JSON.stringify(message)}`);
  try {
    const reply = await adapter.sendMessage({ text: message });
    console.log(`-> reply (${reply.responseTimeMs}ms):`);
    console.log(reply.text || "(empty)");
    const raw = reply.raw as { hermesSessionId?: string };
    if (raw?.hermesSessionId) {
      console.log(`-> hermes session_id: ${raw.hermesSessionId}`);
    }
  } catch (err) {
    console.error("sendMessage failed:", err);
    process.exitCode = 1;
  } finally {
    await adapter.disconnect();
  }
}

main().catch((err) => {
  console.error("smoke-hermes crashed:", err);
  process.exit(1);
});
