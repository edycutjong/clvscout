import { describe, it, expect, beforeAll } from "vitest";
import { gradeBet } from "../engine/grader";
import { __setLineHistoryForTests } from "../data/lineHistory";
import { computeTruthTable } from "../engine/grade";
import type { LineHistoryEntry, TruthTable } from "../engine/types";

const FIXTURE_LINE: LineHistoryEntry = {
  match: "TST vs OPP",
  match_key: "tst vs opp",
  selection: "Test United ML",
  selection_key: "test united ml",
  kickoff_utc: "2026-07-10T19:00:00Z",
  entry_odds: 1.88,
  entry_captured_at: "2026-07-10T13:00:00Z",
  closing_odds: 1.92,
  closing_captured_at: "2026-07-10T18:55:00Z",
  source: "settled_ledger_snapshot",
};

let truthTable: TruthTable;

beforeAll(() => {
  __setLineHistoryForTests([FIXTURE_LINE]);
  truthTable = computeTruthTable([
    { grade: "C", entry_odds: 1.88, result: "win" },
    { grade: "C", entry_odds: 1.9, result: "loss" },
  ]);
});

describe("gradeBet — UNGRADED honesty path (never interpolates a close)", () => {
  it("returns UNGRADED when the {match, selection} pair has no recorded closing line", () => {
    const outcome = gradeBet({ match: "Unknown vs Nobody", selection: "Nobody ML", odds_taken: 1.9 }, truthTable);
    expect(outcome.clv_grade).toBe("UNGRADED");
    if (outcome.clv_grade === "UNGRADED") {
      expect(outcome.reason.toLowerCase()).toContain("no recorded closing line");
      expect(Array.isArray(outcome.covered_markets_hint)).toBe(true);
    }
  });

  it("UNGRADED reason never fabricates a number (no clv_pct field present)", () => {
    const outcome = gradeBet({ match: "Nope", selection: "Nope", odds_taken: 2.0 }, truthTable) as { clv_grade: string };
    expect("clv_pct" in outcome).toBe(false);
  });

  it("lookup is case/whitespace-insensitive but still an exact match, not fuzzy", () => {
    const outcome = gradeBet({ match: "  tst VS opp  ", selection: "test united ml", odds_taken: 1.88 }, truthTable);
    expect(outcome.clv_grade).not.toBe("UNGRADED");
  });
});

describe("gradeBet — graded happy path", () => {
  it("computes clv_pct, grade, beat_close, and provenance from the recorded snapshot", () => {
    const outcome = gradeBet({ match: "TST vs OPP", selection: "Test United ML", odds_taken: 1.88 }, truthTable);
    expect(outcome.clv_grade).not.toBe("UNGRADED");
    if (outcome.clv_grade !== "UNGRADED") {
      expect(outcome.clv_pct).toBeCloseTo(-2.08, 1);
      expect(outcome.beat_close).toBe(false);
      expect(outcome.close_odds).toBe(1.92);
      expect(outcome.provenance.snapshot_at).toBe(FIXTURE_LINE.closing_captured_at);
      expect(outcome.grade_truth.grade).toBe(outcome.clv_grade);
    }
  });

  it("a genuinely better entry price than the close grades positively", () => {
    const outcome = gradeBet({ match: "TST vs OPP", selection: "Test United ML", odds_taken: 2.2 }, truthTable);
    expect(outcome.clv_grade).not.toBe("UNGRADED");
    if (outcome.clv_grade !== "UNGRADED") {
      expect(outcome.beat_close).toBe(true);
      expect(outcome.clv_pct).toBeGreaterThan(0);
    }
  });
});
