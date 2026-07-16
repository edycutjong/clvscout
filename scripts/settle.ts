/**
 * npm run settle — computes CLV% + grade per row from fixtures/picks.csv and
 * writes the derived truth-table rollup to fixtures/ledger-settled.json
 * (SEED_DATA.md §Seeding pipeline). Deterministic; re-derivable by
 * `npm run audit -- --all`.
 */
import { buildSettledLedger, writeSettledLedgerCache } from "../db/ledger";
import { GRADES } from "../engine/types";
import { truthTableSum } from "../engine/grade";

function main(): void {
  const ledger = buildSettledLedger();
  writeSettledLedgerCache(ledger);

  console.log(`settled ${ledger.rows.length} rows @ ${ledger.settledAt}`);
  console.log("");
  console.log("grade  n  win_rate  roi_pct  low_sample");
  for (const g of GRADES) {
    const t = ledger.truthTable[g];
    console.log(
      `${g.padEnd(5)} ${String(t.n).padStart(2)}  ${(t.win_rate * 100).toFixed(1).padStart(6)}%  ${t.roi_pct
        .toFixed(1)
        .padStart(7)}%  ${t.low_sample}`,
    );
  }
  const sum = truthTableSum(ledger.truthTable);
  console.log("");
  console.log(`truth-table sum = ${sum} (must equal settled row count = ${ledger.rows.length}): ${sum === ledger.rows.length ? "OK" : "MISMATCH"}`);
}

main();
