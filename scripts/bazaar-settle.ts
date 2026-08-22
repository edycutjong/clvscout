/**
 * bazaar-settle.ts — the ONE real settlement that unlocks the x402 Bazaar listing.
 *
 * CLV Scout edition: settles /api/grade at $5. The sibling EdgeLedger script is
 * identical bar the route and body — both read every payment parameter from the
 * live challenge rather than hardcoding it.
 *
 *   BAZAAR_BUYER_PK=0x… npx tsx scripts/bazaar-settle.ts
 *   BAZAAR_BUYER_PK=0x… npx tsx scripts/bazaar-settle.ts --url https://…/api/edge
 *   npx tsx scripts/bazaar-settle.ts --dry-run     # quote + balance check only, signs nothing
 *
 * WHY THIS EXISTS
 * ---------------
 * Coinbase CDP validates an endpoint happily (25/25 preflight checks), but it
 * will not INDEX the service in the Bazaar until it has observed one successful
 * settlement through its own facilitator. Until then `index` stays `null` and
 * the listing is invisible. So the seller has to buy from themselves exactly
 * once. The money is not lost: `payTo` is our own receiver address, so the
 * round-trip returns the full amount minus Base gas (cents).
 *
 * WHAT IT DOES
 * ------------
 *   1. probes the endpoint with VALID params -> real 402 challenge
 *   2. reads accepts[0] (network / asset / amount / payTo / extra) — never
 *      hardcodes them, so a repriced or re-networked rail still works
 *   3. checks the buyer's USDC balance on Base and refuses if short
 *   4. signs a genuine EIP-3009 TransferWithAuthorization over the USDC domain
 *      taken from the challenge's `extra` ({name, version})
 *   5. replays with X-PAYMENT, prints the verdict, the PAYMENT-RESPONSE receipt
 *      and a Basescan link
 *
 * HONESTY: this never fabricates a receipt. If the buyer key is missing, funds
 * are short, or settlement fails, it says so and exits non-zero.
 *
 * SECURITY: the private key is read from the environment and is never printed,
 * logged, or written to disk. Use a throwaway wallet funded with just enough
 * USDC — it only ever signs a transfer to our own payTo address.
 */
