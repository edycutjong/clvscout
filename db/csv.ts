/** Minimal, dependency-free CSV reader for `fixtures/picks.csv` (comment lines start with `#`). */
import fs from "node:fs";

const COLUMNS = [
  "id",
  "stage",
  "fixture",
  "side",
  "side_label",
  "model_prob",
  "entry_odds",
  "closing_odds",
  "result",
  "kickoff_utc",
  "receipt_offset_hours",
  "sold_count",
] as const;

export interface PicksCsvRow {
  id: string;
  stage: string;
  fixture: string;
  side: string;
  side_label: string;
  model_prob: number;
  entry_odds: number;
  closing_odds: number;
  result: "win" | "loss" | "void";
  kickoff_utc: string;
  receipt_offset_hours: number;
  sold_count: number;
}

/** Reads the shared picks.csv (no header row — columns documented in a leading `#` comment). */
export function readPicksCsv(filePath: string): PicksCsvRow[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  return lines.map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    COLUMNS.forEach((col, i) => {
      row[col] = cells[i];
    });
    return {
      id: row.id,
      stage: row.stage,
      fixture: row.fixture,
      side: row.side,
      side_label: row.side_label,
      model_prob: Number(row.model_prob),
      entry_odds: Number(row.entry_odds),
      closing_odds: Number(row.closing_odds),
      result: row.result as PicksCsvRow["result"],
      kickoff_utc: row.kickoff_utc,
      receipt_offset_hours: Number(row.receipt_offset_hours),
      sold_count: Number(row.sold_count),
    };
  });
}
