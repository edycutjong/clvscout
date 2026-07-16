/**
 * Receipt capture + independent re-verification (PRD.md §8, ARCHITECTURE.md
 * §Receipt capture + independent re-verification). Thin, named module so the
 * "free /api/receipts/verify re-checks settlements via Facilitator GET
 * /settle/status" surface has its own file per the documented shape, even
 * though the actual Facilitator call lives in `api/rails/okx.ts` (the only
 * place that holds OKX credentials).
 */
import { fetchSettleStatus as railFetchSettleStatus } from "./rails/okx";
import { EXPLORER } from "../config";

export const fetchSettleStatus = railFetchSettleStatus;

export function EXPLORER_URL_FOR(txHash: string): string | null {
  if (txHash.startsWith("local:")) return null; // no explorer entry for a local placeholder receipt
  return `${EXPLORER}/tx/${txHash}`;
}
