/**
 * Orchestration layer: ties the pure grading math (engine/grade.ts) to the
 * closing-line lookup (data/lineHistory.ts) and the settled-ledger truth
 * table (db/ledger.ts). This is what `/api/grade` and `/api/audit` both call
 * — one grader, three buyer shapes (PRD.md §Scope constraint).
 */
import { findClosingLine, coveredMarketsHint } from "../data/lineHistory";
import { clvPercent, gradeForClv, adviceForGrade } from "./grade";
import type { GradeOutcome, GradeRequest, TruthTable } from "./types";

/**
 * Grade a single bet against the recorded closing line. Never invents a
 * close: a missing line-history row => UNGRADED (ARCHITECTURE invariant 2).
 */
export function gradeBet(req: GradeRequest, truthTable: TruthTable): GradeOutcome {
  const line = findClosingLine(req.match, req.selection);
  if (!line) {
    return {
      clv_grade: "UNGRADED",
      reason: `No recorded closing line for "${req.match}" / "${req.selection}" — we never interpolate a close.`,
      covered_markets_hint: coveredMarketsHint(),
    };
  }

  const clv_pct = clvPercent(req.odds_taken, line.closing_odds);
  const grade = gradeForClv(clv_pct);
  const truth = truthTable[grade];

  return {
    clv_grade: grade,
    clv_pct: Math.round(clv_pct * 100) / 100,
    beat_close: clv_pct > 0,
    close_odds: line.closing_odds,
    close_source: line.source,
    grade_truth: truth,
    advice: adviceForGrade(grade, truth),
    provenance: {
      line_history_source: line.source,
      snapshot_at: line.closing_captured_at,
    },
  };
}
