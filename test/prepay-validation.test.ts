/**
 * ARCHITECTURE invariant 5 — VALIDATION BEFORE PAYMENT.
 *
 * OKX.AI listing review requires that parameter validation "be completed
 * before returning the x402 payment pending signature information
 * (challenge)": a buyer must never sign, and must never be deducted, for a
 * call that was always going to fail on its parameters.
 *
 * This suite pins the three cases decided by `api/validate.ts::paramPreflight`:
 *
 *   1. discovery  — unpaid, param-less GET  -> 402 + PAYMENT-REQUIRED challenge
 *   2. bad params — anything else invalid   -> 400, no challenge, no settlement
 *   3. good params                          -> 402 challenge, then paid 200
 *
 * The decisive test is the last one: a genuinely signed payment presented with
 * an invalid body is rejected 400 AND its authorization nonce is left unspent,
 * so the very same signature still buys a real result afterwards. That is
 * proof the buyer was not charged for the error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createApp } from "../api/server";
import { PATHS } from "../config";

let server: Server;
let base: string;

const VALID_GRADE = { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 };
const VALID_AUDIT = { bets: [{ match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 }] };

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

/** Probe with a VALID body, sign the real challenge, return an X-PAYMENT header. */
async function signPaymentHeader(path: string, probeBody: unknown): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  const probe = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(probeBody),
  });
  expect(probe.status).toBe(402);
  const challenge = (await probe.json()) as {
    accepts: { network: string; asset: string; amount: string; payTo: string; extra: Record<string, string> }[];
  };
  const required = challenge.accepts[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: required.payTo as `0x${string}`,
    value: required.amount,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 3600),
    nonce: randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: {
      name: required.extra.name,
      version: required.extra.version,
      chainId: Number(required.network.split(":")[1]),
      verifyingContract: required.asset as `0x${string}`,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return Buffer.from(
    JSON.stringify({ x402Version: 2, accepted: required, payload: { signature, authorization } }),
  ).toString("base64");
}

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const p of [PATHS.buyerStore, PATHS.receiptLog, PATHS.usedNonces]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe("case 1 — the marketplace discovery probe still gets a real challenge", () => {
  it("GET /api/grade with no params -> 402 + PAYMENT-REQUIRED", async () => {
    const res = await fetch(`${base}/api/grade`);
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const body = (await res.json()) as { x402Version: number; accepts: { amount: string }[] };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0].amount).toBe("10000");
  });

  it("GET /api/audit with no params -> 402 + PAYMENT-REQUIRED", async () => {
    const res = await fetch(`${base}/api/audit`);
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });
});

describe("case 2 — invalid params are rejected BEFORE any challenge is issued", () => {
  const badGrade: [string, unknown][] = [
    ["empty body", {}],
    ["unrelated keys", { nonsense: true }],
    ["missing odds_taken", { match: "BRA vs SRB", selection: "Brazil ML" }],
    ["missing selection", { match: "BRA vs SRB", odds_taken: 1.55 }],
    ["blank match", { match: "", selection: "Brazil ML", odds_taken: 1.55 }],
    ["odds below 1.0", { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 0.4 }],
    ["non-numeric odds", { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: "evens" }],
  ];

  for (const [label, body] of badGrade) {
    it(`POST /api/grade (${label}) -> 400, no challenge`, async () => {
      const res = await fetch(`${base}/api/grade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
      const json = (await res.json()) as { error: string; service: string; required: string[]; payment: string };
      expect(json.error).toBe("invalid_request");
      expect(json.service).toBe("CLV Grade");
      expect(json.required).toContain("odds_taken");
      expect(json.payment).toMatch(/nothing was deducted/i);
    });
  }

  const badAudit: [string, unknown][] = [
    ["empty body", {}],
    ["empty bets", { bets: [] }],
    ["bets not an array", { bets: "BRA vs SRB" }],
    ["a bet missing odds_taken", { bets: [{ match: "BRA vs SRB", selection: "Brazil ML" }] }],
    ["over the 25-bet cap", { bets: Array.from({ length: 26 }, () => VALID_AUDIT.bets[0]) }],
  ];

  for (const [label, body] of badAudit) {
    it(`POST /api/audit (${label}) -> 400, no challenge`, async () => {
      const res = await fetch(`${base}/api/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect(((await res.json()) as { service: string }).service).toBe("CLV Audit");
    });
  }

  it("GET /api/grade with invalid query params -> 400, no challenge", async () => {
    const res = await fetch(`${base}/api/grade?match=BRA%20vs%20SRB&odds_taken=1.55`); // no selection
    expect(res.status).toBe(400);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });
});

describe("preflight edge cases", () => {
  it("a trailing-slash path is still gated (/api/grade/ with bad params -> 400)", async () => {
    const res = await fetch(`${base}/api/grade/?match=BRA%20vs%20SRB`);
    expect(res.status).toBe(400);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("a non-object JSON body (array) counts as no params -> 400, not a crash", async () => {
    const res = await fetch(`${base}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([VALID_GRADE]),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("an unparseable `bets` query string is rejected as invalid params, not a crash", async () => {
    const res = await fetch(`${base}/api/audit?bets=%7Bnot-json`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { service: string }).service).toBe("CLV Audit");
  });

  it("free routes are untouched by the preflight", async () => {
    const res = await fetch(`${base}/api/calibration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});

describe("case 3 — valid params get the challenge, and a paid call settles", () => {
  it("POST /api/grade with valid params -> 402 challenge, then 200 on the paid replay", async () => {
    const header = await signPaymentHeader("/api/grade", VALID_GRADE);
    const paid = await fetch(`${base}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify(VALID_GRADE),
    });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
  });

  it("GET /api/audit with valid query params -> 402 challenge (bets ride as a JSON string)", async () => {
    const qs = new URLSearchParams({ bets: JSON.stringify(VALID_AUDIT.bets) }).toString();
    const res = await fetch(`${base}/api/audit?${qs}`);
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });
});

describe("the deduction guarantee — a signed payment is not spent on an invalid call", () => {
  it("400s the invalid call, leaves the nonce unspent, and the SAME signature still buys a grade", async () => {
    const header = await signPaymentHeader("/api/grade", VALID_GRADE);

    // present the genuine, verifiable payment alongside an invalid body
    const rejected = await fetch(`${base}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ match: "BRA vs SRB" }), // selection + odds_taken missing
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
    expect(rejected.headers.get("PAYMENT-RESPONSE")).toBeNull();

    // the authorization was never verified or settled, so it is still spendable:
    // had the rejected call settled, the facilitator would answer `nonce_reused`.
    const accepted = await fetch(`${base}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify(VALID_GRADE),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    const body = (await accepted.json()) as { clv_grade: string };
    expect(body.clv_grade).not.toBe("UNGRADED");
  });
});
