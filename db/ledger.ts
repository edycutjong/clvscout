/**
 * Settled ledger — the shared record CLV Scout calibrates against, per
 * SEED_DATA.md: "same fixtures/picks.csv real-record export used by
 * EdgeLedger — no second dataset to maintain."
 *
 * Rather than vendor better-sqlite3 (a native module) for what is, at Tier-1
 * scope, a 24-row dataset, this is a lightweight CSV-backed store: real data
 * in, deterministic grade + truth-table computation out, fully re-derivable
 * by `npm run audit -- --all` (ARCHITECTURE invariant 3). No numbers are
 * invented — every row comes from fixtures/picks.csv.
 */
import fs from "node:fs";
import { readPicksCsv } from "./csv";
import { clvPercent, gradeForClv, computeTruthTable } from "../engine/grade";
import type { SettledRow, TruthTable } from "../engine/types";
import { PATHS } from "../config";

export interface SettledLedger {
  rows: SettledRow[];
  truthTable: TruthTable;
  settledAt: string;
}

/** Load + grade every row from fixtures/picks.csv. Pure, deterministic, no caching. */
export function loadSettledLedgerFromCsv(csvPath = PATHS.picksCsv): SettledRow[] {
  const raw = readPicksCsv(csvPath);
  return raw.map((r) => {
    const clv_pct = clvPercent(r.entry_odds, r.closing_odds);
    return {
      id: r.id,
      stage: r.stage,
      fixture: r.fixture,
      side_label: r.side_label,
      entry_odds: r.entry_odds,
      closing_odds: r.closing_odds,
      result: r.result,
      kickoff_utc: r.kickoff_utc,
      clv_pct,
      grade: gradeForClv(clv_pct),
    };
  });
}

/** Build the full settled-ledger + truth-table bundle (what `npm run settle` writes to disk). */
export function buildSettledLedger(csvPath = PATHS.picksCsv): SettledLedger {
  const rows = loadSettledLedgerFromCsv(csvPath);
  const truthTable = computeTruthTable(rows);
  return { rows, truthTable, settledAt: new Date().toISOString() };
}

/**
 * The API's boot-time loader: prefer the cached artifact written by
 * `npm run settle` (has a stable `settledAt` for /api/calibration's
 * `last_settled_at`); fall back to computing live from the CSV so the server
 * never fails to boot just because `settle` wasn't run first.
 */
export function loadOrBuildSettledLedger(): SettledLedger {
  if (fs.existsSync(PATHS.settledCache)) {
    try {
      const cached = JSON.parse(fs.readFileSync(PATHS.settledCache, "utf8")) as SettledLedger;
      if (cached.rows?.length && cached.truthTable) return cached;
    } catch {
      // fall through to live compute
    }
  }
  return buildSettledLedger();
}

export function writeSettledLedgerCache(ledger: SettledLedger): void {
  fs.writeFileSync(PATHS.settledCache, JSON.stringify(ledger, null, 2));
}
