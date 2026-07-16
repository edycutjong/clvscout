import { describe, it, expect } from "vitest";
import {
  gradeForClv,
  computeTruthTable,
  truthTableSum,
  GRADE_BANDS,
  computeSubScores,
  computeSharpScore,
  SHARP_WEIGHTS,
} from "../engine/grade";
import { GRADES } from "../engine/types";

describe("grade bands — boundaries", () => {
  it("A+ starts exactly at 8.0", () => {
    expect(gradeForClv(8)).toBe("A+");
    expect(gradeForClv(7.999)).toBe("A");
  });

  it("A starts exactly at 4.0", () => {
    expect(gradeForClv(4)).toBe("A");
    expect(gradeForClv(3.999)).toBe("B");
  });

  it("B starts exactly at 0", () => {
    expect(gradeForClv(0)).toBe("B");
    expect(gradeForClv(-0.001)).toBe("C");
  });

  it("C starts exactly at -4", () => {
    expect(gradeForClv(-4)).toBe("C");
    expect(gradeForClv(-4.001)).toBe("D");
  });

  it("D starts exactly at -8", () => {
    expect(gradeForClv(-8)).toBe("D");
    expect(gradeForClv(-8.001)).toBe("F");
  });

  it("F is the catch-all for very negative CLV", () => {
    expect(gradeForClv(-50)).toBe("F");
  });

  it("every non-F band resolves to itself exactly at its own minimum", () => {
    for (const band of GRADE_BANDS) {
      if (band.grade === "F") continue;
      expect(gradeForClv(band.min)).toBe(band.grade);
    }
  });
});

describe("truth table", () => {
  const rows = [
    { grade: "A+" as const, entry_odds: 2.0, result: "win" as const },
    { grade: "A+" as const, entry_odds: 1.5, result: "loss" as const },
    { grade: "C" as const, entry_odds: 1.9, result: "win" as const },
    { grade: "F" as const, entry_odds: 3.0, result: "loss" as const },
  ];

  it("includes every grade band, even n=0 ones", () => {
    const table = computeTruthTable(rows);
    for (const g of GRADES) expect(table[g]).toBeDefined();
    expect(table.B.n).toBe(0);
    expect(table.D.n).toBe(0);
  });

  it("row counts sum to the settled-ledger count (invariant 3)", () => {
    const table = computeTruthTable(rows);
    expect(truthTableSum(table)).toBe(rows.length);
  });

  it("win_rate and roi_pct compute correctly for a mixed bucket", () => {
    const table = computeTruthTable(rows);
    // A+: 1 win @ 2.0 (+1.0), 1 loss (-1.0) -> profit 0, staked 2 -> roi 0%, win_rate 50%
    expect(table["A+"].win_rate).toBeCloseTo(0.5, 5);
    expect(table["A+"].roi_pct).toBeCloseTo(0, 5);
  });

  it("flags low_sample under the n<10 threshold", () => {
    const table = computeTruthTable(rows);
    expect(table["A+"].low_sample).toBe(true);
    expect(table.C.low_sample).toBe(true);
  });

  it("does not flag low_sample at n>=10", () => {
    const many = Array.from({ length: 12 }, () => ({ grade: "B" as const, entry_odds: 2.0, result: "win" as const }));
    const table = computeTruthTable(many);
    expect(table.B.low_sample).toBe(false);
    expect(table.B.n).toBe(12);
  });
});

describe("Sharp Score — recomputes from its own sub_scores (invariant 5)", () => {
  it("recomputing value from sub_scores + published weights matches sharp_score.value", () => {
    const graded = [
      { clv_pct: 6.77, grade: "A" as const },
      { clv_pct: -11.63, grade: "F" as const },
      { clv_pct: -6.12, grade: "D" as const },
      { clv_pct: -2.08, grade: "C" as const },
      { clv_pct: -6.25, grade: "D" as const },
    ];
    const sub = computeSubScores(graded);
    const value = computeSharpScore(sub);

    const recomputed =
      sub.clv_mean * SHARP_WEIGHTS.clv_mean +
      sub.consistency * SHARP_WEIGHTS.consistency +
      sub.grade_mix * SHARP_WEIGHTS.grade_mix +
      sub.sample * SHARP_WEIGHTS.sample;

    expect(value).toBeCloseTo(Math.round(recomputed * 10) / 10, 5);
  });

  it("empty sample yields all-zero sub-scores and a zero Sharp Score", () => {
    const sub = computeSubScores([]);
    expect(sub).toEqual({ clv_mean: 0, consistency: 0, grade_mix: 0, sample: 0 });
    expect(computeSharpScore(sub)).toBe(0);
  });

  it("sub-scores are individually bounded to [0,100]", () => {
    const graded = [
      { clv_pct: 500, grade: "A+" as const }, // extreme, should clamp
      { clv_pct: -500, grade: "F" as const },
    ];
    const sub = computeSubScores(graded);
    for (const v of Object.values(sub)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
