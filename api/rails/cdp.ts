/**
 * api/rails/cdp.ts — the x402 Bazaar rail, `PAY_RAIL=cdp`.
 *
 * ============================================================================
 * SECOND VENUE, SAME PRODUCT
 * ============================================================================
 * x402 is a Linux Foundation standard (formalised 2026-04-02; 22 members incl.
 * AWS, Google, Microsoft, Stripe, Visa, Circle), not an OKX feature. CLV
 * Scout's engine, ledger, receipts, BuyerLens and its validate-before-payment
 * preflight are all venue-agnostic — so reaching a second, much larger
 * marketplace is a RAIL SWAP, not a rewrite:
 *
 *   | knob        | OKX.AI (rails/okx.ts)    | Bazaar (this file)        |
 *   |-------------|--------------------------|---------------------------|
 *   | facilitator | OKXFacilitatorClient     | CDP facilitator           |
 *   | network     | eip155:196  (X Layer)    | eip155:8453 (Base)        |
 *   | asset       | USD₮0                    | USDC                      |
 *   | discovery   | agent activate + review  | automatic on EVM routes   |
 *
 * Scale: OKX.AI is 888 agents / ~$19K lifetime GMV; the public Bazaar index
 * carries ~15,000 resources and the x402 network reported 69,000 active agents
 * and ~$50M cumulative volume by late April 2026. Listing there is free and
 * permissionless — no human review gauntlet.
 *
 * PRICING: this rail is NOT $0.01/$0.20. The market scan in
 * _notes/ASP_REVENUE_STRATEGY.md found the ≤$0.01 band holds 1% of all GMV
 * while the >$10 band holds 52%. The sibling EdgeLedger rail already runs the
 * $15 experiment; CLV Audit at $25 is the second datapoint.
 *
 * COMPOSITION: `createX402Server()` (CDP) returns an `X402Server extends
 * x402HTTPResourceServer`, exactly what `@x402/express`'s
 * `paymentMiddlewareFromHTTPServer()` consumes. The CDP SDK injects the
 * `bazaar` extension automatically on EVM routes; we additionally declare an
 * explicit discovery schema per route so a buying agent can construct a valid
 * call without guessing.
 *
 * CREDENTIALS: `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`. `payToConfig` is
 * `{ type: 'address' }` so we keep our own receiver and CDP provisions no
 * wallet — `CDP_WALLET_SECRET` is NOT required.
 */
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import type { RequestHandler } from "express";
import {
  AUDIT_MAX_BETS,
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
  CDP_AUDIT_PRICE,
  CDP_ENV,
  CDP_GRADE_PRICE,
  HAS_REAL_CDP_CREDS,
  PAYTO_ADDRESS,
} from "../../config";
import { AUDIT_ROUTE_KEY, CLV_PAY_ROUTES, GRADE_ROUTE_KEY } from "./okx";

export const BASE_MAINNET_CAIP2 = "eip155:8453";
export const BASE_SEPOLIA_CAIP2 = "eip155:84532";
export function cdpNetwork(): string {
  return CDP_ENV === "development" ? BASE_SEPOLIA_CAIP2 : BASE_MAINNET_CAIP2;
}

/**
 * The discovery declarations ARE the listing copy an agent reads before buying,
 * so they carry the full parameter contract. They mirror
 * `api/validate.ts`'s schemas exactly; if the two drift, buyers construct calls
 * that the preflight then rejects — a listing advertising terms the server does
 * not honour.
 *
 * Both `input` (a valid example instance) and `inputSchema` (the contract) are
 * required: with only the schema, CDP records `info.input.body` as `{}` and the
 * listing fails its own `required` check with
 * "v2 discovery extension validation failed: (root).input.body: … is required".
 */
function gradeDiscovery() {
  return declareDiscoveryExtension({
    bodyType: "json",
    input: { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 },
    inputSchema: {
      type: "object",
      properties: {
        match: { type: "string", description: 'Fixture the bet was placed on, e.g. "BRA vs SRB". REQUIRED.' },
        selection: { type: "string", description: 'The side backed, e.g. "Brazil ML". REQUIRED.' },
        odds_taken: { type: "number", description: "Decimal odds actually taken, must be > 1. REQUIRED." },
        book: { type: "string", description: "Optional. Sportsbook the bet was placed with." },
        placed_at: { type: "string", description: "Optional. ISO timestamp the bet was placed." },
      },
      required: ["match", "selection", "odds_taken"],
    },
    output: {
      example: {
        clv_grade: "C",
        clv_pct: -3.8,
        beat_close: false,
        truth_table: { n: 142, win_rate: 0.47, roi_pct: -2.1 },
      },
    },
  });
}

function auditDiscovery() {
  return declareDiscoveryExtension({
    bodyType: "json",
    input: { bets: [{ match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 }], label: "my tout" },
    inputSchema: {
      type: "object",
      properties: {
        bets: {
          type: "array",
          description: `1–${AUDIT_MAX_BETS} placed bets, each {match, selection, odds_taken} plus optional {book, placed_at, stake}. REQUIRED.`,
          items: {
            type: "object",
            properties: {
              match: { type: "string" },
              selection: { type: "string" },
              odds_taken: { type: "number" },
              book: { type: "string" },
              placed_at: { type: "string" },
              stake: { type: "number" },
            },
            required: ["match", "selection", "odds_taken"],
          },
        },
        label: { type: "string", description: "Optional. Names the tout or account being audited." },
      },
      required: ["bets"],
    },
    output: {
      example: {
        beat_close_rate: 0.31,
        grade_distribution: { A: 1, B: 3, C: 8, D: 6, F: 4 },
        sharp_score: { value: 40.7 },
        graded: 22,
        ungraded: 3,
      },
    },
  });
}

