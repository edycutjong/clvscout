/**
 * Vendored from EdgeLedger's `engine/edge.ts` (verified Injective build) —
 * only the piece CLV Scout needs: converting decimal odds to implied
 * probability. Ported, not modified.
 *
 * Source: hackquest-injective-global-cup-2026/specs/hackquest-injective-edgeledger/build/engine/edge.ts
 */

/** Book-implied probability of a single decimal price (includes the vig). */
export function impliedProb(decimalOdds: number): number {
  if (!(decimalOdds > 1)) throw new Error(`invalid decimal odds: ${decimalOdds}`);
  return 1 / decimalOdds;
}
