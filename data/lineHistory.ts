/**
 * Closing-line snapshot lookup. Ported concept from EdgeLedger's
 * `data/odds.ts` (`closingLineFromSnapshots` — "the closing line is the LAST
 * odds snapshot captured at or before kickoff, never interpolated"); CLV
 * Scout's version reads the materialized fixtures/line-history.json instead
 * of a live odds feed, because our coverage is exactly the settled matches
 * we've already recorded snapshots for (see SEED_DATA.md).
 *
 * The core honesty rule carries over unchanged: if a {match, selection}
 * pair has no recorded snapshot, we return `undefined` — the caller MUST
 * respond UNGRADED, never invent or interpolate a close.
 */
import fs from "node:fs";
import { normalizeKey } from "../engine/grade";
import { PATHS } from "../config";
import type { LineHistoryEntry } from "../engine/types";

let cache: LineHistoryEntry[] | undefined;

export function loadLineHistory(): LineHistoryEntry[] {
  if (cache) return cache;
  if (!fs.existsSync(PATHS.lineHistory)) {
    throw new Error(
      `fixtures/line-history.json missing — run "npm run gen-line-history" first (source: fixtures/picks.csv)`,
    );
  }
  cache = JSON.parse(fs.readFileSync(PATHS.lineHistory, "utf8")) as LineHistoryEntry[];
  return cache;
}

/** Test-only hook to inject a custom line-history set without touching disk. */
export function __setLineHistoryForTests(entries: LineHistoryEntry[]): void {
  cache = entries;
}

/**
 * Look up a recorded closing line for {match, selection}. Normalized
 * (trim + lowercase + collapsed whitespace) exact match only — a small,
 * honestly-narrow alias surface per ARCHITECTURE.md "Residual risks". No
 * fuzzy matching, no interpolation: a miss is a miss.
 */
export function findClosingLine(match: string, selection: string): LineHistoryEntry | undefined {
  const mk = normalizeKey(match);
  const sk = normalizeKey(selection);
  return loadLineHistory().find((e) => e.match_key === mk && e.selection_key === sk);
}

/** Human-readable list of covered markets, for the UNGRADED refusal's `covered_markets_hint`. */
export function coveredMarketsHint(limit = 8): string[] {
  const entries = loadLineHistory();
  return entries.slice(0, limit).map((e) => `${e.match} — ${e.selection}`);
}
