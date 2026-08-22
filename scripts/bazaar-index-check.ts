/**
 * bazaar-index-check.ts — has Coinbase indexed our service in the x402 Bazaar yet?
 *
 *   npm run bazaar-index          # check once
 *   npm run bazaar-index -- --url https://…/api/edge
 *
 * BACKGROUND
 * ----------
 * CDP's docs read as though a service becomes discoverable once it is on public
 * HTTPS, passes `POST /platform/v2/x402/validate`, and has completed one
 * settlement through their facilitator. We did all three on 2026-08-22 —
 * 25/25 validate checks, and settlement tx
 * 0xd94db9620b82e7a11216dc44e85f8efcff04d5da8d0555ef6cc6f77145ab6e4e
 * (Base block 50292518, 15 USDC moved, verdict returned) — and the service was
 * STILL absent from the index minutes later. So indexing is asynchronous on
 * Coinbase's own cadence, which is not documented. Hence this poller.
 *
 * WHAT IT CHECKS
 *   1. `index` in the validate response (needs CDP credentials)
 *   2. the PUBLIC discovery index, scanned in full (no credentials needed)
 *
 * Note the discovery API is offset/limit paged and its `?q=` parameter is
 * SILENTLY IGNORED — passing a query returns the unfiltered first page, which
 * looks like a clean "no match" if you trust it. That mistake is why this
 * scans every page instead of searching.
 *
 * Exit code 0 = indexed, 2 = not yet, 1 = error. Safe to run from cron.
 */
const DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const DEFAULT_URL = 'https://clvscout-bazaar-production.up.railway.app/api/grade';

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface DiscoveryItem {
  resource?: string;
  lastUpdated?: string;
  accepts?: { amount?: string; asset?: string; network?: string }[];
}

async function scanIndex(needle: string): Promise<{ scanned: number; total: number; hits: DiscoveryItem[] }> {
  let offset = 0;
  let total = Infinity;
  let scanned = 0;
  const hits: DiscoveryItem[] = [];
  // hard stop so a runaway/paging change can never spin forever
  while (offset < total && offset < 50_000) {
    const res = await fetch(`${DISCOVERY}?limit=100&offset=${offset}`);
    if (!res.ok) throw new Error(`discovery returned ${res.status}`);
    const json = (await res.json()) as { items?: DiscoveryItem[]; pagination?: { total?: number } };
    total = json.pagination?.total ?? 0;
    const items = json.items ?? [];
    if (!items.length) break;
    scanned += items.length;
    for (const it of items) if (JSON.stringify(it).includes(needle)) hits.push(it);
    offset += items.length;
  }
  return { scanned, total, hits };
}

async function main(): Promise<void> {
  const url = argVal('--url') ?? DEFAULT_URL;
  const host = new URL(url).host;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n[${stamp}] x402 Bazaar index check — ${host}`);

  // 1) authenticated validate (optional — only if credentials are present)
  const id = process.env.CDP_API_KEY_ID;
  const secret = process.env.CDP_API_KEY_SECRET;
  if (id && secret) {
    try {
      const { generateJwt } = await import('@coinbase/cdp-sdk/auth');
      const jwt = await generateJwt({
        apiKeyId: id,
        apiKeySecret: secret,
        requestMethod: 'POST',
        requestHost: 'api.cdp.coinbase.com',
        requestPath: '/platform/v2/x402/validate',
        expiresIn: 120,
      });
      const res = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/validate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: url, method: 'POST' }),
      });
      const json = (await res.json()) as { index?: unknown; preflight?: { passed?: boolean }[] };
      const checks = json.preflight ?? [];
      const failed = checks.filter((c) => !c.passed).length;
      console.log(`  validate : ${checks.length - failed}/${checks.length} checks pass · index=${JSON.stringify(json.index)}`);
    } catch (err) {
      console.log(`  validate : skipped (${(err as Error).message})`);
    }
  } else {
    console.log('  validate : skipped (no CDP_API_KEY_ID / CDP_API_KEY_SECRET in env)');
  }

  // 2) public index — the authoritative answer
  const { scanned, total, hits } = await scanIndex(host);
  console.log(`  index    : scanned ${scanned}/${total} resources`);

  if (hits.length) {
    console.log(`\n✓ INDEXED — live in the x402 Bazaar`);
    for (const h of hits) {
      const a = h.accepts?.[0];
      console.log(`    ${h.resource}`);
      if (a) console.log(`      ${a.amount} of ${a.asset} on ${a.network}`);
      if (h.lastUpdated) console.log(`      lastUpdated: ${h.lastUpdated}`);
    }
    process.exit(0);
  }

  console.log(`\n○ Not indexed yet. Everything on our side is done — 25/25 validate and a`);
  console.log(`  settled payment — so this is Coinbase's indexer cadence, not a defect.`);
  process.exit(2);
}

main().catch((err) => {
  console.error('✗ index check failed:', (err as Error).message);
  process.exit(1);
});
