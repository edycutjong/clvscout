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
import { warmFacilitator } from "./rails/okx";
import { bazaarReadiness } from "./rails/cdp";
import { PORT, PAY_RAIL, X402_NETWORK, HAS_REAL_FACILITATOR_CREDS } from "../config";

const app = createApp();
app.listen(PORT, () => {
  console.log(`CLV Scout API on http://localhost:${PORT} (rail=${PAY_RAIL}, network=${X402_NETWORK})`);
  console.log(`  facilitator creds loaded: ${HAS_REAL_FACILITATOR_CREDS} (no creds = local-pending settlement, honestly labeled)`);
  console.log(`  try: curl -i -X POST http://localhost:${PORT}/api/grade`);
  // Prime the official SDK facilitator handshake at boot (non-blocking) so the
  // first paid call is warm and any cred/network error shows up here, not on a
  // buyer's request — see warmFacilitator(). Only when the okx rail is active.
  if (PAY_RAIL === "okx") void warmFacilitator();
  // Bazaar rail: print the remaining manual gates into the DEPLOY LOG rather
  // than discovering them weeks later — the CLV Scout listing lesson applied in
  // advance (find the platform's gates before the platform finds them for you).
  if (PAY_RAIL === "cdp") {
    const r = bazaarReadiness();
    console.log(`  x402 Bazaar rail — credentials ${r.ready ? "OK" : "MISSING"}; steps to a live listing:`);
    for (const step of r.steps) console.log(`    - ${step}`);
  }
});
