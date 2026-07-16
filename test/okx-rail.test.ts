/**
 * Unit-level coverage of the faithful local x402 rail's building blocks —
 * pricing conversion and real (offline) EIP-3009 signature verification.
 * The end-to-end 402/405/200 HTTP behavior is covered in test/http.test.ts;
 * this file exercises `verifyPayment` directly, including a REAL signed
 * authorization (private key generated in-test, never committed) to prove
 * the verification is genuine cryptography, not a stub.
 */
import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  priceToAtomicUnits,
  buildPaymentRequirements,
  buildChallenge,
  verifyPayment,
  CLV_PAY_ROUTES,
} from "../api/rails/okx";

describe("priceToAtomicUnits", () => {
  it("$0.01 -> 10000 atomic units at 6dp", () => {
    expect(priceToAtomicUnits(0.01)).toBe("10000");
  });
  it("$0.20 -> 200000 atomic units at 6dp", () => {
    expect(priceToAtomicUnits(0.2)).toBe("200000");
  });
});

describe("buildChallenge", () => {
  it("produces x402Version 2 with an exact-scheme accepts entry for /api/grade", () => {
    const challenge = buildChallenge("POST /api/grade", "https://api.clvscout.edycu.dev/api/grade");
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0].scheme).toBe("exact");
    expect(challenge.accepts[0].amount).toBe(priceToAtomicUnits(CLV_PAY_ROUTES["POST /api/grade"].priceUsd));
  });
});

describe("verifyPayment — real offline EIP-712/EIP-3009 signature check", () => {
  it("accepts a genuinely signed TransferWithAuthorization matching the required PaymentRequirements", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const required = buildPaymentRequirements(CLV_PAY_ROUTES["POST /api/grade"], "https://x/api/grade");

    const nowSec = Math.floor(Date.now() / 1000);
    const authorization = {
      from: account.address,
      to: required.payTo as `0x${string}`,
      value: required.amount,
      validAfter: String(nowSec - 60),
      validBefore: String(nowSec + 3600),
      nonce: ("0x" + "11".repeat(32)) as `0x${string}`,
    };

    const signature = await account.signTypedData({
      domain: {
        name: required.extra.name as string,
        version: required.extra.version as string,
        chainId: Number(required.network.split(":")[1]),
        verifyingContract: required.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
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

    const result = await verifyPayment(
      { x402Version: 2, accepted: required, payload: { signature, authorization } },
      required,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer?.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("rejects a payload signed by a DIFFERENT key than authorization.from claims", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const impersonated = privateKeyToAccount(generatePrivateKey());
    const required = buildPaymentRequirements(CLV_PAY_ROUTES["POST /api/grade"], "https://x/api/grade");

    const nowSec = Math.floor(Date.now() / 1000);
    const authorization = {
      from: impersonated.address, // claims to be someone else
      to: required.payTo as `0x${string}`,
      value: required.amount,
      validAfter: String(nowSec - 60),
      validBefore: String(nowSec + 3600),
      nonce: ("0x" + "22".repeat(32)) as `0x${string}`,
    };

    const signature = await signer.signTypedData({
      domain: {
        name: required.extra.name as string,
        version: required.extra.version as string,
        chainId: Number(required.network.split(":")[1]),
        verifyingContract: required.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
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

    const result = await verifyPayment(
      { x402Version: 2, accepted: required, payload: { signature, authorization } },
      required,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("signature_invalid");
  });

  it("rejects an amount below the required price", async () => {
    const required = buildPaymentRequirements(CLV_PAY_ROUTES["POST /api/audit"], "https://x/api/audit");
    const underpaid = { ...required, amount: "1" };
    const result = await verifyPayment(
      {
        x402Version: 2,
        accepted: underpaid,
        payload: {
          signature: "0x00" as `0x${string}`,
          authorization: {
            from: "0x0000000000000000000000000000000000d00d",
            to: required.payTo,
            value: "1",
            validAfter: "0",
            validBefore: String(Math.floor(Date.now() / 1000) + 3600),
            nonce: "0x00",
          },
        },
      },
      required,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("amount_insufficient");
  });
});
