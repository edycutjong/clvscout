/**
 * A minimal local x402 buyer — mirrors the documented `onchainos payment
 * pay-local` shape (local EIP-3009 signing from a private key, no TEE) so
 * the full 402 -> sign -> replay round-trip is runnable end-to-end against
 * this build's faithful-local rail, exactly like a judge/buyer would.
 *
 * Usage:
 *   npx tsx scripts/buyer.ts POST /api/grade '{"match":"...","selection":"...","odds_taken":1.9}'
 *   npx tsx scripts/buyer.ts POST /api/audit '{"bets":[...]}'
 *
 * EVM_PRIVATE_KEY may be set in the environment (funded wallet for a real
 * deployment); if absent, a fresh throwaway key is generated so the demo is
 * always runnable offline/unfunded — the resulting receipt is honestly
 * labeled `local_pending`/`is_placeholder:true` in that case (see
 * api/rails/okx.ts settlePayment — never a fabricated confirmed receipt).
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API_BASE_URL } from "../config";

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

async function main(): Promise<void> {
  const [method, path, bodyArg] = process.argv.slice(2);
  if (!method || !path) {
    console.error("usage: tsx scripts/buyer.ts <METHOD> <path> [jsonBody]");
    process.exit(1);
  }
  const body = bodyArg ?? "{}";

  const pk = (process.env.EVM_PRIVATE_KEY as `0x${string}`) ?? generatePrivateKey();
  const account = privateKeyToAccount(pk);
  console.log(`buyer address: ${account.address}${process.env.EVM_PRIVATE_KEY ? "" : " (throwaway, generated this run)"}`);

  const url = `${API_BASE_URL}${path}`;

  // 1) probe unpaid -> capture the 402 challenge
  const probe = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body });
  if (probe.status !== 402) {
    console.log(`unexpected status ${probe.status} on unpaid probe (route may be free) — printing body:`);
    console.log(await probe.text());
    return;
  }
  const challenge = (await probe.json()) as {
    x402Version: number;
    accepts: { scheme: string; network: string; asset: string; amount: string; payTo: string; extra: Record<string, string> }[];
  };
  const required = challenge.accepts[0];
  console.log(`402 challenge: ${required.scheme} ${required.amount} atomic units of ${required.extra.name} on ${required.network} -> ${required.payTo}`);

  // 2) sign the EIP-3009 TransferWithAuthorization locally (pay-local style)
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

  // 3) replay with X-PAYMENT
  const paid = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-PAYMENT": header },
    body,
  });
  console.log(`paid replay: HTTP ${paid.status}`);
  console.log(await paid.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
