# `api/` — HTTP layer

The Express app and the OKX x402 payment rail. Pure HTTP + payments — all grading
math lives in [`../engine/`](../engine) and persistence in [`../db/`](../db); this
layer only wires them behind paid/free routes.

> **Built on the official OKX Payment SDK.** [`rails/okx.ts`](rails/okx.ts) wires the
> published `@okxweb3/x402-express` `paymentMiddleware` over an `x402ResourceServer`
> with the server-side `ExactEvmScheme` (`@okxweb3/x402-evm/exact/server`) and the
> `OKXFacilitatorClient` (`@okxweb3/x402-core`) — the same SDK the OKX.AI listing
> review verifies against. When no OKX Developer Portal credentials are configured
> (local/CI/demo), a drop-in `LocalFacilitatorClient` does REAL EIP-712 signature
> recovery but reports settlement honestly as `pending`/`local:` (never a fabricated
> on-chain receipt), so the whole payment leg still boots and unit-tests offline.

## Files

| File | Responsibility |
|---|---|
| [`server.ts`](server.ts) | `createApp()` — builds the Express app: CORS + JSON, mounts the x402 gate, the routes, and serves the [`../web/`](../web) proof page. |
| [`main.ts`](main.ts) | Thin bootstrap for `npm run api` / `dev` — binds `createApp()` to a socket. Kept separate so `createApp` stays import-safe for tests. |
| [`routes.ts`](routes.ts) | The request handlers (`gradeHandler`, `auditHandler`, `calibrationHandler`, `meHandler`, `receiptsVerifyHandler`, `demoRunHandler`, health / 405). |
| [`rails/okx.ts`](rails/okx.ts) | The official-SDK x402 rail: per-route `buildRoutes()`, `x402ResourceServer` + `ExactEvmScheme`, facilitator selection (`OKXFacilitatorClient` / `LocalFacilitatorClient`), `warmFacilitator()`, and the `okxPayGate()` = SDK `paymentMiddleware`. |
| [`rails/localFacilitator.ts`](rails/localFacilitator.ts) | Local-faithful `FacilitatorClient` used without OKX creds: real EIP-712/EIP-3009 signature recovery (`viem`), honest `pending`/`local:` settlement — plugs into the real SDK unchanged. |
| [`buyerlens.ts`](buyerlens.ts) | **BuyerLens** — records/reads a payer's grading history keyed off their X-PAYMENT identity (`recordBuyerGrade`, `buildYouBlock`, `getBuyerHistory`, `forgetBuyer`). |
| [`demoRunner.ts`](demoRunner.ts) | `runDemo()` — a real, server-side x402 round-trip (throwaway key) powering `POST /api/demo/run`, so the browser proof page shows live payments (browsers can't sign). |
| [`receipts.ts`](receipts.ts) | `fetchSettleStatus` re-export + `EXPLORER_URL_FOR` — the `/api/receipts/verify` helpers. |

## Routes

Mounted in `createApp()` ([`server.ts`](server.ts)):

| Method + Path | Gate | Handler | Returns |
|---|---|---|---|
| `POST /api/grade` | **$0.01 x402** | `gradeHandler` | One bet graded: `clv_grade` (A+…F), `clv_pct`, `beat_close`, the settled truth table for that band — or `clv_grade:"UNGRADED"` with a reason. |
| `POST /api/audit` | **$0.20 x402** | `auditHandler` | Up to 25 bets → CLV dossier: beat-close rate, grade distribution, weighted expectancy, origin-disclosed **Sharp Score**. |
| `GET /api/grade`, `GET /api/audit` | — | `methodNotAllowedHandler` | `405` (review-gate: a paid route never answers GET). |
| `POST /api/calibration` | free | `calibrationHandler` | The full grade→outcome truth table + methodology, computed live from the settled ledger. |
| `POST /api/me` | free | `meHandler` | **BuyerLens** — a payer's own grading history (`{forget:true}` deletes it). |
| `POST /api/receipts/verify` | free | `receiptsVerifyHandler` | Live re-check of a settlement via the Facilitator's `GET /settle/status`. |
| `POST /api/demo/run` | free | `demoRunHandler` | Server-side real x402 round-trip for the proof page (`runDemo`). |
| `GET /health`, `GET /api` | free | `healthHandler` / index | Liveness + route index. |
| `/*` (static) | — | `express.static` | Serves the [`../web/`](../web) proof page. |

## Payment flow (`POST /api/grade` · `POST /api/audit`)

```
Buyer --POST (no payment)-----> okxPayGate()   --> 402 challenge (x402Version:2, accepts: exact scheme, X Layer eip155:196)
Buyer --POST + X-PAYMENT------> okxPayGate()   --> verifyPayment (offline EIP-3009 recovery, viem)
                                   |               settlePayment --> receipt --> handler runs
```

`okxPayGate()` protects **only** the routes in `CLV_PAY_ROUTES` (`/api/grade`, `/api/audit`);
free routes pass through. It runs **before** business logic — an unpaid call never reaches
the grade engine. The gate is active whenever `PAY_RAIL === "okx"`.

### Verification & settlement (`rails/okx.ts`)

- **`verifyPayment`** — genuine **offline** EIP-712 recovery of the EIP-3009
  `TransferWithAuthorization` (`viem`'s `recoverTypedDataAddress`); no network call.
- **`settlePayment`** — calls the documented OKX **Facilitator REST** surface
  (`web3.okx.com/api/v6/pay/x402/{verify,settle,settle/status}`) when
  `OKX_API_KEY`/`OKX_SECRET_KEY`/`OKX_PASSPHRASE` are set; otherwise records an honestly
  labeled **local-pending** receipt. **Never fabricates an on-chain receipt** — the
  signature check runs for real either way.

## Testing

Handlers, the rail (every verify-rejection reason), BuyerLens, and both settlement paths
are covered by Vitest — real EIP-3009 signing, a purpose-seeded in-memory store, and a
mocked fetch for the credentialed path. Run `npm run ci` from the repo root
(currently 124 tests, 100% coverage).
