/**
 * Ported from EdgeLedger's `test/clv.test.ts` (verified Injective build) —
 * proves the vendored `engine/clv.ts` still behaves exactly as tested
 * upstream after being copied into this self-contained build.
 */
import { describe, it, expect } from "vitest";
import { clvPct, clvProbPoints, beatClose, aggregateClv } from "../engine/clv";

describe("CLV engine (vendored from EdgeLedger)", () => {
  it("relative CLV matches: 1.85 -> 1.72 ~= +7.6%", () => {
    expect(clvPct(1.85, 1.72)).toBeCloseTo(0.0756, 4);
  });

  it("relative CLV: 2.10 -> 2.15 ~= -2.3% (line drifted against us)", () => {
    expect(clvPct(2.1, 2.15)).toBeCloseTo(-0.0233, 4);
  });

  it("prob-point CLV: 1.85 -> 1.72 ~= +0.0409", () => {
    expect(clvProbPoints(1.85, 1.72)).toBeCloseTo(0.0409, 4);
  });

  it("no move = zero CLV", () => {
    expect(clvPct(2.0, 2.0)).toBe(0);
  });

  it("shorter close = positive CLV (beat the close)", () => {
    expect(beatClose(2.0, 1.8)).toBe(true);
  });

  it("longer close = negative CLV", () => {
    expect(beatClose(1.8, 2.0)).toBe(false);
  });

  it("invalid odds throw", () => {
    expect(() => clvPct(1, 1.5)).toThrow();
    expect(() => clvPct(1.5, 1)).toThrow();
  });

  it("aggregateClv averages relative CLV and hit-rate", () => {
    const agg = aggregateClv([
      { entry_odds: 1.85, closing_odds: 1.72 },
      { entry_odds: 2.1, closing_odds: 2.15 },
    ]);
    expect(agg.n).toBe(2);
    expect(agg.beat_close_rate).toBeCloseTo(0.5, 5);
  });
});
