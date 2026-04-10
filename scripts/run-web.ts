/**
 * Start the AgentProbe web dashboard.
 *
 *   pnpm tsx scripts/run-web.ts            # default port 4000
 *   PORT=8080 pnpm tsx scripts/run-web.ts  # custom port
 */
import "dotenv/config";

import { startWebServer } from "../src/web/server.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

startWebServer({ port }).catch((err) => {
  console.error("web server failed to start:", err);
  process.exit(1);
});
