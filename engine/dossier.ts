/**
 * The `/api/audit` dossier builder (PRD.md §Core features #7, COMPLEXITY.md
 * §1.2) — "the tout autopsy". Aggregates per-bet grades into a Sharp Score
 * with origin-disclosed sub-scores, per the Stock-Analyst-style disclosed-
 * composite pattern.
 */
import { gradeBet } from "./grader";
import { computeSubScores, computeSharpScore, verdictLine, SHARP_WEIGHTS } from "./grade";
import type { AuditBetInput, Grade, GradedResult, TruthTable } from "./types";

export interface AuditPerBet {
  match: string;
  selection: string;
  odds_taken: number;
  stake: number;
  clv_grade: Grade | "UNGRADED";
  clv_pct?: number;
  beat_close?: boolean;
  reason?: string;
}

export interface AuditDossier {
  per_bet: AuditPerBet[];
  graded: number;
  ungraded: number;
  beat_close_rate: number;
  grade_distribution: Record<Grade, number>;
  weighted_expectancy_pct: number;
  sharp_score: {
    value: number;
    sub_scores: ReturnType<typeof computeSubScores>;
    weights: typeof SHARP_WEIGHTS;
  };
  verdict_line: string;
  label?: string;
}

export function buildAuditDossier(
  bets: AuditBetInput[],
  truthTable: TruthTable,
  label?: string,
): AuditDossier {
  const perBet: AuditPerBet[] = [];
  const gradedBets: { clv_pct: number; grade: Grade; stake: number }[] = [];
  const distribution: Record<Grade, number> = {
    "A+": 0,
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    F: 0,
  };

  for (const bet of bets) {
    const stake = bet.stake ?? 1;
    const outcome = gradeBet(
      { match: bet.match, selection: bet.selection, odds_taken: bet.odds_taken, book: bet.book, placed_at: bet.placed_at },
      truthTable,
    );

    if (outcome.clv_grade === "UNGRADED") {
      perBet.push({
        match: bet.match,
        selection: bet.selection,
        odds_taken: bet.odds_taken,
        stake,
        clv_grade: "UNGRADED",
        reason: outcome.reason,
      });
      continue;
    }

    const graded = outcome as GradedResult;
    distribution[graded.clv_grade] += 1;
    gradedBets.push({ clv_pct: graded.clv_pct, grade: graded.clv_grade, stake });
    perBet.push({
      match: bet.match,
      selection: bet.selection,
      odds_taken: bet.odds_taken,
      stake,
      clv_grade: graded.clv_grade,
      clv_pct: graded.clv_pct,
      beat_close: graded.beat_close,
    });
  }

  const graded = gradedBets.length;
  const ungraded = bets.length - graded;
  const beatCount = gradedBets.filter((b) => b.clv_pct > 0).length;
  const beat_close_rate = graded ? beatCount / graded : 0;

  // Weighted expectancy: the calibration-implied expected ROI of each graded
  // bet's grade band, stake-weighted. This is NOT the bet's actual settled
  // P&L (audited bets may be unsettled/future) — it is what the truth table
  // says bets in that grade band are worth, which is the whole point of the
  // grader (PRD.md: "bets in this grade band have negative expectancy").
  let stakeSum = 0;
  let weightedRoiSum = 0;
  for (const b of gradedBets) {
    const roi = truthTable[b.grade].roi_pct;
    stakeSum += b.stake;
    weightedRoiSum += roi * b.stake;
  }
  const weighted_expectancy_pct = stakeSum ? Math.round((weightedRoiSum / stakeSum) * 100) / 100 : 0;

  const subScores = computeSubScores(gradedBets);
  const sharpValue = computeSharpScore(subScores);

  return {
    per_bet: perBet,
    graded,
    ungraded,
    beat_close_rate: Math.round(beat_close_rate * 1000) / 1000,
    grade_distribution: distribution,
    weighted_expectancy_pct,
    sharp_score: {
      value: sharpValue,
      sub_scores: subScores,
      weights: SHARP_WEIGHTS,
    },
    verdict_line: verdictLine(sharpValue, graded),
    label,
  };
}
