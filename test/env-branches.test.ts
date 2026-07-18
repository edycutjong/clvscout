/**
 * Coverage of env-dependent branches evaluated at module-load time, driven by
 * re-importing the affected modules under a stubbed environment:
 *   - config.HAS_REAL_FACILITATOR_CREDS when all three OKX creds are present.
 *   - server.ts skipping the pay gate when PAY_RAIL !== "okx".
 *   - demoRunner's "unexpected status on unpaid probe" branch (reached when the
 *     probed route is not payment-gated, so it never returns 402).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config — facilitator creds present", () => {
  it("HAS_REAL_FACILITATOR_CREDS is true when all three OKX creds are set", async () => {
    vi.resetModules();
    vi.stubEnv("OKX_API_KEY", "k");
    vi.stubEnv("OKX_SECRET_KEY", "s");
    vi.stubEnv("OKX_PASSPHRASE", "p");
    const config = await import("../config");
    expect(config.HAS_REAL_FACILITATOR_CREDS).toBe(true);
  });
});

describe("server + demoRunner with PAY_RAIL != okx (gate not mounted)", () => {
  const PORT = 4096;
  const BASE = `http://127.0.0.1:${PORT}`;

  it("skips the pay gate and surfaces the demo-runner unexpected-status branch", async () => {
    vi.resetModules();
    vi.stubEnv("PAY_RAIL", "none");
    vi.stubEnv("API_BASE_URL", BASE);
    const { createApp } = await import("../api/server");
    const app = createApp();
    const server: Server = app.listen(PORT);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      // gate NOT mounted -> unpaid POST reaches the handler, which answers the
      // empty body with the 200 usage response (never a 402). Proves the
      // PAY_RAIL !== "okx" branch.
      const direct = await fetch(`${BASE}/api/grade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(direct.status).toBe(200);
      expect(((await direct.json()) as { service: string }).service).toBe("CLV Grade");

      // the server-side demo runner probes /api/grade, gets a non-402, and
      // returns the "unexpected status" trace instead of trying to sign.
      const demo = await fetch(`${BASE}/api/demo/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "grade", body: {} }),
      });
      expect(demo.status).toBe(200);
      const body = (await demo.json()) as { paid_status: number; challenge_line: string; settlement: string };
      expect(body.paid_status).toBe(200);
      expect(body.challenge_line).toContain("unexpected status");
      expect(body.settlement).toBe("n/a");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