/**
 * Build the CDP-backed resource server. Throws with an actionable message when
 * credentials are absent — this rail is opt-in, so failing loudly beats
 * serving a rail that can never settle.
 */
export async function buildCdpServer() {
  if (!HAS_REAL_CDP_CREDS) {
    throw new Error(
      "PAY_RAIL=cdp requires CDP_API_KEY_ID and CDP_API_KEY_SECRET (Coinbase Developer Platform). " +
        "Set them, or run the default PAY_RAIL=okx rail.",
    );
  }
  // config.ts falls back to the burn address when no receiver is configured.
  // That is harmless on the local/no-creds path, but this rail settles REAL
  // USDC on Base mainnet — a deploy that forgot PAYTO_ADDRESS would send every
  // payment to 0x…dEaD, unrecoverably. Refuse to start instead.
  if (/^0x0+dead$/i.test(PAYTO_ADDRESS)) {
    throw new Error(
      `PAY_RAIL=cdp refuses to start with the burn-address default payTo (${PAYTO_ADDRESS}). ` +
        "Set CLV_PAYTO (or PAYTO_ADDRESS) to the real receiver — this rail settles live USDC on Base.",
    );
  }
  return createX402Server({
    apiKeyId: CDP_API_KEY_ID,
    apiKeySecret: CDP_API_KEY_SECRET,
    environment: CDP_ENV,
    payToConfig: { type: "address", evm: PAYTO_ADDRESS as `0x${string}` },
    routes: {
      [`POST ${GRADE_ROUTE_KEY}`]: {
        price: CDP_GRADE_PRICE,
        description: CLV_PAY_ROUTES[GRADE_ROUTE_KEY].description,
        networks: [cdpNetwork()],
        maxTimeoutSeconds: 300,
        extensions: { ...gradeDiscovery() },
      },
      [`POST ${AUDIT_ROUTE_KEY}`]: {
        price: CDP_AUDIT_PRICE,
        description: CLV_PAY_ROUTES[AUDIT_ROUTE_KEY].description,
        networks: [cdpNetwork()],
        maxTimeoutSeconds: 300,
        extensions: { ...auditDiscovery() },
      },
    },
  });
}

/** The Express gate for `PAY_RAIL=cdp` — mounted in the same position as okxPayGate(). */
export async function buildCdpPayGate(): Promise<RequestHandler> {
  const server = await buildCdpServer();
  return paymentMiddlewareFromHTTPServer(server) as unknown as RequestHandler;
}

const GATED_PATHS = new Set([GRADE_ROUTE_KEY, AUDIT_ROUTE_KEY]);

/**
 * Synchronous mount point for an asynchronously-built gate.
 *
 * `createX402Server()` is async but `createApp()` is sync, and every caller and
 * test depends on that. This defers construction to the first gated request and
 * memoises it.
 *
 * The path guard is load-bearing: without it an unconfigured rail fails EVERY
 * request — including `/health` and the free routes — because the build error is
 * raised before the underlying middleware can pass non-paid paths through. That
 * would fail the platform health check and block the deploy outright.
 */
export function buildCdpPayGateLazy(): RequestHandler {
  let gate: RequestHandler | null = null;
  let pending: Promise<RequestHandler> | null = null;
  return (req, res, next) => {
    const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
    if (!GATED_PATHS.has(path)) {
      next();
      return;
    }
    if (gate) {
      gate(req, res, next);
      return;
    }
    pending ??= buildCdpPayGate();
    pending
      .then((g) => {
        gate = g;
        g(req, res, next);
      })
      .catch((err) => {
        pending = null; // allow a retry on the next request
        next(err);
      });
  };
}

/**
 * What still stands between this deployment and a live Bazaar listing, printed
 * into the deploy log rather than discovered weeks later.
 */
export function bazaarReadiness(): { ready: boolean; steps: string[] } {
  const steps: string[] = [];
  if (!HAS_REAL_CDP_CREDS) steps.push("set CDP_API_KEY_ID + CDP_API_KEY_SECRET");
  steps.push("deploy this rail behind public HTTPS");
  steps.push("POST https://api.cdp.coinbase.com/platform/v2/x402/validate with the endpoint URL");
  steps.push(`complete ONE real settlement on ${cdpNetwork()} (needs USDC on Base in a buyer wallet)`);
  steps.push("confirm via GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources");
  return { ready: HAS_REAL_CDP_CREDS, steps };
}

/** The quote a buyer sees on this rail — mirrors okx.ts::quoteSummary for parity. */
export function cdpQuoteSummary() {
  return {
    service: "clvscout",
    rail: "cdp",
    venue: "x402 Bazaar",
    network: cdpNetwork(),
    asset: "USDC",
    payTo: PAYTO_ADDRESS,
    routes: [
      { route: GRADE_ROUTE_KEY, price: CDP_GRADE_PRICE },
      { route: AUDIT_ROUTE_KEY, price: CDP_AUDIT_PRICE },
    ],
    discoverable: true,
    credentials: HAS_REAL_CDP_CREDS ? "CDP facilitator (live)" : "MISSING — rail will refuse to start",
  };
}
