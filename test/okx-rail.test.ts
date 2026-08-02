/**
 * Unit-level coverage of the OFFICIAL-SDK payment rail's building blocks —
 * pricing conversion, the two-route quote/RoutesConfig, and real (offline)
 * EIP-3009 signature verification through the `LocalFacilitatorClient` that
 * backs the SDK's `paymentMiddleware` when no OKX creds are configured.
 *
 * The end-to-end 402/200 HTTP behavior is covered in test/paid-http.test.ts;
 * this file exercises the SDK facilitator's `verify()` directly, including a
 * REAL signed authorization (private key generated in-test, never committed) to
 * prove the verification is genuine cryptography, not a stub.
 */
import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { authorizationTypes } from "@okxweb3/x402-evm";
import {
  priceToAtomicUnits,
  buildRoutes,
  quoteSummary,
  CLV_PAY_ROUTES,
  GRADE_ROUTE_KEY,
  AUDIT_ROUTE_KEY,
} from "../api/rails/okx";
import { LocalFacilitatorClient } from "../api/rails/localFacilitator";
import { X402_NETWORK, USDT0_ADDRESS, PAYTO_ADDRESS, ASSET_NAME, ASSET_VERSION } from "../config";

/** A wire-shaped PaymentRequirements for the given route (what the SDK passes verify()). */
function requirementsFor(routeKey: string) {
  const priceUsd = CLV_PAY_ROUTES[routeKey].priceUsd;
  return {
    scheme: "exact",
    network: X402_NETWORK,
    asset: USDT0_ADDRESS,
    amount: priceToAtomicUnits(priceUsd),
    payTo: PAYTO_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009", name: ASSET_NAME, version: ASSET_VERSION },
  } as const;
}

async function signAuth(
  pk: `0x${string}`,
  required: ReturnType<typeof requirementsFor>,
  overrides: { from?: `0x${string}`; value?: string; nonce?: `0x${string}` } = {},
) {
  const account = privateKeyToAccount(pk);
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from: overrides.from ?? account.address,
    to: required.payTo as `0x${string}`,
    value: overrides.value ?? required.amount,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 3600),
    nonce: overrides.nonce ?? (("0x" + "11".repeat(32)) as `0x${string}`),
  };
  const signature = await account.signTypedData({
    domain: {
      name: required.extra.name,
      version: required.extra.version,
      chainId: Number(required.network.split(":")[1]),
      verifyingContract: required.asset as `0x${string}`,
    },
    types: authorizationTypes,
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
  return { authorization, signature, address: account.address };
}

let nonceCounter = 0;
const randNonce = () => ("0x" + (nonceCounter++).toString(16).padStart(64, "a")) as `0x${string}`;

describe("priceToAtomicUnits", () => {
  it("$0.01 -> 10000 atomic units at 6dp", () => {
    expect(priceToAtomicUnits(0.01)).toBe("10000");
  });
  it("$0.20 -> 200000 atomic units at 6dp", () => {
    expect(priceToAtomicUnits(0.2)).toBe("200000");
  });
});

describe("buildRoutes + quoteSummary — two independently-priced routes", () => {
  it("gates both /api/grade and /api/audit with per-route exact-scheme accepts", () => {
    const routes = buildRoutes() as Record<string, { accepts: { scheme: string; price: { amount: string; asset: string } }[] }>;
    expect(Object.keys(routes)).toEqual([GRADE_ROUTE_KEY, AUDIT_ROUTE_KEY]);
    expect(routes[GRADE_ROUTE_KEY].accepts[0].scheme).toBe("exact");
    expect(routes[GRADE_ROUTE_KEY].accepts[0].price.amount).toBe(priceToAtomicUnits(0.01));
    expect(routes[AUDIT_ROUTE_KEY].accepts[0].price.amount).toBe(priceToAtomicUnits(0.2));
    expect(routes[GRADE_ROUTE_KEY].accepts[0].price.asset.toLowerCase()).toBe(USDT0_ADDRESS.toLowerCase());
  });

  it("quoteSummary mirrors buildRoutes (USD₮0, x402 v2, local facilitator by default)", () => {
    const q = quoteSummary();
    expect(q.x402Version).toBe(2);
    expect(q.routes.map((r) => r.route)).toEqual([GRADE_ROUTE_KEY, AUDIT_ROUTE_KEY]);
    expect(q.routes[0].accepts[0].amount_usd).toBeCloseTo(0.01, 6);
    expect(q.routes[1].accepts[0].amount_usd).toBeCloseTo(0.2, 6);
    expect(q.routes[0].accepts[0].token_name).toBe(ASSET_NAME);
    expect(q.facilitator).toMatch(/LocalFacilitatorClient/);
  });
});

describe("LocalFacilitatorClient.verify — real offline EIP-712/EIP-3009 signature check", () => {
  it("accepts a genuinely signed TransferWithAuthorization matching the required amount", async () => {
    const required = requirementsFor(GRADE_ROUTE_KEY);
    const { authorization, signature, address } = await signAuth(generatePrivateKey(), required, { nonce: randNonce() });
    const r = await new LocalFacilitatorClient().verify(
      { x402Version: 2, payload: { signature, authorization } } as never,
      required as never,
    );
    expect(r.isValid).toBe(true);
    expect(r.payer?.toLowerCase()).toBe(address.toLowerCase());
  });

  it("rejects a payload signed by a DIFFERENT key than authorization.from claims", async () => {
    const required = requirementsFor(GRADE_ROUTE_KEY);
    const impersonated = privateKeyToAccount(generatePrivateKey()).address;
    const { authorization, signature } = await signAuth(generatePrivateKey(), required, { from: impersonated, nonce: randNonce() });
    const r = await new LocalFacilitatorClient().verify(
      { x402Version: 2, payload: { signature, authorization } } as never,
      required as never,
    );
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("signature_mismatch");
  });

  it("rejects an amount below the required price (audit route)", async () => {
    const required = requirementsFor(AUDIT_ROUTE_KEY);
    const { authorization, signature } = await signAuth(generatePrivateKey(), required, { value: "1", nonce: randNonce() });
    const r = await new LocalFacilitatorClient().verify(
      { x402Version: 2, payload: { signature, authorization } } as never,
      required as never,
    );
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("insufficient_value");
  });
});
