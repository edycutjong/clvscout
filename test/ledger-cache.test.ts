/**
 * Coverage of db/ledger.ts's cache-handling branches: the corrupt-cache catch,
 * the empty-cache fall-through, and writeSettledLedgerCache. Each test snapshots
 * fixtures/ledger-settled.json and restores it, so the real seed cache is never
 * left mutated.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import { loadOrBuildSettledLedger, buildSettledLedger, writeSettledLedgerCache } from "../db/ledger";
import { PATHS } from "../config";

let original: Buffer | null = null;
const existed = fs.existsSync(PATHS.settledCache);

beforeAll(() => {
  original = existed ? fs.readFileSync(PATHS.settledCache) : null;
});

function restore(): void {
  if (original) fs.writeFileSync(PATHS.settledCache, original);
  else if (fs.existsSync(PATHS.settledCache)) fs.rmSync(PATHS.settledCache);
}

afterEach(restore);
afterAll(restore);

describe("loadOrBuildSettledLedger — cache fallbacks", () => {
  it("returns the cached artifact when present and non-empty", () => {
    // seed a valid cache and confirm it is returned verbatim (rows preserved)
    const built = buildSettledLedger();
    writeSettledLedgerCache(built);
    const loaded = loadOrBuildSettledLedger();
    expect(loaded.rows.length).toBe(built.rows.length);
    expect(loaded.settledAt).toBe(built.settledAt);
  });

  it("falls through to a live compute when the cache is corrupt JSON", () => {
    fs.writeFileSync(PATHS.settledCache, "{ not valid json");
    const led = loadOrBuildSettledLedger();
    expect(led.rows.length).toBe(24); // freshly built from picks.csv
  });

  it("falls through to a live compute when the cache has no rows", () => {
    fs.writeFileSync(PATHS.settledCache, JSON.stringify({ rows: [], truthTable: null }));
    const led = loadOrBuildSettledLedger();
    expect(led.rows.length).toBe(24);
  });

  it("builds live when there is no cache file at all", () => {
    if (fs.existsSync(PATHS.settledCache)) fs.rmSync(PATHS.settledCache);
    const led = loadOrBuildSettledLedger();
    expect(led.rows.length).toBe(24);
  });
});

describe("writeSettledLedgerCache", () => {
  it("writes a JSON artifact that round-trips back through the loader", () => {
    const built = buildSettledLedger();
    writeSettledLedgerCache(built);
    const onDisk = JSON.parse(fs.readFileSync(PATHS.settledCache, "utf8"));
    expect(onDisk.rows.length).toBe(built.rows.length);
    expect(onDisk.settledAt).toBe(built.settledAt);
  });
});
