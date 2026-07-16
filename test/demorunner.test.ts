/**
 * Full demoRunner coverage: run the real server-side x402 round-trip for both
 * routes and assert the settled-result enrichment. The settled ledger is
 * augmented (via a module mock) with one synthetic `void` row so pnlFor's
 * void branch is exercised alongside win/loss/unmatched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";

vi.mock("../db/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/ledger")>();
  return {
    ...actual,
    loadSettledLedgerFromCsv: (p?: string) => [
      ...actual.loadSettledLedgerFromCsv(p),
      {
        id: "void1",
        stage: "KO",
        fixture: "VOID FC vs TEST",
        side_label: "Void Pick",
        entry_odds: 2.0,
        closing_odds: 2.0,
        result: "void" as const,
        kickoff_utc: "2026-07-01T00:00:00Z",
        clv_pct: 0,
        grade: "B" as const,
      },
    ],
  };
});

const PORT = 4095;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Server;
let runDemo: typeof import("../api/demoRunner").runDemo;
let settledResultFor: typeof import("../api/demoRunner").settledResultFor;
let PATHS: typeof import("../config").PATHS;

beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv("API_BASE_URL", BASE);
  const { createApp } = await import("../api/server");
  ({ runDemo, settledResultFor } = await import("../api/demoRunner"));
  ({ PATHS } = await import("../config"));
  const app = createApp();
  server = app.listen(PORT);
  await new Promise<void>((resolve) => server.once("listening", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  for (const p of [PATHS.buyerStore, PATHS.receiptLog, PATHS.usedNonces]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe("settledResultFor", () => {
  it("joins a real settled row (case-insensitive) and returns null on a miss", () => {
    expect(settledResultFor("bra vs srb", "brazil ml")).toBe("win");
    expect(settledResultFor("Nope", "Nope")).toBeNull();
  });
});

describe("runDemo — grade", () => {
  it("does a real paid round-trip and enriches with the settled result", async () => {
    const out = await runDemo("grade", { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 });
    expect(out.route).toBe("grade");
    expect(out.paid_status).toBe(200);
    expect(out.settled_result).toBe("win");
    expect(out.challenge_line).toContain("402 challenge:");
    expect(out.settlement).toContain("local_pending");
  });

  it("returns settled_result null when the demo body is absent (exercises the ?? {} guards)", async () => {
    const out = await runDemo("grade", undefined);
    expect(out.settled_result).toBeNull();
  });
});

describe("runDemo — audit", () => {
  it("aggregates win / loss / void / unmatched settled results into raw_record", async () => {
    const out = await runDemo("audit", {
      bets: [
        { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 }, // win
        { match: "GER vs JPN", selection: "Germany ML", odds_taken: 1.75 }, // loss
        { match: "VOID FC vs TEST", selection: "Void Pick", odds_taken: 2.0 }, // void (synthetic)
        { match: "Unmatched", selection: "None", odds_taken: 2.0 }, // no settled row
      ],
    });
    expect(out.route).toBe("audit");
    expect(out.paid_status).toBe(200);
    expect(out.raw_record).toBeDefined();
    expect(out.raw_record!.wins).toBe(1);
    expect(out.raw_record!.losses).toBe(1);
    expect(out.raw_record!.voids).toBe(1);
    expect(out.raw_record!.graded_for_pnl).toBe(3); // the unmatched bet is skipped
    expect(out.per_bet_results).toEqual(["win", "loss", "void", null]);
  });

  it("returns a zeroed raw_record when the body is absent (exercises the ?? {} / ?? [] guards)", async () => {
    const out = await runDemo("audit", undefined);
    expect(out.raw_record).toEqual({ wins: 0, losses: 0, voids: 0, graded_for_pnl: 0, raw_roi_pct: 0 });
    expect(out.per_bet_results).toEqual([]);
  });
});
