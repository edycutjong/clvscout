/**
 * api/validate.ts — business-parameter validation that runs BEFORE payment.
 *
 * ============================================================================
 * OKX.AI LISTING REQUIREMENT: VALIDATE FIRST, CHARGE SECOND
 * ============================================================================
 * OKX.AI review requires that a service "complete parameter validation before
 * returning the x402 payment pending signature information (challenge)" — a
 * buyer must never sign, and must never be deducted, for a call that was
 * always going to fail on its parameters.
 *
 * The official SDK's `paymentMiddleware` knows nothing about our business
 * params, so it happily issues a challenge (and then verifies + settles a
 * replay) for a request with no `match`/`selection`/`odds_taken`. This module
 * is the gate in front of that gate:
 *
 *   cors -> json -> rate-limit -> header shim -> [paramPreflight] -> okxPayGate -> handler
 *
 * Three cases, in the order the middleware decides them:
 *
 *  1. UNPAID + NO PARAMS AT ALL + GET  -> pass through to the pay gate, which
 *     answers with the 402 challenge. This is the marketplace reachability
 *     probe (and `onchainos payment quote`): a param-less GET is a discovery
 *     call, never a purchase, and it must keep returning a well-formed
 *     PAYMENT-REQUIRED challenge or the listing reads as endpoint_unreachable.
 *
 *  2. INVALID PARAMS (paid or unpaid, any other shape) -> 400 right here.
 *     Unpaid, that means the challenge is never issued. Paid, it means the
 *     PAYMENT-SIGNATURE is never verified and never settled — so even a buyer
 *     who signed a challenge obtained from case 1 is NOT charged for an error.
 *
 *  3. VALID PARAMS -> `next()`, and the payment gate runs exactly as before.
 *
 * The schemas here are the SAME objects `api/routes.ts` parses with, so a
 * request can never pass preflight and then fail inside a handler that has
 * already been paid for.
 */
import type { Request, RequestHandler, Response, NextFunction } from "express";
import { z } from "zod";
import { AUDIT_MAX_BETS, PAY_RAIL } from "../config";

// `z.coerce.number()` (not `z.number()`): paid GETs carry params in the query
// string, where every value arrives as a string.
export const gradeRequestSchema = z.object({
  match: z.string().min(1),
  selection: z.string().min(1),
  odds_taken: z.coerce.number().gt(1),
  book: z.string().optional(),
  placed_at: z.string().optional(),
});

export const auditBetSchema = z.object({
  match: z.string().min(1),
  selection: z.string().min(1),
  odds_taken: z.coerce.number().gt(1),
  book: z.string().optional(),
  placed_at: z.string().optional(),
  stake: z.coerce.number().positive().optional(),
});

export const auditRequestSchema = z.object({
  bets: z.array(auditBetSchema).min(1).max(AUDIT_MAX_BETS),
  label: z.string().optional(),
});

export const GRADE_PATH = "/api/grade";
export const AUDIT_PATH = "/api/audit";

/**
 * A GET carries params in the query string, so `bets` arrives as a JSON string
 * rather than an array. Normalising here (and reusing this in the handler)
 * keeps preflight and the paid handler byte-identical in what they accept.
 */
export function normalizeParams(path: string, params: Record<string, unknown>): Record<string, unknown> {
  if (path === AUDIT_PATH && typeof params.bets === "string") {
    try {
      return { ...params, bets: JSON.parse(params.bets) as unknown };
    } catch {
      return params; // leave it — the schema will reject it with a clear message
    }
  }
  return params;
}

/** Business params for a request: query string and JSON body merged, body wins. */
export function paramsOf(req: Request): Record<string, unknown> {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const body = req.body;
  const fromBody = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return { ...query, ...fromBody };
}

/** True when the caller supplied no business parameters whatsoever. */
export function hasNoParams(params: Record<string, unknown>): boolean {
  return Object.keys(params).length === 0;
}

/** True when the caller attached an x402 payment (v2 header or the v1 alias). */
export function isPaidRequest(req: Request): boolean {
  return Boolean(req.headers["payment-signature"] ?? req.headers["x-payment"]);
}

