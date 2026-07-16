/**
 * BuyerLens-lite unit coverage: the payment-signature-keyed history store.
 * Exercises the read/append/aggregate/forget cycle directly against the
 * file-backed store (fixtures/buyers.json), cleaning up after itself.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import {
  recordBuyerGrade,
  buildYouBlock,
  getBuyerHistory,
  forgetBuyer,
} from "../api/buyerlens";
import { PATHS } from "../config";

const A = "0xAaAa000000000000000000000000000000000001";
const B = "0xBbBb000000000000000000000000000000000002";

function reset(): void {
  if (fs.existsSync(PATHS.buyerStore)) fs.rmSync(PATHS.buyerStore);
}

beforeEach(reset);
afterAll(reset);

function row(from: string, over: Partial<Parameters<typeof recordBuyerGrade>[0]> = {}) {
  return {
    from,
    match: "TST vs OPP",
    selection: "Test United ML",
    clv_grade: "A" as const,
    clv_pct: 6.2,
    beat_close: true,
    at: new Date().toISOString(),
    ...over,
  };
}

describe("recordBuyerGrade + getBuyerHistory", () => {
  it("appends rows and reads them back case-insensitively by address", () => {
    recordBuyerGrade(row(A));
    recordBuyerGrade(row(A, { beat_close: false, clv_grade: "C", clv_pct: -2 }));
    recordBuyerGrade(row(B));

    // lower-cased lookup still finds the mixed-case stored `from`
    const hist = getBuyerHistory(A.toLowerCase());
    expect(hist).toHaveLength(2);
    expect(getBuyerHistory(B)).toHaveLength(1);
    expect(getBuyerHistory("0xnever")).toEqual([]);
  });
});

describe("buildYouBlock", () => {
  it("returns a zeroed block for a missing address (never touches the store)", () => {
    expect(buildYouBlock(undefined)).toEqual({ your_grades: 0, your_beat_close_rate: 0 });
  });

  it("computes beat-close rate over graded rows only, rounded to 3dp", () => {
    recordBuyerGrade(row(A, { beat_close: true }));
    recordBuyerGrade(row(A, { beat_close: false, clv_grade: "C" }));
    recordBuyerGrade(row(A, { clv_grade: "UNGRADED", clv_pct: undefined, beat_close: undefined }));

    const you = buildYouBlock(A);
    expect(you.your_grades).toBe(3); // all rows count toward the total
    expect(you.your_beat_close_rate).toBeCloseTo(0.5, 5); // 1 of 2 graded beat close
  });

  it("reports a zero beat-close rate when there are no graded rows", () => {
    recordBuyerGrade(row(A, { clv_grade: "UNGRADED", clv_pct: undefined, beat_close: undefined }));
    const you = buildYouBlock(A);
    expect(you.your_grades).toBe(1);
    expect(you.your_beat_close_rate).toBe(0);
  });
});

describe("forgetBuyer", () => {
  it("deletes only the target address's rows and returns the deleted count", () => {
    recordBuyerGrade(row(A));
    recordBuyerGrade(row(A));
    recordBuyerGrade(row(B));

    const deleted = forgetBuyer(A);
    expect(deleted).toBe(2);
    expect(getBuyerHistory(A)).toEqual([]);
    expect(getBuyerHistory(B)).toHaveLength(1);
  });

  it("returns 0 when the address has no rows", () => {
    recordBuyerGrade(row(B));
    expect(forgetBuyer("0xghost")).toBe(0);
  });
});
