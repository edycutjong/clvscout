/**
 * Covers demoRunner's settlement-label branch for the credentialed case: when
 * OKX facilitator creds are configured, a successful paid round-trip reports
 * "settled via OKX facilitator" rather than the local-pending label.
 *
 * The server's settle leg is pointed at a mocked facilitator (only OKX-host
 * fetches are faked; the demo runner's own localhost round-trip uses the real
 * fetch), so no live credentials or network are needed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";

const PORT = 4094;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Server;
let runDemo: typeof import("../api/demoRunner").runDemo;
let PATHS: typeof import("../config").PATHS;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv("API_BASE_URL", BASE);
  vi.stubEnv("OKX_API_KEY", "test-key");
  vi.stubEnv("OKX_SECRET_KEY", "test-secret");
  vi.stubEnv("OKX_PASSPHRASE", "test-pass");
  // Fake ONLY the official OKX facilitator REST surface the SDK's
  // OKXFacilitatorClient calls (getSupported / verify / settle); everything
  // else (the demo runner's localhost probe/replay) uses the real fetch. This
  // exercises the credentialed path end-to-end with no live creds or network.
  vi.stubGlobal("fetch", (async (url: string | URL | Request, opts?: RequestInit) => {
    const s = String(url);
    let host = "";
    try { host = new URL(s).hostname; } catch { /* relative/opaque URL */ }
    if (host === "web3.okx.com") {
      if (s.includes("/supported")) {
        return {
          ok: true,
          json: async () => ({
            kinds: [
              { x402Version: 2, scheme: "exact", network: "eip155:196" },
              { x402Version: 2, scheme: "exact", network: "eip155:1952" },
            ],
            extensions: [],
            signers: {},
          }),
        } as Response;
      }
      if (s.includes("/verify")) {
        return { ok: true, json: async () => ({ isValid: true }) } as Response;
      }
      // /settle (and any other x402 endpoint)
      return { ok: true, json: async () => ({ success: true, status: "success", transaction: "0xfeedface" }) } as Response;
    }
    return realFetch(url as string, opts);
  }) as typeof fetch);

  const { createApp } = await import("../api/server");
  ({ runDemo } = await import("../api/demoRunner"));
  ({ PATHS } = await import("../config"));
  const app = createApp();
  server = app.listen(PORT);
  await new Promise<void>((resolve) => server.once("listening", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const p of [PATHS.buyerStore, PATHS.receiptLog, PATHS.usedNonces]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe("runDemo — with facilitator creds", () => {
  it("labels the settlement as 'settled via OKX facilitator'", async () => {
    const out = await runDemo("grade", { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 });
    expect(out.paid_status).toBe(200);
    expect(out.settlement).toBe("settled via OKX facilitator");
  });
});