/**
 * The 400 body for a bad call. OKX.AI's agent runtime derives call params from
 * the service description, so its first call may arrive incomplete — answer
 * with a copyable example it can retry with, and say plainly that nothing was
 * charged.
 */
export function paramErrorBody(path: string, details: unknown): Record<string, unknown> {
  const common = {
    error: "invalid_request",
    payment:
      "No payment was requested and nothing was deducted — CLV Scout validates parameters BEFORE issuing the x402 challenge. Fix the parameters and call again to receive a payment challenge.",
    details,
  };
  if (path === AUDIT_PATH) {
    return {
      ...common,
      service: "CLV Audit",
      note: `missing/invalid params — required: {bets: [{match, selection, odds_taken}, …]} (1–${AUDIT_MAX_BETS} bets); optional per bet: {book, placed_at, stake}; optional top-level: {label}`,
      required: ["bets[].match", "bets[].selection", "bets[].odds_taken"],
      optional: ["bets[].book", "bets[].placed_at", "bets[].stake", "label"],
      example_request: { bets: [{ match: "FRA-BRA", selection: "France ML", odds_taken: 2.1 }], label: "my tout" },
      example_response_shape: { beat_close_rate: "…", grade_distribution: "…", sharp_score: "0–100" },
    };
  }
  return {
    ...common,
    service: "CLV Grade",
    note: "missing/invalid params — required: {match, selection, odds_taken}; optional: {book, placed_at}",
    required: ["match", "selection", "odds_taken"],
    optional: ["book", "placed_at"],
    example_request: { match: "FRA-BRA", selection: "France ML", odds_taken: 2.1, book: "pinnacle" },
    example_response_shape: { clv_grade: "A+…F", clv_pct: "…", beat_close: "true|false", truth_table: "…" },
  };
}

const SCHEMA_FOR: Record<string, z.ZodTypeAny> = {
  [GRADE_PATH]: gradeRequestSchema,
  [AUDIT_PATH]: auditRequestSchema,
};

/** Normalise `/api/grade/` and `/api/grade` to the same route key. */
function routeKey(reqPath: string): string {
  const trimmed = reqPath.length > 1 ? reqPath.replace(/\/+$/, "") : reqPath;
  return trimmed in SCHEMA_FOR ? trimmed : "";
}

/**
 * Validate business params ahead of the x402 payment gate. Mount it BEFORE
 * `okxPayGate()`; paths that aren't payment-gated pass straight through.
 */
export function paramPreflight(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = routeKey(req.path);
    if (!path) {
      next();
      return;
    }

    const params = normalizeParams(path, paramsOf(req));
    const paid = isPaidRequest(req);

    // Case 1: the marketplace reachability probe / `onchainos payment quote` —
    // an unpaid, param-less GET. Let the SDK answer it with the real challenge.
    // Which shapes count as discovery is VENUE-SPECIFIC — the two marketplaces
    // disagree. OKX.AI requires validation BEFORE the challenge and its
    // validator sends a body (`x402-check --body`), so only a param-less GET
    // needs the exception there. Coinbase's Bazaar validator probes with a
    // param-less POST and reports "Skipped: endpoint did not return 402" on
    // every check otherwise, so the service is never indexed.
    //
    // Widening this does not weaken the OKX guarantee, which is about MONEY:
    // a request carrying a payment header is still validated ahead of the gate
    // below, so an invalid paid call is never verified and never settled.
    const isDiscoveryShape =
      req.method === "GET" || req.method === "HEAD" || (PAY_RAIL === "cdp" && req.method === "POST");
    if (!paid && isDiscoveryShape && hasNoParams(params)) {
      next();
      return;
    }

    // Case 2: anything else must be a well-formed call before money moves.
    const parsed = SCHEMA_FOR[path].safeParse(params);
    if (!parsed.success) {
      res.status(400).json(paramErrorBody(path, parsed.error.flatten()));
      return;
    }

    // Case 3: valid — hand off to the payment gate.
    next();
  };
}
