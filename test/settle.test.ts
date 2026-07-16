import { describe, it, expect } from "vitest";
import { buildSettledLedger, loadSettledLedgerFromCsv } from "../db/ledger";
import { truthTableSum } from "../engine/grade";
import { GRADES } from "../engine/types";

describe("settled ledger — built from the shared fixtures/picks.csv", () => {
  it("loads every row from picks.csv (24 real settled World Cup picks)", () => {
    const rows = loadSettledLedgerFromCsv();
    expect(rows.length).toBe(24);
  });

  it("computes the documented CLV formula for a known row (BRA vs SRB, entry 1.55 -> close 1.46)", () => {
    const rows = loadSettledLedgerFromCsv();
    const row = rows.find((r) => r.id === "p001")!;
    // (1.55/1.46 - 1) * 100 ~= +6.16% -> grade A (band A is [4, 8))
    expect(row.clv_pct).toBeCloseTo(6.16, 1);
    expect(row.grade).toBe("A");
  });

  it("re-derives a deterministic truth table whose row counts sum to the settled count", () => {
    const ledger = buildSettledLedger();
    expect(truthTableSum(ledger.truthTable)).toBe(ledger.rows.length);
    for (const g of GRADES) expect(ledger.truthTable[g]).toBeDefined();
  });

  it("running buildSettledLedger twice is deterministic (same grades, same truth table)", () => {
    const a = buildSettledLedger();
    const b = buildSettledLedger();
    expect(a.rows.map((r) => r.grade)).toEqual(b.rows.map((r) => r.grade));
    expect(a.truthTable).toEqual(b.truthTable);
  });

  it("contains at least one settled winner with negative CLV (the 'won but bad bet' demo contrast)", () => {
    const rows = loadSettledLedgerFromCsv();
    const wonButBad = rows.filter((r) => r.result === "win" && r.clv_pct < 0);
    expect(wonButBad.length).toBeGreaterThanOrEqual(2);
  });

  it("contains at least one settled loser with positive CLV (the 'lost but good bet' demo contrast)", () => {
    const rows = loadSettledLedgerFromCsv();
    const lostButGood = rows.filter((r) => r.result === "loss" && r.clv_pct > 0);
    expect(lostButGood.length).toBeGreaterThanOrEqual(2);
  });
});
