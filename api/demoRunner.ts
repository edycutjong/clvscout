/**
 * api/demoRunner.ts — the engine behind the browser proof page (`web/`).
 *
 * A browser cannot easily sign an EIP-3009 `TransferWithAuthorization`, so the
 * server performs the SAME real x402 round-trip that `scripts/buyer.ts` does —
 * probe the paid route unpaid, read the real 402 challenge, sign a throwaway
 * EIP-3009 authorization with `viem`, and replay with `X-PAYMENT` — then hands
 * the page the ACTUAL 200 JSON. Nothing here is mocked: the payment signature
 * is verified for real by `api/rails/okx.ts` (`recoverTypedDataAddress`), and
 * the grade/audit numbers are the unmodified handler output. Settlement is the
 * honestly-labeled `local_pending` receipt when no facilitator creds are set
 * (same posture as the CLI).
 *
 * The only enrichment we add on top of the real response is the SETTLED RESULT
 * (win/loss/void) for each market, joined from the same committed ledger the
 * grader calibrates against (`fixtures/picks.csv`). That is what powers the
 * "won the bet, still graded C" chip and the "+12% raw ROI" tout headline — so
 * the on-screen dissonance is real data, not a page-side constant.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { normalizeKey } from "../engine/grade";
import { loadSettledLedgerFromCsv } from "../db/ledger";
import type { Result, SettledRow } from "../engine/types";
import { API_BASE_URL, HAS_REAL_FACILITATOR_CREDS } from "../config";

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

export interface PaidCallTrace {
  buyer_address: string;
  challenge_line: string; // human-readable, mirrors the CLI's "402 challenge: ..." line
  paid_status: number;
  settlement: string; // e.g. "local_pending (no facilitator creds — honestly labeled)"
  result: unknown; // the real 200 JSON from the handler
}

/**
 * Real 402 -> sign -> replay round-trip against this same running server.
 * Mirrors scripts/buyer.ts exactly; kept separate so the page never has to
 * ship signing crypto to the browser.
 */
async function payAndFetch(method: string, path: string, bodyObj: unknown): Promise<PaidCallTrace> {
  const body = JSON.stringify(bodyObj ?? {});
  const url = `${API_BASE_URL}${path}`;
  const account = privateKeyToAccount(generatePrivateKey());

  // 1) probe unpaid -> real 402 challenge
  const probe = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body });
  if (probe.status !== 402) {
    return {
      buyer_address: account.address,
      challenge_line: `unexpected status ${probe.status} on unpaid probe`,
      paid_status: probe.status,
      settlement: "n/a",
      result: await probe.json().catch(() => ({})),
    };
  }
  const challenge = (await probe.json()) as {
    accepts: { scheme: string; network: string; asset: string; amount: string; payTo: string; extra: Record<string, string> }[];
  };
  const required = challenge.accepts[0];

  // 2) sign the EIP-3009 TransferWithAuthorization locally (throwaway key)
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: required.payTo as `0x${string}`,
    value: required.amount,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 3600),
    nonce: randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: {
      name: required.extra.name,
      version: required.extra.version,
      chainId: Number(required.network.split(":")[1]),
      verifyingContract: required.asset as `0x${string}`,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const paymentPayload = { x402Version: 2, accepted: required, payload: { signature, authorization } };
  const header = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // 3) replay with X-PAYMENT -> real 200
  const paid = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-PAYMENT": header },
    body,
  });
  const amountUsd = (Number(required.amount) / 1e6).toFixed(2);
  return {
    buyer_address: account.address,
    challenge_line: `402 challenge: ${required.scheme} ${required.amount} atomic units of ${required.extra.name} (${"$"}${amountUsd}) on ${required.network} -> ${required.payTo}`,
    paid_status: paid.status,
    settlement: HAS_REAL_FACILITATOR_CREDS
      ? "settled via OKX facilitator"
      : "local_pending (no facilitator creds on this deployment — honestly labeled, never a fabricated receipt)",
    result: await paid.json(),
  };
}

// --- settled-result join (the only enrichment; real data from picks.csv) -----

let ledgerCache: SettledRow[] | undefined;
function settledRows(): SettledRow[] {
  if (!ledgerCache) ledgerCache = loadSettledLedgerFromCsv();
  return ledgerCache;
}

export function settledResultFor(match: string, selection: string): Result | null {
  const mk = normalizeKey(match);
  const sk = normalizeKey(selection);
  const row = settledRows().find((r) => normalizeKey(r.fixture) === mk && normalizeKey(r.side_label) === sk);
  return row ? row.result : null;
}

/** Flat 1-unit profit for a settled bet at `odds`: win -> odds-1, loss -> -1, void -> 0. */
function pnlFor(result: Result, odds: number): number {
  if (result === "win") return odds - 1;
  if (result === "loss") return -1;
  return 0;
}

export interface DemoRunResult extends PaidCallTrace {
  route: "grade" | "audit";
  // grade-only:
  settled_result?: Result | null;
  // audit-only:
  raw_record?: { wins: number; losses: number; voids: number; graded_for_pnl: number; raw_roi_pct: number };
  per_bet_results?: (Result | null)[];
}

/**
 * Run one demo call end-to-end and enrich with settled results so the page can
 * render the WON/graded-C dissonance and the "+X% raw ROI" tout headline from
 * real ledger data.
 */
export async function runDemo(route: "grade" | "audit", bodyObj: unknown): Promise<DemoRunResult> {
  if (route === "grade") {
    const trace = await payAndFetch("POST", "/api/grade", bodyObj);
    const b = (bodyObj ?? {}) as { match?: string; selection?: string };
    const settled_result = b.match && b.selection ? settledResultFor(b.match, b.selection) : null;
    return { ...trace, route, settled_result };
  }

  const trace = await payAndFetch("POST", "/api/audit", bodyObj);
  const bets = ((bodyObj ?? {}) as { bets?: { match: string; selection: string; odds_taken: number }[] }).bets ?? [];
  const perResults = bets.map((bet) => settledResultFor(bet.match, bet.selection));
  let wins = 0,
    losses = 0,
    voids = 0,
    settledN = 0,
    pnl = 0;
  bets.forEach((bet, i) => {
    const r = perResults[i];
    if (!r) return;
    settledN += 1;
    if (r === "win") wins += 1;
    else if (r === "loss") losses += 1;
    else voids += 1;
    pnl += pnlFor(r, bet.odds_taken);
  });
  const raw_roi_pct = settledN ? Math.round((pnl / settledN) * 1000) / 10 : 0;
  return {
    ...trace,
    route,
    per_bet_results: perResults,
    raw_record: { wins, losses, voids, graded_for_pnl: settledN, raw_roi_pct },
  };
}
