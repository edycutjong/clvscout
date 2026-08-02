/**
 * Local-faithful x402 FacilitatorClient — the settlement backend used when no
 * real OKX Developer Portal credentials are configured
 * (HAS_REAL_FACILITATOR_CREDS === false: local dev, CI, this build's tests, and
 * the public demo deployment that ships no secrets).
 *
 * It implements the SAME `FacilitatorClient` interface the real
 * `OKXFacilitatorClient` (from `@okxweb3/x402-core`) implements, so it plugs
 * into the REAL `@okxweb3/x402-express` `paymentMiddleware()` /
 * `x402ResourceServer` / `ExactEvmScheme` unchanged — only the facilitator
 * backing verify/settle is swapped (api/rails/okx.ts::buildFacilitatorClient).
 *
 * What is REAL here: `verify()` performs genuine EIP-712 typed-data signature
 * recovery (viem `recoverTypedDataAddress`) over the exact-scheme EIP-3009
 * `TransferWithAuthorization` struct the buyer signed — the same
 * "ECDSA-recovered `authorization.from` = unforgeable buyer identity" invariant
 * BuyerLens depends on. Time-window + payTo + amount + replay (nonce) checks
 * are enforced exactly as a real facilitator would.
 *
 * What is HONESTLY LOCAL: `settle()` never submits an on-chain transaction (no
 * funded relayer / RPC is wired in local mode). It returns
 * `{ success: true, status: "pending", transaction: "local:<hash>" }` — the
 * x402 spec's own "settlement accepted, on-chain confirmation pending" state,
 * with a `local:`-prefixed marker so the receipt can NEVER be mistaken for a
 * confirmed on-chain tx (same honesty rule as the receipt log's
 * `is_placeholder` flag). This lets the REAL SDK gate unlock the paid handler
 * so the CLV Scout proof page / `scripts/buyer.ts` demo stays runnable offline,
 * while every receipt is truthfully labeled. Set OKX_API_KEY/SECRET_KEY/
 * PASSPHRASE and this file is not used — api/rails/okx.ts constructs the real
 * `OKXFacilitatorClient`, which settles for real on X Layer.
 */
import { createHash } from "node:crypto";
import { recoverTypedDataAddress } from "viem";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SettleStatusResponse,
  SupportedResponse,
} from "@okxweb3/x402-core/types";
import { authorizationTypes } from "@okxweb3/x402-evm";
import { ASSET_NAME, ASSET_VERSION, X402_NETWORK } from "../../config";

interface Eip3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}
interface Eip3009Payload {
  signature?: `0x${string}`;
  authorization: Eip3009Authorization;
}

/** In-memory nonce set — replay protection within a process lifetime (test/demo scope). */
const seenNonces = new Set<string>();

export class LocalFacilitatorClient implements FacilitatorClient {
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:196" },
        { x402Version: 2, scheme: "exact", network: "eip155:1952" },
      ],
      extensions: [],
      signers: {},
    };
  }

  async verify(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const inner = paymentPayload.payload as unknown as Eip3009Payload;
    const auth = inner?.authorization;
    const signature = inner?.signature;
    if (!auth || !signature) {
      return { isValid: false, invalidReason: "invalid_payload", invalidMessage: "missing EIP-3009 authorization/signature" };
    }

    // Replay guard.
    if (seenNonces.has(auth.nonce)) {
      return { isValid: false, invalidReason: "nonce_reused", invalidMessage: "authorization nonce already spent" };
    }

    // Time-window checks (validAfter <= now <= validBefore).
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < Number(auth.validAfter) || nowSec > Number(auth.validBefore)) {
      return { isValid: false, invalidReason: "expired", invalidMessage: "authorization outside its valid time window" };
    }

    // payTo + amount checks against what the route actually requires.
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return { isValid: false, invalidReason: "wrong_payee", invalidMessage: "authorization.to does not match payTo" };
    }
    if (BigInt(auth.value) < BigInt(requirements.amount)) {
      return { isValid: false, invalidReason: "insufficient_value", invalidMessage: "authorization.value below required amount" };
    }

    // The real cryptographic step: recover the signer from the EIP-712
    // TransferWithAuthorization typed data. The domain name/version are read
    // from the route's `extra` (falling back to the configured USD₮0 domain).
    const extra = (requirements.extra ?? {}) as { name?: string; version?: string };
    try {
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: extra.name ?? ASSET_NAME,
          version: extra.version ?? ASSET_VERSION,
          chainId: Number(requirements.network.split(":")[1] ?? X402_NETWORK.split(":")[1] ?? 196),
          verifyingContract: requirements.asset as `0x${string}`,
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
        signature,
      });
      if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
        return { isValid: false, invalidReason: "signature_mismatch", invalidMessage: "recovered signer != authorization.from" };
      }
    } catch (e) {
      return { isValid: false, invalidReason: "signature_invalid", invalidMessage: (e as Error).message };
    }

    return { isValid: true, payer: auth.from };
  }

  async settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const verify = await this.verify(paymentPayload, requirements);
    if (!verify.isValid) {
      return {
        success: false,
        errorReason: verify.invalidReason ?? "verify_failed",
        errorMessage: verify.invalidMessage,
        transaction: "",
        network: requirements.network,
      };
    }
    const inner = paymentPayload.payload as unknown as Eip3009Payload;
    seenNonces.add(inner.authorization.nonce);

    // HONEST local settlement: verification passed (real ECDSA recovery), but
    // no funded relayer is wired here, so there is no on-chain confirmation.
    // Report the spec's `pending` state with a `local:`-prefixed marker — never
    // a fabricated confirmed tx hash. The `local:` prefix is what
    // api/rails/okx.ts::fetchSettleStatus and EXPLORER_URL_FOR key on to keep
    // the receipt truthfully labeled.
    const marker = `local:${createHash("sha256").update(JSON.stringify(paymentPayload)).digest("hex").slice(0, 40)}`;
    return {
      success: true,
      status: "pending",
      payer: inner.authorization.from,
      transaction: marker,
      network: requirements.network,
    };
  }

  async getSettleStatus(_txHash: string): Promise<SettleStatusResponse> {
    return { success: false, status: "pending", errorReason: "no_live_facilitator" };
  }
}
