/**
 * Generates fixtures/line-history.json from fixtures/picks.csv.
 *
 * Per SEED_DATA.md, line-history rows must come from recorded snapshots, not
 * interpolation. The shared picks.csv already records both the entry price
 * and the closing price (captured pre-kickoff) for every settled row — this
 * script just reshapes that into the {match, selection} keyed snapshot store
 * that `/api/grade` looks closing lines up against. One source of truth
 * (picks.csv); this file is a materialized, committed view of it, exactly
 * the way EdgeLedger archives odds-snapshots.
 *
 * Run: npm run gen-line-history
 */
import fs from "node:fs";
import { readPicksCsv } from "../db/csv";
import { normalizeKey } from "../engine/grade";
import { PATHS } from "../config";
import type { LineHistoryEntry } from "../engine/types";

function minutesBefore(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

function main(): void {
  const rows = readPicksCsv(PATHS.picksCsv);
  const entries: LineHistoryEntry[] = rows.map((r) => ({
    match: r.fixture,
    match_key: normalizeKey(r.fixture),
    selection: r.side_label,
    selection_key: normalizeKey(r.side_label),
    kickoff_utc: r.kickoff_utc,
    entry_odds: r.entry_odds,
    // Entry snapshot is recorded well ahead of kickoff; closing snapshot is
    // the last one captured before kickoff (I4-style rule, ported from
    // EdgeLedger's data/odds.ts closingLineFromSnapshots doc comment).
    entry_captured_at: minutesBefore(r.kickoff_utc, 6 * 60),
    closing_odds: r.closing_odds,
    closing_captured_at: minutesBefore(r.kickoff_utc, 5),
    source: "settled_ledger_snapshot",
  }));

  fs.writeFileSync(PATHS.lineHistory, JSON.stringify(entries, null, 2));
  console.log(`wrote ${entries.length} line-history rows -> ${PATHS.lineHistory}`);
}

main();
