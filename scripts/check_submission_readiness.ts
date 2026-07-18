/**
 * npm run readiness — boots the app on an ephemeral port and runs the exact
 * self-check the listing gate requires (PRODUCTION_PLAN.md §Test & quality
 * targets): unpaid POST 402 shape, unpaid GET 402 (OKX's review probe is a
 * GET), free-endpoint 200s, plus the
 * honesty gates (no synthetic closes is structural — checked by the UNGRADED
 * test suite, not here; this script checks the wire-level gate).
 */
import { createApp } from "../api/server";
import { truthTableSum } from "../engine/grade";
import { loadOrBuildSettledLedger } from "../db/ledger";

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind");
  const base = `http://127.0.0.1:${address.port}`;

  const failures: string[] = [];

  const grade402 = await fetch(`${base}/api/grade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const grade402Body = (await grade402.json()) as { x402Version?: number };
  if (grade402.status !== 402) failures.push(`POST /api/grade unpaid expected 402, got ${grade402.status}`);
  if (grade402Body.x402Version !== 2) failures.push(`POST /api/grade 402 body missing x402Version:2`);

  const audit402 = await fetch(`${base}/api/audit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const audit402Body = (await audit402.json()) as { x402Version?: number };
  if (audit402.status !== 402) failures.push(`POST /api/audit unpaid expected 402, got ${audit402.status}`);
  if (audit402Body.x402Version !== 2) failures.push(`POST /api/audit 402 body missing x402Version:2`);

  const gradeGet = await fetch(`${base}/api/grade`, { method: "GET" });
  if (gradeGet.status !== 402) failures.push(`GET /api/grade unpaid expected 402, got ${gradeGet.status}`);
  if (!gradeGet.headers.get("payment-required")) failures.push("GET /api/grade 402 missing PAYMENT-REQUIRED header");

  const calibration = await fetch(`${base}/api/calibration`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (calibration.status !== 200) failures.push(`POST /api/calibration expected 200, got ${calibration.status}`);
  const calibrationBody = (await calibration.json()) as { coverage?: unknown };
  if (!calibrationBody.coverage) failures.push("POST /api/calibration missing coverage statement");

  const me = await fetch(`${base}/api/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: "0x0" }) });
  if (me.status !== 200) failures.push(`POST /api/me expected 200, got ${me.status}`);

  const receipts = await fetch(`${base}/api/receipts/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash: "local:doesnotexist" }) });
  if (receipts.status !== 200) failures.push(`POST /api/receipts/verify expected 200, got ${receipts.status}`);

  const { truthTable, rows } = loadOrBuildSettledLedger();
  const sum = truthTableSum(truthTable);
  if (sum !== rows.length) failures.push(`truth-table sum ${sum} != settled ledger count ${rows.length}`);

  server.close();

  if (failures.length) {
    console.error("READINESS: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("READINESS: PASS — 402 shape both paid routes (POST + GET probe), free endpoints 200, truth-table sums OK");
}

main();
