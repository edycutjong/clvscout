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
  // fake ONLY the OKX facilitator settle call; everything else (the demo
  // runner's localhost probe/replay) goes through the real fetch.
  vi.stubGlobal("fetch", (async (url: string | URL | Request, opts?: RequestInit) => {
    if (String(url).includes("web3.okx.com")) {
      return { json: async () => ({ success: true, status: "success", transaction: "0xfeedface" }) } as Response;
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
