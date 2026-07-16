/**
 * BuyerLens-lite — payment-signature identity, no auth stack (PRD.md §8,
 * ARCHITECTURE.md §BuyerLens wiring, ported concept from the OKX EdgeLedger
 * sibling's ARCHITECTURE.md — that module isn't built yet there either, so
 * this is our own faithful implementation of the documented pattern, self-
 * contained).
 *
 * After `api/rails/okx.ts` verifies a payment, `authorization.from` (the
 * ECDSA-recovered EIP-3009 signer) is treated as an unforgeable buyer
 * identity — never a user-supplied address. Every paid `/api/grade` call
 * appends a row here; the `you` block and free `/api/me` read it back.
 */
import fs from "node:fs";
import { PATHS } from "../config";
import type { Grade } from "../engine/types";

export interface BuyerRow {
  from: string;
  match: string;
  selection: string;
  clv_grade: Grade | "UNGRADED";
  clv_pct?: number;
  beat_close?: boolean;
  at: string;
}

function readAll(): BuyerRow[] {
  try {
    return JSON.parse(fs.readFileSync(PATHS.buyerStore, "utf8")) as BuyerRow[];
  } catch {
    return [];
  }
}

function writeAll(rows: BuyerRow[]): void {
  fs.mkdirSync(PATHS.fixtures, { recursive: true });
  fs.writeFileSync(PATHS.buyerStore, JSON.stringify(rows, null, 2));
}

/** Append a graded call to the buyer's history. Invariant 6: verified payment only. */
export function recordBuyerGrade(row: BuyerRow): void {
  const rows = readAll();
  rows.push(row);
  writeAll(rows);
}

export interface YouBlock {
  your_grades: number;
  your_beat_close_rate: number;
}

/** The `you` block embedded in paid `/api/grade` responses. */
export function buildYouBlock(address: string | undefined): YouBlock {
  if (!address) return { your_grades: 0, your_beat_close_rate: 0 };
  const rows = readAll().filter((r) => r.from.toLowerCase() === address.toLowerCase());
  const graded = rows.filter((r) => r.clv_grade !== "UNGRADED");
  const beat = graded.filter((r) => r.beat_close).length;
  return {
    your_grades: rows.length,
    your_beat_close_rate: graded.length ? Math.round((beat / graded.length) * 1000) / 1000 : 0,
  };
}

/** Free `POST /api/me`. */
export function getBuyerHistory(address: string): BuyerRow[] {
  return readAll().filter((r) => r.from.toLowerCase() === address.toLowerCase());
}

/** `{forget:true}` deletes the address's rows (privacy note, invariant 6). */
export function forgetBuyer(address: string): number {
  const rows = readAll();
  const kept = rows.filter((r) => r.from.toLowerCase() !== address.toLowerCase());
  writeAll(kept);
  return rows.length - kept.length;
}
