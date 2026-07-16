/**
 * CLV Scout's own grading math — new for this build (COMPLEXITY.md §1.1/§1.2).
 * Everything here is a pure function: no I/O, fully unit-testable, and the
 * ONLY place grade bands / Sharp-Score weights are defined (single source of
 * truth, ARCHITECTURE.md invariant 4).
 *
 * Grading math (ARCHITECTURE.md §Grading math), step by step:
 *   1. p_taken = 1 / odds_taken
 *   2. p_close = 1 / close_odds        (from a recorded line-history snapshot)
 *   3. clv_pct = (p_close - p_taken) / p_taken * 100
 *              = (odds_taken / close_odds - 1) * 100   -- algebraically identical,
 *                and exactly `clvPct()` from the vendored engine/clv.ts, scaled to %.
 *   4. band lookup -> grade
 *   5. no close found -> UNGRADED (never interpolated) -- handled by the caller
 *      (engine/grade.ts has no I/O, so it cannot itself look up a close).
 */
import { clvPct } from "./clv";
import type { Grade, GradeTruth, Result, SharpSubScores, TruthTable } from "./types";
import { GRADES } from "./types";
import { AUDIT_MAX_BETS, LOW_SAMPLE_THRESHOLD } from "../config";

/**
 * Grade bands, in percent CLV, most favorable first. Bounds are round numbers
 * chosen independently of any one dataset (not curve-fit to the seed ledger).
 * `min` is inclusive; a row belongs to the first band (top-down) whose `min`
 * it clears.
 */
/** F's `min` is an unbounded-below sentinel (finite so it survives JSON.stringify — -Infinity would serialize as null). */
export const UNBOUNDED_BELOW = -1_000_000;

export const GRADE_BANDS: { grade: Grade; min: number }[] = [
  { grade: "A+", min: 8 },
  { grade: "A", min: 4 },
  { grade: "B", min: 0 },
  { grade: "C", min: -4 },
  { grade: "D", min: -8 },
  { grade: "F", min: UNBOUNDED_BELOW },
];

/** clv_pct is a PERCENTAGE (e.g. 7.56 = +7.56%), matching the API's wire format. */
export function gradeForClv(clvPctValue: number): Grade {
  for (const band of GRADE_BANDS) {
    if (clvPctValue >= band.min) return band.grade;
  }
  return "F";
}

/** Percentage-form CLV between an entry price and a recorded closing price. */
export function clvPercent(entryOdds: number, closingOdds: number): number {
  return clvPct(entryOdds, closingOdds) * 100;
}

/** Profit in flat units on a single settled bet (win = odds-1, loss = -1, void = 0). */
export function profitUnits(entryOdds: number, result: Result): number {
  if (result === "win") return entryOdds - 1;
  if (result === "loss") return -1;
  return 0;
}

/**
 * Build the grade -> {n, win_rate, roi_pct, low_sample} truth table from a set
 * of settled (win/loss/void) rows that already carry a computed grade.
 * Every grade band is always present (n=0 buckets included) so the API's
 * response shape never drops a key. (ARCHITECTURE invariant 3: rows sum to
 * the settled-ledger count.)
 */
export function computeTruthTable(
  rows: { grade: Grade; entry_odds: number; result: Result }[],
): TruthTable {
  const table = {} as TruthTable;
  for (const grade of GRADES) {
    const bucket = rows.filter((r) => r.grade === grade);
    const decided = bucket.filter((r) => r.result === "win" || r.result === "loss");
    const wins = decided.filter((r) => r.result === "win").length;
    const staked = bucket.length; // flat 1-unit stake per settled row
    const profit = bucket.reduce((sum, r) => sum + profitUnits(r.entry_odds, r.result), 0);
    table[grade] = {
      grade,
      n: bucket.length,
      win_rate: decided.length ? wins / decided.length : 0,
      roi_pct: staked ? (profit / staked) * 100 : 0,
      low_sample: bucket.length < LOW_SAMPLE_THRESHOLD,
    };
  }
  return table;
}

