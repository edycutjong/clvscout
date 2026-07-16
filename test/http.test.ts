/**
 * HTTP-level invariants (ARCHITECTURE.md §Invariants 1 and 4):
 *  - unpaid POST to a paid route -> 402 with x402Version:2, before the grade
 *    engine ever runs.
 *  - GET on a POST-only paid route -> 405.
 *  - free endpoints (`/api/calibration`, `/api/me`, `/api/receipts/verify`)
 *    respond 200 with no payment headers, under all configs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import { createApp } from "../api/server";
import { PATHS } from "../config";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
  // test runs write buyer/receipt/nonce artifacts to fixtures/ — clean up so
  // repeated `npm test` runs don't accumulate them alongside the real seed data.
  for (const p of [PATHS.buyerStore, PATHS.receiptLog, PATHS.usedNonces]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe("POST /api/grade — unpaid", () => {
  it("returns 402 with x402Version:2 and an `exact` accepts entry", async () => {
    const res = await fetch(`${base}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match: "x", selection: "y", odds_taken: 1.9 }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.accepts[0].amount).toBe("10000"); // $0.01 @ 6dp
  });

  it("never reaches the grade engine when unpaid (no clv_grade in the 402 body)", async () => {
    const res = await fetch(`${base}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 }),
    });
    const body = (await res.json()) as any;
    expect("clv_grade" in body).toBe(false);
  });
});

describe("POST /api/audit — unpaid", () => {
  it("returns 402 with x402Version:2 and the $0.20 amount", async () => {
    const res = await fetch(`${base}/api/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bets: [] }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0].amount).toBe("200000"); // $0.20 @ 6dp
  });
});

describe("GET on POST-only paid routes -> 405", () => {
  it("GET /api/grade -> 405", async () => {
    const res = await fetch(`${base}/api/grade`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("GET /api/audit -> 405", async () => {
    const res = await fetch(`${base}/api/audit`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("free endpoints stay free (200, no X-PAYMENT needed)", () => {
  it("POST /api/calibration -> 200", async () => {
    const res = await fetch(`${base}/api/calibration`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.table)).toBe(true);
    expect(body.table).toHaveLength(6); // one row per grade, even n=0 ones
    expect(body.coverage).toBeDefined();
  });

  it("POST /api/me -> 200 for a never-seen address", async () => {
    const res = await fetch(`${base}/api/me`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "0xnobody" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.history).toEqual([]);
  });

  it("POST /api/receipts/verify -> 200, honestly labels a local/unconfigured facilitator", async () => {
    const res = await fetch(`${base}/api/receipts/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: "local:doesnotexist" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.live).toBe(false);
    expect(body.source).toContain("local");
  });
});

describe("400 on malformed paid-route bodies is impossible to observe unpaid", () => {
  it("a malformed body still gets 402 before validation (payment gate runs first)", async () => {
    const res = await fetch(`${base}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(402);
  });
});
