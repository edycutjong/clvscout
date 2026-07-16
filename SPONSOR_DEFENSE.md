# SPONSOR DEFENSE — Why ONLY OKX (CLV Scout)

> CLV Scout stands on the **same OKX foundation as our primary listing**: the `@okxweb3/x402-express` payment middleware, the OKX Facilitator for signature verification + on-chain settlement, the `exact`/EIP-3009 scheme on X Layer, USD₮0 zero-gas settlement, a full testnet + Mock-Merchant rehearsal, and the Onchain OS listing pipeline with public sold counts. Rather than re-argue those shared surfaces here, this brief focuses on what's **distinctly CLV Scout's** — the economics that make a 1¢ product possible *only* on OKX.

## The 1¢ argument (the part only OKX makes possible)

1. **`price: "$0.01"` with real settlement** — the SDK converts a one-cent USD string to atomic USD₮0 and the Facilitator settles it on X Layer per call. On any general-purpose EVM rail, a $0.01 payment is un-economic the moment anyone pays gas.
2. **USD₮0 zero-gas promo** (`0x779ded0c…3736`) — the buyer's marginal cost is exactly one cent. That's what makes "audit a tout's last 25 picks for $0.20" a rational agent behavior — and volume × sold-count is precisely what the Revenue Rocket track scores.
3. **Multi-route pricing in one middleware** — `"$0.01"` grade and `"$0.20"` audit are two entries in the same routes map; a tiered pricing architecture costs a config block, not an integration.
4. **Public sold counts on the marketplace** — the volume thesis is *verifiable by judges* without trusting us; the listing page is the benchmark.
5. **Same `exact`/EIP-3009 wire as the primary** — one payment adapter, two listings; plus the shared v2 modules: `X-PAYMENT`-identity BuyerLens and Facilitator `GET /settle/status` receipt re-verification.
6. **A2MCP composability** — other ASPs (tipsters, copy-trade agents) can call CLV Scout mid-flow and inherit its calibration; the marketplace's Agent-ID addressing is what makes agent→agent consumption of a 1¢ grader plausible.
7. **Batch `aggr_deferred` (Tier 2)** — the crawled decision matrix recommends Batch for exactly this product's shape ("very small per-call amount + very high frequency", SDK ✅ HTTP Seller): Session-Key per-call signatures, TEE-aggregated into one on-chain tx, throughput "not limited by block time". A $0.005 streamed grader is only possible on a rail that ships this primitive.

## Take OKX out…

…and the product dies at the till: you'd need a micro-payment rail that clears $0.01 profitably (doesn't exist off the zero-gas promo), a Session-Key + TEE aggregation stack for sub-cent streaming, plus the shared OKX foundation named above (middleware, Facilitator settlement, `exact`/EIP-3009, USD₮0 zero-gas, testnet rehearsal, Onchain OS listing). The grader is portable; the **economics are OKX-specific** — which is the honest reason this is an OKX-first product.

## Honest limitations

1. Grade quality is bounded by **our line-history coverage** — narrow market set in v1, stated in the listing and `/api/calibration`.
2. 1¢ pricing assumes the zero-gas promo persists through the judging window ("limited time" per docs); if it lapses, unit economics need repricing — acknowledged, monitored.
3. Second listing = second opaque review; we sequence it strictly after the primary passes rather than pretending the risk away.
