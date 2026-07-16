/**
 * npm run audit [-- --all] — re-derives CLV%, grades, and the truth table
 * independently from fixtures/picks.csv (ignoring any cached
 * ledger-settled.json), and reports:
 *   - whether the fresh computation matches the cached one written by `settle`
 *   - the excluded-row count (rows in picks.csv without a usable closing
 *     price — SEED_DATA.md §Seeding pipeline; currently always 0 because the
 *     shared picks.csv records both entry and closing odds for every row,
 *     stated explicitly rather than silently assumed)
 *   - truth-table row-count sum vs settled-ledger row count (ARCHITECTURE
 *     invariant 3)
 */
import fs from "node:fs";
import { buildSettledLedger } from "../db/ledger";
import { GRADES } from "../engine/types";
import { truthTableSum } from "../engine/grade";
import { PATHS } from "../config";
import { readPicksCsv } from "../db/csv";

function main(): void {
  const showAll = process.argv.includes("--all");
  const raw = readPicksCsv(PATHS.picksCsv);
  const excluded = raw.filter((r) => !(r.entry_odds > 1) || !(r.closing_odds > 1));
  const fresh = buildSettledLedger();

  console.log(`re-derived ${fresh.rows.length} settled rows from fixtures/picks.csv`);
  console.log(`excluded rows (no usable entry/closing price): ${excluded.length}`);
  if (excluded.length) {
    for (const r of excluded) console.log(`  - ${r.id} ${r.fixture}`);
  }

  const sum = truthTableSum(fresh.truthTable);
  console.log(`truth-table sum = ${sum}, settled rows = ${fresh.rows.length}: ${sum === fresh.rows.length ? "OK" : "MISMATCH"}`);

  if (fs.existsSync(PATHS.settledCache)) {
    const cached = JSON.parse(fs.readFileSync(PATHS.settledCache, "utf8")) as typeof fresh;
    let drift = 0;
    for (const g of GRADES) {
      if (
        cached.truthTable[g].n !== fresh.truthTable[g].n ||
        Math.abs(cached.truthTable[g].roi_pct - fresh.truthTable[g].roi_pct) > 1e-9
      ) {
        drift++;
        console.log(`  DRIFT on grade ${g}: cached n=${cached.truthTable[g].n} roi=${cached.truthTable[g].roi_pct} vs fresh n=${fresh.truthTable[g].n} roi=${fresh.truthTable[g].roi_pct}`);
      }
    }
    console.log(drift === 0 ? "cached ledger-settled.json matches fresh recomputation: OK" : `${drift} grade bucket(s) drifted from cache — run npm run settle`);
  } else {
    console.log("no cached ledger-settled.json found (run npm run settle first for a comparison baseline)");
  }

  if (showAll) {
    console.log("");
    console.log("per-row detail:");
    for (const row of fresh.rows) {
      console.log(`  ${row.id} ${row.fixture.padEnd(14)} ${row.side_label.padEnd(22)} clv=${row.clv_pct.toFixed(2)}% grade=${row.grade} result=${row.result}`);
    }
  }
}

main();
