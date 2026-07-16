/**
 * CLV Scout — config & environment.
 *
 * Self-contained sibling of EdgeLedger (OKX edition): same rail shape
 * (`PAY_RAIL=okx`, X Layer `eip155:196`, USD₮0 zero-gas), separate service,
 * separate routes map, separate listing. Nothing here imports from the
 * EdgeLedger build folder — everything needed is vendored into this repo.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PAY_RAIL = process.env.PAY_RAIL ?? "okx";

export const PORT = Number(process.env.PORT ?? 4021);

/** eip155:1952 = X Layer rehearsal (testnet); eip155:196 = X Layer mainnet (listing). */
export const X402_NETWORK = process.env.X402_NETWORK ?? "eip155:196";
export const X402_VERSION = 2;

/** Receive address. Falls back to a documented burn-style placeholder for local/dev boot. */
export const PAYTO_ADDRESS =
  process.env.CLV_PAYTO ?? process.env.PAYTO_ADDRESS ?? "0x000000000000000000000000000000000000dEaD";

/** USD₮0 — zero-gas promo asset on X Layer (the reason 1¢ pricing works). */
export const USDT0_ADDRESS = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
/** USDG — fallback dual-`accepts` asset (also zero-gas per §A7). */
export const USDG_ADDRESS = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
export const ASSET_DECIMALS = 6;
export const ASSET_NAME = "USD₮0";
export const ASSET_VERSION = "1";

export const GRADE_PRICE_USD = 0.01;
export const AUDIT_PRICE_USD = 0.2;

/** OKX Developer Portal credentials — never committed; absence = faithful-local mode (documented). */
export const OKX_API_KEY = process.env.OKX_API_KEY ?? "";
export const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY ?? "";
export const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE ?? "";
export const HAS_REAL_FACILITATOR_CREDS = Boolean(OKX_API_KEY && OKX_SECRET_KEY && OKX_PASSPHRASE);

export const OKX_FACILITATOR_BASE = process.env.OKX_FACILITATOR_BASE ?? "https://web3.okx.com";
export const OKX_FACILITATOR_PREFIX = "/api/v6/pay/x402";

export const EXPLORER = "https://web3.okx.com/explorer/x-layer";

export const API_BASE_URL = process.env.API_BASE_URL ?? `http://localhost:${PORT}`;

export const AUDIT_MAX_BETS = 25;
export const LOW_SAMPLE_THRESHOLD = 10;

export const PATHS = {
  root: __dirname,
  fixtures: path.join(__dirname, "fixtures"),
  picksCsv: path.join(__dirname, "fixtures", "picks.csv"),
  lineHistory: path.join(__dirname, "fixtures", "line-history.json"),
  settledCache: path.join(__dirname, "fixtures", "ledger-settled.json"),
  buyerStore: path.join(__dirname, "fixtures", "buyers.json"),
  receiptLog: path.join(__dirname, "fixtures", "receipts.json"),
  usedNonces: path.join(__dirname, "fixtures", "used-nonces.json"),
};
