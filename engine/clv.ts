/**
 * Vendored verbatim from EdgeLedger's `engine/clv.ts` (verified, tested
 * Injective build) — CLV Scout's entire grading thesis rests on this exact,
 * already-tested math. Copied unmodified (only the import path changed to
 * this build's local `prob.ts`) so the two products can never silently drift
 * on what "beat the close" means.
 *
 * Source: hackquest-injective-global-cup-2026/specs/hackquest-injective-edgeledger/build/engine/clv.ts
 *
 * CLV — Closing Line Value. The pro-syndicate gold metric: did we get a better
 * price than the market's closing line? Positive CLV over a sample = real edge,
 * independent of win/loss variance.
 *
 * We compute CLV for the SIDE WE BACKED, sign-adjusted so positive = beat the
 * close (we bet at longer odds than it closed):
 *
 *   clv_prob_points = implied(closing) - implied(entry)      (probability POINTS)
 *   clv_pct         = (implied(closing) - implied(entry)) / implied(entry)
 *                   = entry_odds / closing_odds - 1           (RELATIVE, the headline)
 *
 * The relative form is what the API/UI shows (e.g. entry 1.85 → close 1.72 =
 * +7.6%) and is exactly the ARCHITECTURE.md §Grading-math formula
 * `(p_close - p_taken) / p_taken`, algebraically identical to `entry/closing - 1`.
 * Positive = good for the bettor.
 */
import { impliedProb } from "./prob";

/** Raw probability-point CLV: implied(closing) - implied(entry). + = beat close. */
export function clvProbPoints(entryOdds: number, closingOdds: number): number {
  return impliedProb(closingOdds) - impliedProb(entryOdds);
}

/** Relative CLV (headline, as a fraction e.g. 0.076 = +7.6%): entry/closing - 1. + = beat close. */
export function clvPct(entryOdds: number, closingOdds: number): number {
  if (!(entryOdds > 1) || !(closingOdds > 1)) {
    throw new Error(`invalid odds for CLV: entry=${entryOdds} closing=${closingOdds}`);
  }
  return entryOdds / closingOdds - 1;
}

/** Did the bet have positive closing-line value? */
export function beatClose(entryOdds: number, closingOdds: number): boolean {
  return clvPct(entryOdds, closingOdds) > 0;
}

/**
 * Aggregate CLV over a sample of settled picks. Average relative CLV is the
 * headline "avg CLV" stat; we also return the beat-close hit-rate.
 */
export function aggregateClv(
  picks: { entry_odds: number; closing_odds: number }[],
): { avg_clv_pct: number; beat_close_rate: number; n: number } {
  const n = picks.length;
  if (n === 0) return { avg_clv_pct: 0, beat_close_rate: 0, n: 0 };
  let sum = 0;
  let beat = 0;
  for (const p of picks) {
    const c = clvPct(p.entry_odds, p.closing_odds);
    sum += c;
    if (c > 0) beat += 1;
  }
  return { avg_clv_pct: sum / n, beat_close_rate: beat / n, n };
}
