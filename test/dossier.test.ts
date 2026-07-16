import { describe, it, expect, beforeAll } from "vitest";
import { buildAuditDossier } from "../engine/dossier";
import { __setLineHistoryForTests } from "../data/lineHistory";
import { computeTruthTable, SHARP_WEIGHTS } from "../engine/grade";
import type { LineHistoryEntry, TruthTable } from "../engine/types";

const LINES: LineHistoryEntry[] = [
  {
    match: "M1",
    match_key: "m1",
    selection: "S1",
    selection_key: "s1",
    kickoff_utc: "2026-07-01T00:00:00Z",
    entry_odds: 1.5,
    entry_captured_at: "2026-06-30T00:00:00Z",
    closing_odds: 1.35, // clv = (1.5/1.35-1)*100 ~= +11.1% -> grade A+ (matches the truthTable fixture below)
    closing_captured_at: "2026-06-30T23:55:00Z",
    source: "settled_ledger_snapshot",
  },
  {
    match: "M2",
    match_key: "m2",
    selection: "S2",
    selection_key: "s2",
    kickoff_utc: "2026-07-02T00:00:00Z",
    entry_odds: 1.5,
    entry_captured_at: "2026-07-01T00:00:00Z",
    closing_odds: 1.7, // clv = (1.5/1.7-1)*100 ~= -11.8% -> grade F (matches the truthTable fixture below)
    closing_captured_at: "2026-07-01T23:55:00Z",
    source: "settled_ledger_snapshot",
  },
];

let truthTable: TruthTable;

beforeAll(() => {
  __setLineHistoryForTests(LINES);
  truthTable = computeTruthTable([
    { grade: "A+", entry_odds: 1.5, result: "win" },
    { grade: "A+", entry_odds: 1.4, result: "win" },
    { grade: "F", entry_odds: 1.5, result: "loss" },
    { grade: "F", entry_odds: 1.5, result: "loss" },
  ]);
});

describe("buildAuditDossier — aggregation", () => {
  it("counts graded and ungraded bets separately, and totals to the input size", () => {
    const dossier = buildAuditDossier(
      [
        { match: "M1", selection: "S1", odds_taken: 1.5 },
        { match: "M2", selection: "S2", odds_taken: 1.5 },
        { match: "Nope", selection: "Nope", odds_taken: 1.5 },
      ],
      truthTable,
    );
    expect(dossier.graded).toBe(2);
    expect(dossier.ungraded).toBe(1);
    expect(dossier.per_bet).toHaveLength(3);
  });

  it("grade_distribution counts sum to `graded`, not to the full bet count", () => {
    const dossier = buildAuditDossier(
      [
        { match: "M1", selection: "S1", odds_taken: 1.5 },
        { match: "M2", selection: "S2", odds_taken: 1.5 },
        { match: "Nope", selection: "Nope", odds_taken: 1.5 },
      ],
      truthTable,
    );
    const distSum = Object.values(dossier.grade_distribution).reduce((a, b) => a + b, 0);
    expect(distSum).toBe(dossier.graded);
  });

  it("beat_close_rate is computed only over graded bets", () => {
    const dossier = buildAuditDossier(
      [
        { match: "M1", selection: "S1", odds_taken: 1.5 }, // beats close
        { match: "M2", selection: "S2", odds_taken: 1.5 }, // does not
      ],
      truthTable,
    );
    expect(dossier.beat_close_rate).toBeCloseTo(0.5, 5);
  });

  it("respects a custom per-bet stake in weighted_expectancy_pct", () => {
    const equalStake = buildAuditDossier(
      [
        { match: "M1", selection: "S1", odds_taken: 1.5, stake: 1 },
        { match: "M2", selection: "S2", odds_taken: 1.5, stake: 1 },
      ],
      truthTable,
    );
    const heavyOnM1 = buildAuditDossier(
      [
        { match: "M1", selection: "S1", odds_taken: 1.5, stake: 10 },
        { match: "M2", selection: "S2", odds_taken: 1.5, stake: 1 },
      ],
      truthTable,
    );
    // M1 grades A+ (positive-expectancy bucket in this fixture's truth table);
    // weighting heavily toward it should raise expectancy vs the equal-stake case.
    expect(heavyOnM1.weighted_expectancy_pct).toBeGreaterThan(equalStake.weighted_expectancy_pct);
  });

  it("Sharp Score recomputes from its own disclosed sub_scores + weights (assert equality)", () => {
    const dossier = buildAuditDossier(
      [
        { match: "M1", selection: "S1", odds_taken: 1.5 },
        { match: "M2", selection: "S2", odds_taken: 1.5 },
      ],
      truthTable,
    );
    const { sub_scores, weights, value } = dossier.sharp_score;
    const recomputed =
      sub_scores.clv_mean * weights.clv_mean +
      sub_scores.consistency * weights.consistency +
      sub_scores.grade_mix * weights.grade_mix +
      sub_scores.sample * weights.sample;
    expect(value).toBeCloseTo(Math.round(recomputed * 10) / 10, 5);
    expect(weights).toEqual(SHARP_WEIGHTS);
  });

  it("an all-UNGRADED audit yields a zero Sharp Score and a withheld verdict, never a crash", () => {
    const dossier = buildAuditDossier(
      [{ match: "Nope", selection: "Nope", odds_taken: 1.5 }],
      truthTable,
    );
    expect(dossier.graded).toBe(0);
    expect(dossier.sharp_score.value).toBe(0);
    expect(dossier.verdict_line).toContain("withheld");
  });

  it("carries the optional label through unchanged", () => {
    const dossier = buildAuditDossier(
      [{ match: "M1", selection: "S1", odds_taken: 1.5 }],
      truthTable,
      "my-label",
    );
    expect(dossier.label).toBe("my-label");
  });
});
