/**
 * api/rails/okx.ts — the OKX x402 payment rail, `PAY_RAIL=okx`.
 *
 * ============================================================================
 * OFFICIAL OKX PAYMENT SDK INTEGRATION
 * ============================================================================
 * This rail is built ON the official, published OKX x402 packages — the same
 * SDK the OKX.AI listing review verifies against:
 *
 *   - `@okxweb3/x402-express`  → `paymentMiddleware(routes, resourceServer)`
 *   - `@okxweb3/x402-core`     → `x402ResourceServer`, `OKXFacilitatorClient`
 *   - `@okxweb3/x402-evm`      → server-side `ExactEvmScheme`, `authorizationTypes`
 *
 * The Express payment gate (`okxPayGate()`) is the SDK's own
 * `paymentMiddleware`. It builds the 402 `PaymentRequired` challenge, decodes
 * the buyer's `PAYMENT-SIGNATURE` / `X-PAYMENT`, runs exact-scheme EIP-3009
 * verification through the registered `ExactEvmScheme`, and settles through the
 * facilitator — none of that wire logic is hand-rolled here anymore.
 *
 * SDK EXPORT NOTE: the SERVER-side `ExactEvmScheme` (the one carrying
 * `parsePrice` / `enhancePaymentRequirements`) is published at the subpath
 * `@okxweb3/x402-evm/exact/server`. The top-level `@okxweb3/x402-evm` export is
 * the CLIENT-side scheme of the same class name and lacks those server methods,
 * so it must NOT be used for resource-server registration.
 *
 * FACILITATOR: the real `OKXFacilitatorClient` (HMAC `OK-ACCESS-*` auth against
 * `web3.okx.com/api/v6/pay/x402/*`) whenever OKX Developer Portal credentials
 * are configured; otherwise the local-faithful `LocalFacilitatorClient`
 * (api/rails/localFacilitator.ts) that does REAL EIP-712 signature recovery but
 * honestly reports settlement as `pending`/`local:` rather than fabricating an
 * on-chain receipt. Either way the 402 challenge is pure local config, so the
 * unit tests build and assert it fully offline.
 */
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import type { RoutesConfig, FacilitatorClient } from "@okxweb3/x402-core/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import type { RequestHandler } from "express";
import {
  ASSET_DECIMALS,
  ASSET_NAME,
  ASSET_VERSION,
  AUDIT_PRICE_USD,
  GRADE_PRICE_USD,
  HAS_REAL_FACILITATOR_CREDS,
  OKX_API_KEY,
  OKX_PASSPHRASE,
  OKX_SECRET_KEY,
  PAYTO_ADDRESS,
  USDT0_ADDRESS,
  X402_NETWORK,
  X402_VERSION,
} from "../../config";
import { LocalFacilitatorClient } from "./localFacilitator";

// ---------------------------------------------------------------------------
// Route map — the only payment config (per-route pricing).
//
// Keys are PATH-ONLY (method-less): the x402-core route pattern gates EVERY
// method on the path, so an unpaid GET probe gets the same 402 challenge as
// POST. OKX.AI's review probe (and `onchainos payment quote`) default to GET,
// and a 405 there is classified as `endpoint_unreachable` — a listing-reject
// reason.
// ---------------------------------------------------------------------------

export interface RouteConfig {
  priceUsd: number;
  description: string;
  mimeType: string;
}

export const GRADE_ROUTE_KEY = "/api/grade";
export const AUDIT_ROUTE_KEY = "/api/audit";

export const CLV_PAY_ROUTES: Record<string, RouteConfig> = {
  [GRADE_ROUTE_KEY]: {
    priceUsd: GRADE_PRICE_USD,
    description:
      "CLV Scout — grade a placed World Cup bet against the closing line; returns grade, CLV%, and the settled truth table for that grade.",
    mimeType: "application/json",
  },
  [AUDIT_ROUTE_KEY]: {
    priceUsd: AUDIT_PRICE_USD,
    description:
      "CLV Scout audit — up to 25 placed bets → full CLV dossier: per-bet grades, beat-close rate, Sharp Score with origin-disclosed sub-scores.",
    mimeType: "application/json",
  },
};

/** "$0.01" @ 6dp -> "10000" (atomic units string, the x402 `amount` field). */
export function priceToAtomicUnits(usd: number): string {
  return String(Math.round(usd * 10 ** ASSET_DECIMALS));
}

// ---------------------------------------------------------------------------
// Facilitator selection — real OKX client with creds, local-faithful without.
// ---------------------------------------------------------------------------

export function buildFacilitatorClient(): FacilitatorClient {
  if (HAS_REAL_FACILITATOR_CREDS) {
    return new OKXFacilitatorClient({
      apiKey: OKX_API_KEY,
      secretKey: OKX_SECRET_KEY,
      passphrase: OKX_PASSPHRASE,
    });
  }
  return new LocalFacilitatorClient();
}

/**
 * RoutesConfig for the two gated endpoints. Each entry carries its own
 * `AssetAmount` price (`{asset, amount}`) so grade ($0.01) and audit ($0.20)
 * quote independently. `extra.decimals` is the x402-core convention for token
 * decimals — required because USD₮0 is not in OKX's token registry, so the
 * resolver can't otherwise compute the human amount.
 */
