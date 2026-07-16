/**
 * Exhaustive unit coverage of api/rails/okx.ts branches that the HTTP tests
 * don't naturally hit: every verifyPayment rejection reason, buildChallenge's
 * unknown-route throw, and the credentialed settlement / status paths (behind
 * a mocked fetch, since this repo ships no OKX creds).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import {
  buildChallenge,
  buildPaymentRequirements,
  verifyPayment,
  okxPayGate,
  CLV_PAY_ROUTES,
  type PaymentRequirements,
  type PaymentPayload,
} from "../api/rails/okx";
import { PATHS } from "../config";
import type { NextFunction, Request, Response } from "express";

const GRADE = CLV_PAY_ROUTES["POST /api/grade"];
function req(): PaymentRequirements {
  return buildPaymentRequirements(GRADE, "https://x/api/grade");
}

const VALID_ADDR = "0x1111111111111111111111111111111111111111";
const OTHER_ADDR = "0x2222222222222222222222222222222222222222";

function payload(accepted: PaymentRequirements, overrideAuth: Partial<PaymentPayload["payload"]["authorization"]> = {}, signature = "0x00"): PaymentPayload {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    x402Version: 2,
    accepted,
    payload: {
      signature: signature as `0x${string}`,
      authorization: {
        from: VALID_ADDR,
        to: OTHER_ADDR,
        value: accepted.amount,
        validAfter: String(nowSec - 60),
        validBefore: String(nowSec + 3600),
        nonce: ("0x" + "ab".repeat(32)),
        ...overrideAuth,
      },
    },
  };
}

describe("buildChallenge", () => {
  it("throws for an unconfigured route key", () => {
    expect(() => buildChallenge("POST /api/nope", "https://x/api/nope")).toThrow(/no route config/);
  });
});

describe("okxPayGate — resource URL host fallback", () => {
  it("uses 'localhost' when the request carries no Host header", async () => {
    const gate = okxPayGate();
    // craft a paid-route request with no Host header and no X-PAYMENT so the
    // gate builds the 402 challenge, exercising `req.get('host') ?? 'localhost'`.
    const req = {
      method: "POST",
      path: "/api/grade",
      protocol: "http",
      originalUrl: "/api/grade",
      get: () => undefined,
      header: () => undefined,
    } as unknown as Request;
    let sentChallenge: { resource: { url: string } } | undefined;
    const res = {
      status() {
        return res;
      },
      set() {
        return res;
      },
      json(payload: { resource: { url: string } }) {
        sentChallenge = payload;
        return res;
      },
    } as unknown as Response & { json: (p: unknown) => unknown };
    const next = (() => {
      throw new Error("next should not be called for an unpaid paid-route request");
    }) as unknown as NextFunction;
    await gate(req, res, next);
    expect(sentChallenge?.resource.url).toBe("http://localhost/api/grade");
  });
});

describe("verifyPayment — rejection reasons", () => {
  it("scheme_mismatch", async () => {
    const required = req();
    const accepted = { ...required, scheme: "other" as unknown as "exact" };
    const r = await verifyPayment(payload(accepted), required);
    expect(r.invalidReason).toBe("scheme_mismatch");
  });

  it("network_mismatch", async () => {
    const required = req();
    const r = await verifyPayment(payload({ ...required, network: "eip155:1" }), required);
    expect(r.invalidReason).toBe("network_mismatch");
  });

  it("asset_mismatch", async () => {
    const required = req();
    const r = await verifyPayment(payload({ ...required, asset: OTHER_ADDR }), required);
    expect(r.invalidReason).toBe("asset_mismatch");
  });

  it("payto_mismatch", async () => {
    const required = req();
    const r = await verifyPayment(payload({ ...required, payTo: OTHER_ADDR }), required);
    expect(r.invalidReason).toBe("payto_mismatch");
  });

  it("malformed_payload when authorization.from is not an address", async () => {
    const required = req();
    const r = await verifyPayment(payload(required, { from: "not-an-address" }), required);
    expect(r.invalidReason).toBe("malformed_payload");
  });

  it("authorization_not_yet_valid", async () => {
    const required = req();
    const future = String(Math.floor(Date.now() / 1000) + 10_000);
    const r = await verifyPayment(payload(required, { validAfter: future }), required);
    expect(r.invalidReason).toBe("authorization_not_yet_valid");
  });

  it("authorization_expired", async () => {
    const required = req();
    const past = String(Math.floor(Date.now() / 1000) - 10_000);
    const r = await verifyPayment(payload(required, { validBefore: past }), required);
    expect(r.invalidReason).toBe("authorization_expired");
  });

  it("nonce_already_used", async () => {
    const required = req();
    const nonce = "0x" + "cd".repeat(32);
    const backup = fs.existsSync(PATHS.usedNonces) ? fs.readFileSync(PATHS.usedNonces) : null;
    try {
      fs.mkdirSync(PATHS.fixtures, { recursive: true });
      fs.writeFileSync(PATHS.usedNonces, JSON.stringify([nonce]));
      const r = await verifyPayment(payload(required, { nonce }), required);
      expect(r.invalidReason).toBe("nonce_already_used");
    } finally {
      if (backup) fs.writeFileSync(PATHS.usedNonces, backup);
      else if (fs.existsSync(PATHS.usedNonces)) fs.rmSync(PATHS.usedNonces);
    }
  });

  it("signature_invalid when recovery throws on a bogus signature", async () => {
    const required = req();
    const r = await verifyPayment(payload(required, {}, "0x" + "11".repeat(65)), required);
    expect(r.invalidReason).toBe("signature_invalid");
  });

  it("falls back to default asset name/version and throws on an unparseable network", async () => {
    // required.network has no numeric chain id and extra carries no name/version,
    // so the domain build exercises the `?? ASSET_NAME` / `?? ASSET_VERSION`
    // fallbacks and chainIdFromCaip2 throws -> caught as signature_invalid.
    const base = req();
    const required: PaymentRequirements = { ...base, network: "eip155:notanumber", extra: {} };
    const accepted: PaymentRequirements = { ...required };
    const r = await verifyPayment(payload(accepted), required);
    expect(r.invalidReason).toBe("signature_invalid");
  });
});

// ---------------------------------------------------------------------------
// Credentialed settlement / status — mocked fetch, fresh module with creds set.
// ---------------------------------------------------------------------------

async function importOkxWithCreds() {
  vi.resetModules();
  vi.stubEnv("OKX_API_KEY", "test-key");
  vi.stubEnv("OKX_SECRET_KEY", "test-secret");
  vi.stubEnv("OKX_PASSPHRASE", "test-pass");
  return import("../api/rails/okx");
}

function makePayload(okx: typeof import("../api/rails/okx")) {
  const required = okx.buildPaymentRequirements(okx.CLV_PAY_ROUTES["POST /api/grade"], "https://x/api/grade");
  const nowSec = Math.floor(Date.now() / 1000);
  const p: PaymentPayload = {
    x402Version: 2,
    accepted: required,
    payload: {
      signature: "0x00" as `0x${string}`,
      authorization: {
        from: VALID_ADDR,
        to: OTHER_ADDR,
        value: required.amount,
        validAfter: String(nowSec - 60),
        validBefore: String(nowSec + 3600),
        nonce: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0"),
      },
    },
  };
  return { required, p };
}

describe("settlePayment — with facilitator creds (mocked fetch)", () => {
  const noncesBackup = fs.existsSync(PATHS.usedNonces) ? fs.readFileSync(PATHS.usedNonces) : null;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    if (noncesBackup) fs.writeFileSync(PATHS.usedNonces, noncesBackup);
    else if (fs.existsSync(PATHS.usedNonces)) fs.rmSync(PATHS.usedNonces);
  });

  it("calls the facilitator and returns its confirmed receipt", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({ success: true, status: "success", transaction: "0xdeadbeef" }),
    })) as unknown as typeof fetch);
    const { required, p } = makePayload(okx);
    const receipt = await okx.settlePayment(p, required);
    expect(receipt.success).toBe(true);
    expect(receipt.status).toBe("success");
    expect(receipt.transaction).toBe("0xdeadbeef");
    expect(receipt.is_placeholder).toBe(false);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("defaults status/transaction when the facilitator omits them", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ success: true }) })) as unknown as typeof fetch);
    const { required, p } = makePayload(okx);
    const receipt = await okx.settlePayment(p, required);
    expect(receipt.status).toBe("pending");
    expect(receipt.transaction).toBe("");
  });

  it("falls back to an honest local_pending when the facilitator is unreachable", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    const { required, p } = makePayload(okx);
    const receipt = await okx.settlePayment(p, required);
    expect(receipt.success).toBe(false);
    expect(receipt.status).toBe("local_pending");
    expect(receipt.is_placeholder).toBe(true);
  });
});

describe("fetchSettleStatus — with facilitator creds (mocked fetch)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("queries GET /settle/status and reports it live", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ status: "confirmed" }) })) as unknown as typeof fetch);
    const r = await okx.fetchSettleStatus("0xnotlocal");
    expect(r.live).toBe(true);
    expect(r.status).toBe("confirmed");
    expect(r.source).toContain("Facilitator");
  });

  it("defaults to unknown when the facilitator omits status", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({}) })) as unknown as typeof fetch);
    const r = await okx.fetchSettleStatus("0xnotlocal");
    expect(r.status).toBe("unknown");
    expect(r.live).toBe(true);
  });

  it("reports unreachable when the status request fails", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch);
    const r = await okx.fetchSettleStatus("0xnotlocal");
    expect(r.live).toBe(false);
    expect(r.status).toBe("unreachable");
  });

  it("reads a matching local receipt from the receipt log", async () => {
    const okx = await importOkxWithCreds();
    const tx = `local:${"f".repeat(40)}`;
    const backup = fs.existsSync(PATHS.receiptLog) ? fs.readFileSync(PATHS.receiptLog) : null;
    try {
      okx.appendReceiptLog({ transaction: tx, payer: VALID_ADDR, network: "eip155:196", amount: "10000", is_placeholder: true, settled_at: new Date().toISOString() });
      const found = await okx.fetchSettleStatus(tx);
      expect(found.status).toBe("local_pending");
      const missing = await okx.fetchSettleStatus(`local:${"0".repeat(40)}`);
      expect(missing.status).toBe("not_found");
    } finally {
      if (backup) fs.writeFileSync(PATHS.receiptLog, backup);
      else if (fs.existsSync(PATHS.receiptLog)) fs.rmSync(PATHS.receiptLog);
    }
  });
});