import { execFileSync } from 'node:child_process';
import { createPublicClient, http, formatUnits, encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** EIP-3009, the `exact` scheme's transfer authorization. */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * Sign the EIP-3009 authorization with the OKX Agentic Wallet instead of a raw
 * private key. `onchainos wallet sign-message --type eip712` produces a
 * genuine EIP-712 signature that recovers to the wallet address (verified), so
 * the key never leaves OKX custody and nothing sensitive touches a shell.
 * Preferred over --pk; use `--wallet <address>`.
 */
function signViaAgenticWallet(
  from: string,
  chainId: number,
  domain: Record<string, unknown>,
  message: Record<string, string>,
): `0x${string}` {
  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    domain,
    message,
  };
  const out = execFileSync(
    'onchainos',
    ['wallet', 'sign-message', '--type', 'eip712', '--chain', String(chainId),
     '--from', from, '--message', JSON.stringify(typedData), '--force'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(out.trim().split('\n').pop() as string) as
    { ok?: boolean; data?: { signature?: string }; error?: string };
  if (!parsed.ok || !parsed.data?.signature) {
    throw new Error(`agentic wallet refused to sign: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed.data.signature as `0x${string}`;
}

const DEFAULT_URL = 'https://clvscout-bazaar-production.up.railway.app/api/grade';
const DEFAULT_BODY = { match: 'BRA vs SRB', selection: 'Brazil ML', odds_taken: 1.55 };

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function normalizePk(pk: string | undefined): `0x${string}` | undefined {
  if (!pk) return undefined;
  const t = pk.trim();
  const withPrefix = (t.startsWith('0x') ? t : `0x${t}`) as `0x${string}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix) ? withPrefix : undefined;
}

interface Accept {
  scheme: string;
  network: string;
  asset: `0x${string}`;
  amount: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

async function main(): Promise<void> {
  const url = argVal('--url') ?? DEFAULT_URL;
  const dryRun = process.argv.includes('--dry-run');

  console.log(`\nx402 Bazaar settlement — ${url}\n${'─'.repeat(64)}`);

  // 1) quote --------------------------------------------------------------
  const probe = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DEFAULT_BODY),
  });
  if (probe.status !== 402) {
    console.error(`✗ expected 402 from the quote probe, got ${probe.status}`);
    console.error((await probe.text()).slice(0, 400));
    process.exit(1);
  }
  const header = probe.headers.get('payment-required');
  const challenge = header
    ? (JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: Accept[] })
    : ((await probe.json()) as { accepts: Accept[] });
  const accept = challenge.accepts?.[0];
  if (!accept) {
    console.error('✗ challenge carried no accepts[] entry');
    process.exit(1);
  }

  const chainId = Number(accept.network.split(':')[1]);
  const decimals = 6; // USDC
  const human = `${formatUnits(BigInt(accept.amount), decimals)} ${accept.extra?.name ?? 'USDC'}`;
  console.log(`  quote      : ${human}`);
  console.log(`  network    : ${accept.network} (chainId ${chainId})`);
  console.log(`  asset      : ${accept.asset}`);
  console.log(`  payTo      : ${accept.payTo}`);
  console.log(`  scheme     : ${accept.scheme}`);

  // 2) buyer + balance ----------------------------------------------------
  // Two signing modes. --wallet is preferred: the OKX Agentic Wallet signs the
  // EIP-712 authorization itself, so no private key is ever exported or handled.
  const walletAddr = argVal('--wallet');
  const buyerPk = normalizePk(process.env.BAZAAR_BUYER_PK);
  if (!walletAddr && !buyerPk) {
    console.log(`\n  buyer      : NOT CONFIGURED`);
    console.log('\n✗ Choose a signer:');
    console.log('    --wallet 0x…            sign with the OKX Agentic Wallet (no key export)');
    console.log('    BAZAAR_BUYER_PK=0x…     sign locally with a raw private key');
    process.exit(dryRun ? 0 : 1);
  }
  const buyerAddress = (walletAddr ?? privateKeyToAccount(buyerPk as `0x${string}`).address) as `0x${string}`;
  const rpc = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
  const client = createPublicClient({ transport: http(rpc) });
  const balance = (await client.readContract({
    address: accept.asset,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [buyerAddress],
  })) as bigint;

  console.log(`  buyer      : ${buyerAddress}  (${walletAddr ? 'OKX Agentic Wallet' : 'local key'})`);
  console.log(`  balance    : ${formatUnits(balance, decimals)} USDC on Base`);

  if (balance < BigInt(accept.amount)) {
    console.log(`\n✗ Insufficient USDC. Need ${human}, have ${formatUnits(balance, decimals)}.`);
    console.log('  Fund the buyer address above with USDC on Base and re-run.');
    process.exit(1);
  }
  if (dryRun) {
    console.log('\n✓ Dry run: quote read and buyer funded. Nothing signed. Drop --dry-run to settle.');
    return;
  }

  // 3) sign ---------------------------------------------------------------
  console.log(`\n  Signing EIP-3009 authorization via ${walletAddr ? 'the OKX Agentic Wallet' : 'the local key'}…`);
  const now = Math.floor(Date.now() / 1000);
  const nonce = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [buyerAddress, BigInt(now)]),
  );
  const authorization = {
    from: buyerAddress,
    to: accept.payTo,
    value: accept.amount,
    validAfter: String(now - 60),
    validBefore: String(now + (accept.maxTimeoutSeconds ?? 300)),
    nonce,
  };
  // The domain comes from the CHALLENGE, not a constant — USDC on Base is
  // {name: "USD Coin", version: "2"}, which differs from X Layer's USD₮0.
  const domain = {
    name: accept.extra?.name ?? 'USD Coin',
    version: accept.extra?.version ?? '2',
    chainId,
    verifyingContract: accept.asset,
  };
  const signature = walletAddr
    ? signViaAgenticWallet(buyerAddress, chainId, domain, {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        nonce: authorization.nonce,
      })
    : await privateKeyToAccount(buyerPk as `0x${string}`).signTypedData({
        domain,
        types: AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
      });

  const paymentPayload = Buffer.from(
    JSON.stringify({ x402Version: 2, accepted: accept, payload: { signature, authorization } }),
  ).toString('base64');

  // 4) replay -------------------------------------------------------------
  console.log('  Replaying with payment…');
  const t0 = performance.now();
  const paid = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PAYMENT': paymentPayload,
      'PAYMENT-SIGNATURE': paymentPayload,
    },
    body: JSON.stringify(DEFAULT_BODY),
  });
  const ms = Math.round(performance.now() - t0);
  const receiptHeader = paid.headers.get('payment-response') ?? paid.headers.get('x-payment-response');
  const text = await paid.text();

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  status     : ${paid.status} (${ms}ms)`);

  if (paid.status !== 200) {
    console.log(`\n✗ Settlement did NOT complete.`);
    console.log(text.slice(0, 600));
    process.exit(1);
  }

  let txHash: string | undefined;
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8')) as Record<string, unknown>;
      txHash = (receipt.transaction ?? receipt.txHash ?? receipt.tx) as string | undefined;
      console.log(`  receipt    : ${JSON.stringify(receipt).slice(0, 300)}`);
    } catch {
      console.log(`  receipt    : ${receiptHeader.slice(0, 120)} (unparsed)`);
    }
  }

  try {
    const body = JSON.parse(text) as { clv_grade?: string; clv_pct?: number; beat_close?: boolean };
    console.log(`  graded     : ${body.clv_grade} (clv ${body.clv_pct}%, beat_close=${body.beat_close})`);
  } catch {
    console.log(`  body       : ${text.slice(0, 200)}`);
  }

  if (txHash) console.log(`  explorer   : https://basescan.org/tx/${txHash}`);

  console.log('\n✓ Settled. Now re-run the CDP validate call — `index` should stop being null');
  console.log('  and the service should appear in GET /platform/v2/x402/discovery/resources.');
}

main().catch((err) => {
  console.error('\n✗ bazaar-settle failed:', (err as Error).message);
  process.exit(1);
});
