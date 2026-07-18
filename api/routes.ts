/**
 * CLV Scout route handlers. Payment enforcement lives entirely in
 * `api/rails/okx.ts` (mounted before these in `api/server.ts`) — handlers
 * here assume payment already cleared for the two paid routes and never
 * re-check it (ARCHITECTURE invariant 1: payment before compute).
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { gradeBet } from "../engine/grader";
import { buildAuditDossier } from "../engine/dossier";
import { GRADE_BANDS, truthTableSum } from "../engine/grade";
import { GRADES } from "../engine/types";
import { loadOrBuildSettledLedger } from "../db/ledger";
import { loadLineHistory } from "../data/lineHistory";
import { buildYouBlock, recordBuyerGrade, getBuyerHistory, forgetBuyer } from "./buyerlens";
import { fetchSettleStatus, EXPLORER_URL_FOR } from "./receipts";
import { runDemo } from "./demoRunner";
import { AUDIT_MAX_BETS } from "../config";
import type { GradedResult } from "../engine/types";

// `z.coerce.number()` (not `z.number()`): paid GETs carry params in the query
// string, where every value arrives as a string.
const gradeRequestSchema = z.object({
  match: z.string().min(1),
  selection: z.string().min(1),
  odds_taken: z.coerce.number().gt(1),
  book: z.string().optional(),
  placed_at: z.string().optional(),
});

const auditBetSchema = z.object({
  match: z.string().min(1),
  selection: z.string().min(1),
  odds_taken: z.coerce.number().gt(1),
  book: z.string().optional(),
  placed_at: z.string().optional(),
  stake: z.coerce.number().positive().optional(),
});

const auditRequestSchema = z.object({
  bets: z.array(auditBetSchema).min(1).max(AUDIT_MAX_BETS),
  label: z.string().optional(),
});

const meRequestSchema = z.object({
  address: z.string().min(1),
  forget: z.boolean().optional(),
});

const receiptsVerifySchema = z.object({
  txHash: z.string().min(1),
});

function ledger() {
  return loadOrBuildSettledLedger();
}

export async function gradeHandler(req: Request, res: Response): Promise<void> {
  const parsed = gradeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    // Answer usefully instead of a bare 400: OKX.AI's agent runtime derives
    // call params from the service description, so its first paid call may
    // arrive incomplete — give it a copyable example to retry with.
    res.status(200).json({
      service: "CLV Grade",
      note: "missing/invalid params — required: {match, selection, odds_taken}; optional: {book, placed_at}",
      example_request: { match: "FRA-BRA", selection: "France ML", odds_taken: 2.1, book: "pinnacle" },
      example_response_shape: { clv_grade: "A+…F", clv_pct: "…", beat_close: "true|false", truth_table: "…" },
      details: parsed.error.flatten(),
    });
    return;
  }

  const { truthTable } = ledger();
  const outcome = gradeBet(parsed.data, truthTable);
  const payer = req.x402?.payer;

  recordBuyerGrade({
    from: payer ?? "unknown",
    match: parsed.data.match,
    selection: parsed.data.selection,
    clv_grade: outcome.clv_grade,
    clv_pct: outcome.clv_grade === "UNGRADED" ? undefined : (outcome as GradedResult).clv_pct,
    beat_close: outcome.clv_grade === "UNGRADED" ? undefined : (outcome as GradedResult).beat_close,
    at: new Date().toISOString(),
  });

  res.status(200).json({
    ...outcome,
    you: buildYouBlock(payer),
  });
}

export async function auditHandler(req: Request, res: Response): Promise<void> {
  const parsed = auditRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json({
      service: "CLV Audit",
      note: `missing/invalid params — required: {bets: [{match, selection, odds_taken}, …]} (1–${AUDIT_MAX_BETS} bets); optional per bet: {book, placed_at, stake}; optional top-level: {label}`,
      example_request: { bets: [{ match: "FRA-BRA", selection: "France ML", odds_taken: 2.1 }], label: "my tout" },
      example_response_shape: { beat_close_rate: "…", grade_distribution: "…", sharp_score: "0–100" },
      details: parsed.error.flatten(),
    });
    return;
  }

  const { truthTable } = ledger();
  const dossier = buildAuditDossier(parsed.data.bets, truthTable, parsed.data.label);
  res.status(200).json(dossier);
}

export async function calibrationHandler(_req: Request, res: Response): Promise<void> {
  const { rows, truthTable, settledAt } = ledger();
  const table = GRADES.map((g) => truthTable[g]);
  const kickoffs = rows.map((r) => r.kickoff_utc).sort();
  const lineHistory = loadLineHistory();
  const marketTypes = new Set(lineHistory.map((e) => (e.selection.includes("advance") ? "knockout to-advance" : "1X2 moneyline")));

  res.status(200).json({
    bands: GRADE_BANDS,
    table,
    settled_row_count: truthTableSum(truthTable),
    window: kickoffs.length ? { from: kickoffs[0], to: kickoffs[kickoffs.length - 1] } : null,
    coverage: {
      competition: "FIFA World Cup 2026",
      market_types: [...marketTypes],
      matches_covered: lineHistory.length,
    },
    methodology:
      "clv_pct = (odds_taken / closing_odds - 1) * 100, computed against the LAST recorded pre-kickoff " +
      "odds snapshot for that exact {match, selection} pair. Grade bands are fixed round-number CLV " +
      "thresholds (never curve-fit to this sample). Truth-table rows are settled-ledger rollups: n, " +
      "win_rate (wins / decided bets), roi_pct (flat 1-unit-stake profit / stake). Buckets with n < 10 " +
      "carry low_sample:true. A close that isn't in our recorded snapshot store is never interpolated — " +
      "the call returns UNGRADED instead.",
    last_settled_at: settledAt,
  });
}

export async function meHandler(req: Request, res: Response): Promise<void> {
  const parsed = meRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.forget) {
    const deleted = forgetBuyer(parsed.data.address);
    res.status(200).json({ address: parsed.data.address, deleted });
    return;
  }
  const history = getBuyerHistory(parsed.data.address);
  res.status(200).json({ address: parsed.data.address, history, count: history.length });
}

export async function receiptsVerifyHandler(req: Request, res: Response): Promise<void> {
  const parsed = receiptsVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }
  const result = await fetchSettleStatus(parsed.data.txHash);
  res.status(200).json({
    txHash: parsed.data.txHash,
    status: result.status,
    live: result.live,
    source: result.source,
    verified_at: new Date().toISOString(),
    explorer_url: EXPLORER_URL_FOR(parsed.data.txHash),
  });
}

const demoRunSchema = z.object({
  route: z.enum(["grade", "audit"]),
  body: z.any(),
});

/**
 * Powers the browser proof page (`web/`). Runs a REAL x402 round-trip
 * server-side (see api/demoRunner.ts) because browsers can't easily sign
 * EIP-3009 — same payment path as `scripts/buyer.ts`, real 200 JSON, plus a
 * settled-result join so the page can render the "won-but-C" dissonance. This
 * route is NOT payment-gated itself; the call it makes on the buyer's behalf
 * is. Never mocks a grade.
 */
export async function demoRunHandler(req: Request, res: Response): Promise<void> {
  const parsed = demoRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }
  try {
    const out = await runDemo(parsed.data.route, parsed.data.body);
    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: "demo_run_failed", message: String(err) });
  }
}

export function methodNotAllowedHandler(_req: Request, res: Response): void {
  res.status(405).json({ error: "method_not_allowed" });
}

export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({ service: "clvscout-api", status: "ok" });
}
