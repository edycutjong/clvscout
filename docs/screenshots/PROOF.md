# On-Chain Settlement Proof — CLV Scout (X Layer mainnet)

Captured **2026-07-16** against the live deployment `https://api.clvscout.edycu.dev`.
Every value below is raw tool/CLI output — nothing is hand-typed. The transaction is
independently verifiable on the X Layer explorer.

**Explorer:** <https://web3.okx.com/explorer/x-layer/tx/0x33e65fc96d1abed0bb5229337f37f0106e1fc38648095dd43567042245c903d8>

Screenshots in this folder:
- `onchain-receipt.png` — the settlement receipt summary
- `live-proof-page.png` — the live proof surface (`api.clvscout.edycu.dev/`)

---

## 1. Unpaid probe → real 402 challenge

`POST /api/grade` with no payment returns the x402 challenge (X Layer mainnet, USD₮0, 10000 atomic = $0.01):

```json
{"x402Version":2,"error":"payment_required","resource":{"url":"http://api.clvscout.edycu.dev/api/grade","description":"CLV Scout — grade a placed World Cup bet against the closing line; returns grade, CLV%, and the settled truth table for that grade.","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"eip155:196","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","amount":"10000","payTo":"0x000000000000000000000000000000000000dEaD","maxTimeoutSeconds":120,"extra":{"name":"USD₮0","version":"1"}}]}
```

## 2. TEE-signed EIP-3009 authorization (OKX Agentic Wallet)

`onchainos payment pay` signs the `TransferWithAuthorization` from the funded wallet via TEE:

```json
{
  "from": "0x3e86b9fb8092733adca846a77d64b7c56e1ddbeb",
  "to": "0x000000000000000000000000000000000000dEaD",
  "value": "10000",
  "validAfter": "0",
  "validBefore": "1784171471",
  "nonce": "0x580cbce05a2eb2603e78bdba178f7ab251ece566e7e36ea7de6e4b03e83f87ac",
  "signature": "0x411377736b5fcf15f654aa4656bfac8cf83079da2ad659683093d86a480819b807b37aff7ba39d4eb616b4d75e58bc6db08e6efd7a3677d46ffc1fcf115fe0991b"
}
```
Signing wallet: `0x3e86b9fb8092733adca846a77d64b7c56e1ddbeb`, header name `PAYMENT-SIGNATURE` (replayed as `X-PAYMENT`).

## 3. Paid replay → HTTP 200 (real grade)

`POST /api/grade` with `X-PAYMENT` → **200**:

```json
{"clv_grade":"C","clv_pct":-2.08,"beat_close":false,"close_odds":1.92,"close_source":"settled_ledger_snapshot","grade_truth":{"grade":"C","n":3,"win_rate":0.333,"roi_pct":-37.33,"low_sample":true},"advice":"C bets in this grade band have negative expectancy (-37.3% ROI over 3 settled rows) — size down or skip.","provenance":{"line_history_source":"settled_ledger_snapshot","snapshot_at":"2026-07-01T18:55:00.000Z"},"you":{"your_grades":1,"your_beat_close_rate":0}}
```

Response header `X-PAYMENT-RESPONSE` (base64) decodes to — note **`is_placeholder: false`** (real Facilitator settlement, not a local placeholder):

```json
{"status":"pending","transaction":"","network":"eip155:196","payer":"0x3e86b9fb8092733adca846a77d64b7c56e1ddbeb","is_placeholder":false}
```

## 4. On-chain transaction (X Layer mainnet) — `SUCCESS`

`onchainos wallet history --chain xlayer` shows the settled USD₮0 transfer:

```json
{
  "assetChange": [{ "coinAmount": "0.010000", "coinSymbol": "USDT", "direction": "OUT" }],
  "from": "0x3e86b9fb8092733adca846a77d64b7c56e1ddbeb",
  "to": "0x000000000000000000000000000000000000dead",
  "txHash": "0x33e65fc96d1abed0bb5229337f37f0106e1fc38648095dd43567042245c903d8",
  "txStatus": "SUCCESS",
  "txTime": "1784171368000"
}
```

Balance delta (same wallet): **6.10 → 6.09 USD₮0** (−0.01, the paid grade call).

## 5. Product-native re-verification (free)

`POST /api/receipts/verify` re-checks the tx live via the OKX Facilitator:

```json
{"txHash":"0x33e65fc96d1abed0bb5229337f37f0106e1fc38648095dd43567042245c903d8","live":true,"source":"OKX Facilitator GET /settle/status","explorer_url":"https://web3.okx.com/explorer/x-layer/tx/0x33e65fc96d1abed0bb5229337f37f0106e1fc38648095dd43567042245c903d8"}
```

Reproduce:

```bash
curl -s -X POST https://api.clvscout.edycu.dev/api/receipts/verify \
  -H "Content-Type: application/json" \
  -d '{"txHash":"0x33e65fc96d1abed0bb5229337f37f0106e1fc38648095dd43567042245c903d8"}'
```
