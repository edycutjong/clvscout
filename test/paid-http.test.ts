/**
 * End-to-end PAID round-trip against the real Express app: probe the 402
 * challenge, sign a genuine EIP-3009 TransferWithAuthorization, replay with
 * X-PAYMENT, and assert the handler output. This exercises the full
 * okxPayGate success path (decode -> verify -> local settle -> receipt log),
 * the paid grade/audit handlers (incl. BuyerLens + the `you` block), the demo
 * runner route, and every free-endpoint 400 branch.
 *
 * The server binds a FIXED port and API_BASE_URL is pointed at it (via a fresh
 * module import) so the server-side demo runner calls back into this same app.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const PORT = 4097;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Server;
let PATHS: typeof import("../config").PATHS;

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

/** Probe the paid route, sign a real EIP-3009 authorization, return an X-PAYMENT header. */
async function signPaymentHeader(path: string): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  const probe = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
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
  const payload = { x402Version: 2, accepted: required, payload: { signature, authorization } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

async function paidPost(path: string, body: unknown): Promise<Response> {
  const header = await signPaymentHeader(path);
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": header },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  vi.stubEnv("API_BASE_URL", BASE);
  vi.resetModules();
  const { createApp } = await import("../api/server");
  ({ PATHS } = await import("../config"));
  const app = createApp();
  server = app.listen(PORT);
  await new Promise<void>((resolve) => server.once("listening", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  for (const p of [PATHS.buyerStore, PATHS.receiptLog, PATHS.usedNonces]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe("paid POST /api/grade", () => {
  it("returns 200 with a grade + the buyer `you` block after a real payment", async () => {
    const res = await paidPost("/api/grade", { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 });
    expect(res.status).toBe(200);
    // the settle receipt is echoed as a base64 X-PAYMENT-RESPONSE header
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    const body = (await res.json()) as { clv_grade: string; you: { your_grades: number } };
    expect(body.clv_grade).not.toBe("UNGRADED");
    expect(body.you.your_grades).toBeGreaterThanOrEqual(1);
  });

  it("returns UNGRADED (still 200) for a market with no recorded close", async () => {
    const res = await paidPost("/api/grade", { match: "Nobody vs Noone", selection: "Nobody ML", odds_taken: 2.0 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clv_grade: string };
    expect(body.clv_grade).toBe("UNGRADED");
  });

  it("returns a 200 usage response for a paid-but-malformed body (agent-runtime friendly)", async () => {
    const res = await paidPost("/api/grade", { nonsense: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; example_request: unknown };
    expect(body.service).toBe("CLV Grade");
    expect(body.example_request).toBeTruthy();
  });
});

describe("paid POST /api/audit", () => {
  it("returns 200 with a full dossier after a real payment", async () => {
    const res = await paidPost("/api/audit", {
      bets: [
        { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 },
        { match: "GER vs JPN", selection: "Germany ML", odds_taken: 1.75 },
      ],
      label: "e2e",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sharp_score: { value: number }; label: string };
    expect(body.label).toBe("e2e");
    expect(typeof body.sharp_score.value).toBe("number");
  });

  it("returns a 200 usage response for a paid-but-invalid audit body (empty bets)", async () => {
    const res = await paidPost("/api/audit", { bets: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe("CLV Audit");
  });
});

describe("okxPayGate — rejection branches", () => {
  it("402 malformed_payment_header when X-PAYMENT is not decodable", async () => {
    const res = await fetch(`${BASE}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": "!!!not-base64-json!!!" },
      body: "{}",
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("malformed_payment_header");
  });

  it("402 with an invalidReason when the signature does not verify", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const probe = await fetch(`${BASE}/api/grade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const challenge = (await probe.json()) as { accepts: { payTo: string; amount: string; network: string; asset: string; extra: Record<string, string> }[] };
    const required = challenge.accepts[0];
    const nowSec = Math.floor(Date.now() / 1000);
    const authorization = {
      from: account.address,
      to: required.payTo,
      value: required.amount,
      validAfter: String(nowSec - 60),
      validBefore: String(nowSec + 3600),
      nonce: randomNonce(),
    };
    // deliberately-bogus signature (well-formed hex, wrong signer) -> recovery mismatch
    const bogus = ("0x" + "11".repeat(65)) as `0x${string}`;
    const header = Buffer.from(
      JSON.stringify({ x402Version: 2, accepted: required, payload: { signature: bogus, authorization } }),
    ).toString("base64");
    const res = await fetch(`${BASE}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": header },
      body: "{}",
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("signature_invalid");
  });
});

describe("free endpoints — forget + validation branches", () => {
  it("POST /api/me {forget:true} deletes the caller's rows", async () => {
    // seed a row for a known address via a paid grade, then forget it
    const account = privateKeyToAccount(generatePrivateKey());
    const header = await signPaymentHeader("/api/grade");
    // decode header to learn the payer address the server will key on
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload: { authorization: { from: string } };
    };
    const payer = decoded.payload.authorization.from;
    await fetch(`${BASE}/api/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 }),
    });
    void account;

    const before = await (await fetch(`${BASE}/api/me`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: payer }),
    })).json();
    expect((before as { count: number }).count).toBeGreaterThanOrEqual(1);

    const res = await fetch(`${BASE}/api/me`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: payer, forget: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/me with a bad body -> 400", async () => {
    const res = await fetch(`${BASE}/api/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });

  it("POST /api/receipts/verify with a bad body -> 400", async () => {
    const res = await fetch(`${BASE}/api/receipts/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });

  it("POST /api/receipts/verify with a non-local txHash + no creds -> unknown/not-live", async () => {
    const res = await fetch(`${BASE}/api/receipts/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: "0xabc123nonlocal" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; live: boolean; explorer_url: string };
    expect(body.live).toBe(false);
    expect(body.status).toBe("unknown");
    expect(body.explorer_url).toContain("/tx/0xabc123nonlocal"); // EXPLORER_URL_FOR non-local branch
  });
});

describe("server plumbing — CORS + index", () => {
  it("OPTIONS preflight -> 204 with CORS headers", async () => {
    const res = await fetch(`${BASE}/api/grade`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET /api -> service index", async () => {
    const res = await fetch(`${BASE}/api`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe("clvscout-api");
  });

  it("GET /health -> ok", async () => {
    const res = await fetch(`${BASE}/health`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("demo route -> real server-side round-trip", () => {
  it("POST /api/demo/run {route:grade} -> 200 with a real paid result", async () => {
    const res = await fetch(`${BASE}/api/demo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "grade", body: { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paid_status: number; route: string };
    expect(body.route).toBe("grade");
    expect(body.paid_status).toBe(200);
  });

  it("POST /api/demo/run with a bad body -> 400", async () => {
    const res = await fetch(`${BASE}/api/demo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "not-a-route" }),
    });
    expect(res.status).toBe(400);
  });
});
