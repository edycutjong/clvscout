/** Core domain types for CLV Scout. */

export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";
export const GRADES: Grade[] = ["A+", "A", "B", "C", "D", "F"];

export type Result = "win" | "loss" | "void";

/** One settled row from the shared ledger (fixtures/picks.csv) — used to build the truth table. */
export interface SettledRow {
  id: string;
  stage: string;
  fixture: string;
  side_label: string;
  entry_odds: number;
  closing_odds: number;
  result: Result;
  kickoff_utc: string;
  clv_pct: number; // percentage, e.g. 7.56 = +7.56%
  grade: Grade;
}

/** Per-grade calibration bucket: this is what makes a grade mean something. */
export interface GradeTruth {
  grade: Grade;
  n: number;
  win_rate: number;
  roi_pct: number;
  low_sample: boolean;
}

export type TruthTable = Record<Grade, GradeTruth>;

/** A recorded closing-line snapshot for one market — never interpolated. */
export interface LineHistoryEntry {
  match: string;
  match_key: string; // normalized (lowercased, trimmed) — the actual lookup key
  selection: string;
  selection_key: string;
  kickoff_utc: string;
  entry_odds: number;
  entry_captured_at: string;
  closing_odds: number;
  closing_captured_at: string;
  source: "settled_ledger_snapshot";
}

/** Input shape for POST /api/grade. */
export interface GradeRequest {
  match: string;
  selection: string;
  odds_taken: number;
  book?: string;
  placed_at?: string;
}

export interface GradedResult {
  clv_grade: Grade;
  clv_pct: number;
  beat_close: boolean;
  close_odds: number;
  close_source: string;
  grade_truth: GradeTruth;
  advice: string;
  provenance: { line_history_source: string; snapshot_at: string };
}

export interface UngradedResult {
  clv_grade: "UNGRADED";
  reason: string;
  covered_markets_hint: string[];
}

export type GradeOutcome = GradedResult | UngradedResult;

/** Input shape for one bet inside POST /api/audit. */
export interface AuditBetInput {
  match: string;
  selection: string;
  odds_taken: number;
  book?: string;
  placed_at?: string;
  stake?: number;
}

export interface SharpSubScores {
  clv_mean: number;
  consistency: number;
  grade_mix: number;
  sample: number;
}
