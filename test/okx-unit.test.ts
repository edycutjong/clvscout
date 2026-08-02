/**
 * Exhaustive unit coverage of the OFFICIAL-SDK payment rail (api/rails/okx.ts)
 * and its local-faithful facilitator (api/rails/localFacilitator.ts) branches
 * that the HTTP tests don't naturally hit: every LocalFacilitatorClient verify
 * rejection reason, the honest local settle receipt, facilitator selection, the
 * credentialed fetchSettleStatus paths (mocked fetch), and warmFacilitator's
 * boot self-check. All signatures use real viem accounts — no crypto is faked.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { authorizationTypes } from "@okxweb3/x402-evm";
import { LocalFacilitatorClient } from "../api/rails/localFacilitator";
import { buildFacilitatorClient, fetchSettleStatus, quoteSummary } from "../api/rails/okx";
import { X402_NETWORK, USDT0_ADDRESS, PAYTO_ADDRESS, ASSET_NAME, ASSET_VERSION } from "../config";

const BASE_REQ = {
  scheme: "exact",
  network: X402_NETWORK,
  asset: USDT0_ADDRESS,
  amount: "10000",
  payTo: PAYTO_ADDRESS,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: ASSET_NAME, version: ASSET_VERSION },
} as const;

let nonceCounter = 0;
const rand = () => ("0x" + (nonceCounter++).toString(16).padStart(64, "b")) as `0x${string}`;

async function sign(
  pk: `0x${string}`,
  opts: { from?: `0x${string}`; to?: `0x${string}`; value?: string; nonce?: `0x${string}`; domain?: { chainId?: number } } = {},
) {
  const account = privateKeyToAccount(pk);
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: opts.from ?? account.address,
    to: opts.to ?? (PAYTO_ADDRESS as `0x${string}`),
    value: opts.value ?? BASE_REQ.amount,
    validAfter: String(now - 60),
    validBefore: String(now + 120),
    nonce: opts.nonce ?? rand(),
  };
  const signature = await account.signTypedData({
    domain: {
      name: ASSET_NAME,
      version: ASSET_VERSION,
      chainId: opts.domain?.chainId ?? Number(X402_NETWORK.split(":")[1]),
      verifyingContract: USDT0_ADDRESS as `0x${string}`,
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
  return { auth, signature, address: account.address };
}

const fac = () => new LocalFacilitatorClient();

describe("LocalFacilitatorClient.verify — rejection reasons", () => {
  it("missing signature → invalid_payload", async () => {
    const { auth } = await sign(generatePrivateKey());
    const r = await fac().verify({ payload: { authorization: auth } } as never, BASE_REQ as never);
    expect(r.invalidReason).toBe("invalid_payload");
  });

  it("authorization outside its time window → expired", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const past = String(Math.floor(Date.now() / 1000) - 10_000);
    const auth = { from: account.address, to: PAYTO_ADDRESS, value: BASE_REQ.amount, validAfter: "0", validBefore: past, nonce: rand() };
    const r = await fac().verify({ payload: { authorization: auth, signature: "0x00" } } as never, BASE_REQ as never);
    expect(r.invalidReason).toBe("expired");
  });

  it("authorization.to != payTo → wrong_payee", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const { auth, signature } = await sign(generatePrivateKey(), { to: other });
    const r = await fac().verify({ payload: { authorization: auth, signature } } as never, BASE_REQ as never);
    expect(r.invalidReason).toBe("wrong_payee");
  });

  it("value below required amount → insufficient_value", async () => {
    const { auth, signature } = await sign(generatePrivateKey(), { value: "1" });
    const r = await fac().verify({ payload: { authorization: auth, signature } } as never, BASE_REQ as never);
    expect(r.invalidReason).toBe("insufficient_value");
  });

  it("recovered signer != authorization.from → signature_mismatch", async () => {
    const impersonated = privateKeyToAccount(generatePrivateKey()).address;
    const { auth, signature } = await sign(generatePrivateKey(), { from: impersonated });
    const r = await fac().verify({ payload: { authorization: auth, signature } } as never, BASE_REQ as never);
    expect(r.invalidReason).toBe("signature_mismatch");
  });

  it("a structurally-invalid signature is caught (recovery throws) → signature_invalid", async () => {
    const { auth } = await sign(generatePrivateKey());
    const r = await fac().verify({ payload: { authorization: auth, signature: "0x1234" } } as never, BASE_REQ as never);
    expect(r.invalidReason).toBe("signature_invalid");
  });

  it("a nonce already spent by settle() is rejected on re-verify → nonce_reused", async () => {
    const nonce = rand();
    const { auth, signature } = await sign(generatePrivateKey(), { nonce });
    const f = fac();
    await f.settle({ payload: { authorization: auth, signature } } as never, BASE_REQ as never);
    const r = await f.verify({ payload: { authorization: auth, signature } } as never, BASE_REQ as never);
    expect(r.invalidReason).toBe("nonce_reused");
  });
});

describe("LocalFacilitatorClient.settle / getSettleStatus — honest local receipts", () => {
  it("settle() on a valid payment returns success + a labeled local: marker (never a fake on-chain tx)", async () => {
    const { auth, signature } = await sign(generatePrivateKey());
    const r = await fac().settle({ payload: { authorization: auth, signature } } as never, BASE_REQ as never);
    expect(r.success).toBe(true);
    expect(r.status).toBe("pending");
    expect(r.transaction.startsWith("local:")).toBe(true);
  });

  it("settle() short-circuits with the verify failure when the payload is invalid", async () => {
    const { auth } = await sign(generatePrivateKey());
    const r = await fac().settle({ payload: { authorization: auth } } as never, BASE_REQ as never);
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("invalid_payload");
    expect(r.transaction).toBe("");
  });

  it("getSettleStatus is honestly pending (no live facilitator)", async () => {
    const r = await fac().getSettleStatus("0xabc");
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("no_live_facilitator");
  });
});

describe("okx.ts — facilitator selection + quoteSummary", () => {
  it("without OKX creds, buildFacilitatorClient returns the local-faithful client", () => {
    expect(buildFacilitatorClient()).toBeInstanceOf(LocalFacilitatorClient);
    expect(quoteSummary().facilitator).toMatch(/LocalFacilitatorClient/);
  });
});

describe("fetchSettleStatus — local + no-cred paths", () => {
  it("a local: marker reports local_pending without a network call", async () => {
    const r = await fetchSettleStatus(`local:${"f".repeat(40)}`);
    expect(r.status).toBe("local_pending");
    expect(r.live).toBe(false);
  });

  it("a non-local txHash with no creds reports unknown / not-live", async () => {
    const r = await fetchSettleStatus("0xnotlocal");
    expect(r.status).toBe("unknown");
    expect(r.live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credentialed paths — fresh module reload with OKX creds stubbed in the env.
// ---------------------------------------------------------------------------

async function importOkxWithCreds() {
  vi.resetModules();
  vi.stubEnv("OKX_API_KEY", "test-key");
  vi.stubEnv("OKX_SECRET_KEY", "test-secret");
  vi.stubEnv("OKX_PASSPHRASE", "test-pass");
  return import("../api/rails/okx");
}

describe("okx.ts — real-credentials facilitator branch (isolated module reload)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("constructs the OKXFacilitatorClient when Developer Portal creds are present", async () => {
    const okx = await importOkxWithCreds();
    const { OKXFacilitatorClient } = await import("@okxweb3/x402-core");
    expect(okx.buildFacilitatorClient()).toBeInstanceOf(OKXFacilitatorClient);
    expect(okx.quoteSummary().facilitator).toMatch(/OKXFacilitatorClient \(live\)/);
  });

  it("fetchSettleStatus queries the live facilitator GET /settle/status", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "success" }) })) as unknown as typeof fetch);
    const r = await okx.fetchSettleStatus("0xdeadbeef");
    expect(r.live).toBe(true);
    expect(r.status).toBe("success");
    expect(r.source).toContain("Facilitator");
  });

  it("fetchSettleStatus reports unreachable when the status request fails", async () => {
    const okx = await importOkxWithCreds();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch);
    const r = await okx.fetchSettleStatus("0xdeadbeef");
    expect(r.live).toBe(false);
    expect(r.status).toBe("unreachable");
  });
});

describe("okx.ts — warmFacilitator() boot self-check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves and reports ready when the (local) facilitator handshake succeeds", async () => {
    const { warmFacilitator } = await import("../api/rails/okx");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(warmFacilitator()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("x402 facilitator ready"));
    log.mockRestore();
  });

  it("swallows a slow handshake via the bounded timeout (logs a warning, never throws)", async () => {
    const { x402ResourceServer } = await import("@okxweb3/x402-core/server");
    const { warmFacilitator } = await import("../api/rails/okx");
    const init = vi
      .spyOn(x402ResourceServer.prototype, "initialize")
      .mockImplementation(() => new Promise<void>((resolve) => { setTimeout(resolve, 50); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(warmFacilitator(1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("facilitator warm-up failed"));
    init.mockRestore();
    warn.mockRestore();
  });
});