/** Assert the truth table's row counts sum to the settled-ledger count (invariant 3). */
export function truthTableSum(table: TruthTable): number {
  return GRADES.reduce((sum, g) => sum + table[g].n, 0);
}

export function adviceForGrade(grade: Grade, truth: GradeTruth): string {
  if (truth.n === 0) {
    return `No settled ${grade} bets yet in the calibration sample — advice withheld until n > 0.`;
  }
  if (truth.roi_pct >= 0) {
    return `${grade} bets in the calibration sample run ${(truth.roi_pct).toFixed(1)}% ROI over ${truth.n} settled rows — a defensible grade band.`;
  }
  return `${grade} bets in this grade band have negative expectancy (${truth.roi_pct.toFixed(1)}% ROI over ${truth.n} settled rows) — size down or skip.`;
}

// ---------------------------------------------------------------------------
// Sharp Score (0-100), origin-disclosed sub-scores (COMPLEXITY.md §1.2,
// ARCHITECTURE invariant 5: recomputes from its own sub_scores).
// ---------------------------------------------------------------------------

/** Weights are exported so a buyer (or a test) can recompute sharp_score.value byte-for-byte. */
export const SHARP_WEIGHTS = {
  clv_mean: 0.4,
  consistency: 0.25,
  grade_mix: 0.25,
  sample: 0.1,
} as const;

/** Points assigned to each grade for the `grade_mix` sub-score (higher = better). */
export const GRADE_POINTS: Record<Grade, number> = {
  "A+": 100,
  A: 85,
  B: 65,
  C: 35,
  D: 15,
  F: 0,
};

function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Compute the four origin-disclosed sub-scores from a set of *graded* bets
 * (UNGRADED bets are excluded upstream — see `buildAuditDossier`).
 */
export function computeSubScores(
  graded: { clv_pct: number; grade: Grade }[],
): SharpSubScores {
  const n = graded.length;
  if (n === 0) {
    return { clv_mean: 0, consistency: 0, grade_mix: 0, sample: 0 };
  }

  const clvValues = graded.map((b) => b.clv_pct);
  const mean = clvValues.reduce((a, b) => a + b, 0) / n;
  // clv_mean: 0% average CLV -> 50 (neutral); +10% -> 100; -10% -> 0.
  const clv_mean = clamp(50 + mean * 5);

  // consistency: lower stdev of clv_pct across bets -> higher score.
  const variance = clvValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const consistency = clamp(100 - stdev * 4);

  // grade_mix: average of per-bet grade points.
  const grade_mix = clamp(graded.reduce((sum, b) => sum + GRADE_POINTS[b.grade], 0) / n);

  // sample: reward larger graded samples, capped at the audit's max bet count.
  const sample = clamp((n / AUDIT_MAX_BETS) * 100);

  return {
    clv_mean: round1(clv_mean),
    consistency: round1(consistency),
    grade_mix: round1(grade_mix),
    sample: round1(sample),
  };
}

/** sharp_score.value = weighted sum of sub_scores, using the published SHARP_WEIGHTS. */
export function computeSharpScore(sub: SharpSubScores): number {
  const value =
    sub.clv_mean * SHARP_WEIGHTS.clv_mean +
    sub.consistency * SHARP_WEIGHTS.consistency +
    sub.grade_mix * SHARP_WEIGHTS.grade_mix +
    sub.sample * SHARP_WEIGHTS.sample;
  return Math.round(value * 10) / 10;
}

export function verdictLine(sharpScore: number, gradedN: number): string {
  if (gradedN === 0) {
    return "No gradeable bets in this sample — verdict withheld.";
  }
  if (sharpScore >= 70) {
    return `Sharp Score ${sharpScore}/100 — this bettor's edge shows up in the closing line, not just the scoreboard.`;
  }
  if (sharpScore >= 45) {
    return `Sharp Score ${sharpScore}/100 — mixed picture; some real CLV, some noise. Size down.`;
  }
  return `Sharp Score ${sharpScore}/100 — the record may look fine on raw P&L, but the numbers that predict future results say otherwise.`;
}

/** Normalize a free-text match/selection string for line-history lookup. */
export function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
