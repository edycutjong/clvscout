/**
 * api/main.ts — the CLI bootstrap (`npm run api` / `npm run dev`).
 *
 * Thin entrypoint: it only wires the tested `createApp()` (api/server.ts) to a
 * listening socket and prints the boot banner. There is no branching logic
 * here to unit-test — driving it would mean actually binding the port and
 * capturing stdout — so, like `scripts/**`, it is excluded from coverage in
 * vitest.config.ts. All app behavior lives in `createApp()` and is covered by
 * the API/HTTP tests.
 */
import { createApp } from "./server";
import { PORT, PAY_RAIL, X402_NETWORK, HAS_REAL_FACILITATOR_CREDS } from "../config";

const app = createApp();
app.listen(PORT, () => {
  console.log(`CLV Scout API on http://localhost:${PORT} (rail=${PAY_RAIL}, network=${X402_NETWORK})`);
  console.log(`  facilitator creds loaded: ${HAS_REAL_FACILITATOR_CREDS} (no creds = local-pending settlement, honestly labeled)`);
  console.log(`  try: curl -i -X POST http://localhost:${PORT}/api/grade`);
});
