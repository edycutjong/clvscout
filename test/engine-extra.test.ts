/**
 * Direct coverage of the pure-function edge branches the other suites don't
 * naturally reach: the gradeForClv fallback, profitUnits over every result,
 * verdictLine's three score bands, aggregateClv's empty-sample guard, and
 * impliedProb's invalid-odds throw.
 */
import { describe, it, expect } from "vitest";
import { gradeForClv, profitUnits, verdictLine } from "../engine/grade";
import { aggregateClv } from "../engine/clv";
import { impliedProb } from "../engine/prob";

describe("gradeForClv — defensive fallback", () => {
  it("returns F for a non-finite CLV that clears no band bound (NaN)", () => {
    // NaN >= anything is false, so the for-loop exhausts and the final
    // `return \"F\"` fallback line is taken (never reached by real CLV values,
    // which are always finite and >= the F band's UNBOUNDED_BELOW min).
    expect(gradeForClv(Number.NaN)).toBe("F");
  });
});

describe("profitUnits — flat 1-unit profit for every settled result", () => {
  it("win pays odds - 1", () => {
    expect(profitUnits(2.5, "win")).toBeCloseTo(1.5, 10);
  });
  it("loss costs the 1-unit stake", () => {
    expect(profitUnits(2.5, "loss")).toBe(-1);
  });
  it("void is a push (zero P&L)", () => {
    expect(profitUnits(2.5, "void")).toBe(0);
  });
});

describe("verdictLine — the three Sharp-Score bands + withheld", () => {
  it("withholds a verdict when nothing was gradeable", () => {
    expect(verdictLine(0, 0)).toContain("withheld");
  });
  it("sharp score >= 70 reads as edge-in-the-close", () => {
    expect(verdictLine(80, 5)).toContain("edge shows up in the closing line");
  });
  it("45 <= sharp score < 70 reads as mixed", () => {
    expect(verdictLine(50, 5)).toContain("mixed picture");
  });
  it("sharp score < 45 reads as raw-P&L-flatters", () => {
    expect(verdictLine(10, 5)).toContain("predict future results say otherwise");
  });
});

describe("aggregateClv — empty sample guard", () => {
  it("returns zeros for an empty pick set (never divides by zero)", () => {
    expect(aggregateClv([])).toEqual({ avg_clv_pct: 0, beat_close_rate: 0, n: 0 });
  });
});

describe("impliedProb — invalid odds", () => {
  it("throws on odds <= 1 (no implied probability is defined there)", () => {
    expect(() => impliedProb(1)).toThrow(/invalid decimal odds/);
    expect(() => impliedProb(0.5)).toThrow();
  });
});