export function buildRoutes(): RoutesConfig {
  const accept = (route: RouteConfig) => [
    {
      scheme: "exact" as const,
      network: X402_NETWORK as `${string}:${string}`,
      payTo: PAYTO_ADDRESS,
      price: { asset: USDT0_ADDRESS, amount: priceToAtomicUnits(route.priceUsd) },
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "eip3009", name: ASSET_NAME, version: ASSET_VERSION, decimals: ASSET_DECIMALS },
    },
  ];
  return {
    [GRADE_ROUTE_KEY]: {
      description: CLV_PAY_ROUTES[GRADE_ROUTE_KEY].description,
      mimeType: CLV_PAY_ROUTES[GRADE_ROUTE_KEY].mimeType,
      accepts: accept(CLV_PAY_ROUTES[GRADE_ROUTE_KEY]),
    },
    [AUDIT_ROUTE_KEY]: {
      description: CLV_PAY_ROUTES[AUDIT_ROUTE_KEY].description,
      mimeType: CLV_PAY_ROUTES[AUDIT_ROUTE_KEY].mimeType,
      accepts: accept(CLV_PAY_ROUTES[AUDIT_ROUTE_KEY]),
    },
  };
}

/** Build the x402ResourceServer: one facilitator, the exact/EVM scheme on our network(s). */
export function buildResourceServer(): x402ResourceServer {
  const server = new x402ResourceServer(buildFacilitatorClient());
  server.register("eip155:196", new ExactEvmScheme());
  server.register("eip155:1952", new ExactEvmScheme());
  return server;
}

/**
 * The Express payment gate (`PAY_RAIL=okx`). This IS the official SDK's
 * `paymentMiddleware` — it only protects the routes in its own routes map;
 * every other path passes through untouched.
 */
export function okxPayGate(): RequestHandler {
  return paymentMiddleware(buildRoutes(), buildResourceServer()) as unknown as RequestHandler;
}

/**
 * Boot-time facilitator warm-up + self-check.
 *
 * `paymentMiddleware` (syncFacilitatorOnStart=true) awaits the resource
 * server's `initialize()` — a `facilitator.getSupported()` round-trip — on the
 * FIRST gated call. On mainnet that hits web3.okx.com; a cold DNS/TLS
 * handshake there is exactly what OKX.AI's review can see as a timeout. Running
 * it at boot primes the connection pool and surfaces bad creds / an
 * unreachable network in the deploy logs, not on a buyer's first paid call.
 * Bounded and non-fatal: never blocks listening, never throws.
 */
export async function warmFacilitator(timeoutMs = 8000): Promise<void> {
  const label = HAS_REAL_FACILITATOR_CREDS ? "OKXFacilitatorClient (live)" : "LocalFacilitatorClient (local)";
  try {
    const server = buildResourceServer();
    await Promise.race([
      server.initialize(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`facilitator handshake exceeded ${timeoutMs}ms`)), timeoutMs).unref();
      }),
    ]);
    console.log(`  x402 facilitator ready: ${label} on ${X402_NETWORK}`);
  } catch (err) {
    console.warn(`  ⚠️  x402 facilitator warm-up failed (${label} on ${X402_NETWORK}): ${(err as Error).message}`);
    console.warn("     The first paid call retries the handshake; if this persists, verify OKX_* creds and that X402_NETWORK is a supported network.");
  }
}

/**
 * Live re-check of a settlement via the facilitator's `GET /settle/status`
 * (powers the free `/api/receipts/verify`). `local:`-prefixed markers are the
 * local-faithful facilitator's honest receipts — there is no explorer entry
 * for them, so they report `local_pending` without a network round-trip.
 */
export async function fetchSettleStatus(txHash: string): Promise<{ status: string; live: boolean; source: string }> {
  if (txHash.startsWith("local:")) {
    return {
      status: "local_pending",
      live: false,
      source: "local-faithful facilitator receipt — OKX facilitator credentials not configured on this deployment",
    };
  }
  if (!HAS_REAL_FACILITATOR_CREDS) {
    return { status: "unknown", live: false, source: "OKX facilitator credentials not configured" };
  }
  try {
    const client = buildFacilitatorClient();
    if (!client.getSettleStatus) {
      return { status: "unknown", live: false, source: "facilitator does not support GET /settle/status" };
    }
    const resp = await client.getSettleStatus(txHash);
    return { status: resp.status ?? "unknown", live: true, source: "OKX Facilitator GET /settle/status" };
  } catch {
    return { status: "unreachable", live: false, source: "OKX Facilitator GET /settle/status (request failed)" };
  }
}

/** The quote a buyer sees pre-flight — for docs/tests/DEMO.md, mirrors buildRoutes(). */
export function quoteSummary() {
  const routes = buildRoutes() as unknown as Record<string, { accepts: Array<Record<string, unknown>> }>;
  const summarize = (key: string) => ({
    route: key,
    accepts: routes[key].accepts.map((a) => {
      const price = a.price as { asset: string; amount: string };
      const extra = a.extra as { assetTransferMethod?: string; name?: string };
      return {
        scheme: a.scheme as string,
        network: a.network as string,
        asset: price.asset,
        amount_units: price.amount,
        amount_usd: Number(price.amount) / 10 ** ASSET_DECIMALS,
        payTo: a.payTo as string,
        asset_transfer_method: extra.assetTransferMethod,
        token_name: extra.name,
      };
    }),
  });
  return {
    service: "clvscout",
    x402Version: X402_VERSION,
    network: X402_NETWORK,
    routes: [summarize(GRADE_ROUTE_KEY), summarize(AUDIT_ROUTE_KEY)],
    facilitator: HAS_REAL_FACILITATOR_CREDS
      ? "OKXFacilitatorClient (live)"
      : "LocalFacilitatorClient (local-faithful — see api/rails/localFacilitator.ts)",
  };
}
