/**
 * api/rails/cdp.ts — the x402 Bazaar rail (Coinbase CDP · Base · USDC).
 *
 * Verifiable without credentials, and therefore tested here: network selection,
 * the credential guard, the readiness report, the quoted prices, the config we
 * hand the SDK (that config IS the listing), and — most importantly — the
 * VENUE-SPECIFIC discovery shape, because the two marketplaces demand opposite
 * things of a param-less request.
 *
 * Not verifiable here (needs a CDP account + USDC on Base): the live
 * facilitator handshake, a real settlement, and Bazaar indexing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const createX402Server = vi.fn(async (config: Record<string, unknown>) => ({ __config: config }));
const paymentMiddlewareFromHTTPServer = vi.fn(
  (_server: unknown) => (_req: unknown, _res: unknown, next: () => void) => next(),
);

vi.mock("@coinbase/cdp-sdk/x402", () => ({
  createX402Server: (c: Record<string, unknown>) => createX402Server(c),
}));
vi.mock("@x402/express", () => ({
  paymentMiddlewareFromHTTPServer: (s: unknown) => paymentMiddlewareFromHTTPServer(s),
}));

async function rail(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("../api/rails/cdp");
}

// A real-looking receiver is part of the baseline: buildCdpServer refuses to
// start on the 0x…dEaD config default, since this rail settles live USDC.
const WITH_CREDS = {
  CDP_API_KEY_ID: "test-id",
  CDP_API_KEY_SECRET: "test-secret",
  PAYTO_ADDRESS: "0x45078eD96C2bB171009A47a57aF5C085Bf4fD0e3",
};

beforeEach(() => {
  createX402Server.mockClear();
  paymentMiddlewareFromHTTPServer.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("network selection", () => {
  it("defaults to Base mainnet", async () => {
    const r = await rail({ CDP_X402_SERVER_ENVIRONMENT: undefined });
    expect(r.cdpNetwork()).toBe("eip155:8453");
  });

  it("uses Base Sepolia in development", async () => {
    const r = await rail({ CDP_X402_SERVER_ENVIRONMENT: "development" });
    expect(r.cdpNetwork()).toBe("eip155:84532");
  });
});

describe("credential guard", () => {
  it("refuses to build without credentials, with an actionable message", async () => {
    const r = await rail({ CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined });
    await expect(r.buildCdpServer()).rejects.toThrow(/CDP_API_KEY_ID/);
    await expect(r.buildCdpServer()).rejects.toThrow(/PAY_RAIL=okx/);
  });

  it("surfaces the failure through next(err), never as a crash", async () => {
    const r = await rail({ CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined });
    const gate = r.buildCdpPayGateLazy();
    const err = await new Promise<unknown>((resolve) =>
      gate({ path: "/api/grade" } as never, {} as never, ((e: unknown) => resolve(e)) as never),
    );
    expect(err).toBeInstanceOf(Error);
  });

  it("passes NON-gated paths through without building — an unconfigured rail must not break /health", async () => {
    const r = await rail({ CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined });
    const gate = r.buildCdpPayGateLazy();
    for (const path of ["/health", "/api/calibration", "/api/me", "/"]) {
      const err = await new Promise<unknown>((resolve) =>
        gate({ path } as never, {} as never, ((e: unknown) => resolve(e)) as never),
      );
      expect(err).toBeUndefined();
    }
    expect(createX402Server).not.toHaveBeenCalled();
  });
});

describe("the config handed to createX402Server IS the Bazaar listing", () => {
  it("registers BOTH paid routes on Base at the premium prices", async () => {
    const r = await rail(WITH_CREDS);
    await r.buildCdpServer();
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;

    expect(Object.keys(cfg.routes).sort()).toEqual(["POST /api/audit", "POST /api/grade"]);
    expect(cfg.routes["POST /api/grade"].price).toBe("$5.00");
    expect(cfg.routes["POST /api/audit"].price).toBe("$25.00");
    for (const key of ["POST /api/grade", "POST /api/audit"]) {
      expect(cfg.routes[key].networks).toEqual(["eip155:8453"]);
      expect(cfg.routes[key].maxTimeoutSeconds).toBe(300);
    }
    // audit is the research report, so it must cost more than a single grade
    const price = (k: string) => Number(String(cfg.routes[k].price).replace("$", ""));
    expect(price("POST /api/audit")).toBeGreaterThan(price("POST /api/grade"));
  });

  it("keeps OUR receiver address and provisions no CDP wallet", async () => {
    const r = await rail(WITH_CREDS);
    await r.buildCdpServer();
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;
    expect(cfg.payToConfig.type).toBe("address");
    expect(cfg.payToConfig.evm).toBeTruthy();
    expect(cfg).not.toHaveProperty("walletSecret");
  });

  it("each route declares a discovery contract with a valid example INSTANCE", async () => {
    const r = await rail(WITH_CREDS);
    await r.buildCdpServer();
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;

    const grade = JSON.stringify(cfg.routes["POST /api/grade"].extensions);
    for (const f of ["match", "selection", "odds_taken", "clv_grade"]) expect(grade).toContain(f);
    const audit = JSON.stringify(cfg.routes["POST /api/audit"].extensions);
    for (const f of ["bets", "label", "sharp_score"]) expect(audit).toContain(f);

    // Without `input`, CDP records info.input.body as {} and the listing fails
    // its own required check: "(root).input.body: match is required".
    const gInfo = JSON.parse(grade);
    const gBody = (Object.values(gInfo)[0] as any)?.info?.input?.body;
    expect(gBody?.match).toBeTruthy();
    expect(gBody?.odds_taken).toBeGreaterThan(1);
  });

  it("honours price overrides", async () => {
    const r = await rail({ ...WITH_CREDS, CDP_GRADE_PRICE: "$9.00", CDP_AUDIT_PRICE: "$49.00" });
    await r.buildCdpServer();
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;
    expect(cfg.routes["POST /api/grade"].price).toBe("$9.00");
    expect(cfg.routes["POST /api/audit"].price).toBe("$49.00");
  });
});

describe("quote + readiness", () => {
  it("quotes both routes in USDC on Base, not the $0.01/$0.20 OKX prices", async () => {
    const r = await rail({ ...WITH_CREDS, CDP_GRADE_PRICE: undefined, CDP_AUDIT_PRICE: undefined });
    const q = r.cdpQuoteSummary();
    expect(q.rail).toBe("cdp");
    expect(q.asset).toBe("USDC");
    expect(q.network).toBe("eip155:8453");
    expect(q.routes.map((x) => x.price)).toEqual(["$5.00", "$25.00"]);
  });

  it("readiness names the validate call, the first settlement and the discovery check", async () => {
    const r = await rail({ CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined });
    const all = r.bazaarReadiness().steps.join(" | ");
    expect(r.bazaarReadiness().ready).toBe(false);
    expect(all).toMatch(/x402\/validate/);
    expect(all).toMatch(/settlement/i);
    expect(all).toMatch(/discovery\/resources/);
  });
});

describe("venue-specific discovery shape (the two marketplaces disagree)", () => {
  // OKX.AI delists a service whose param-less call returns a challenge; Coinbase
  // Bazaar never indexes one whose param-less POST does not. Asserted on the
  // PREFLIGHT DECISION — with dummy credentials the gate cannot build, so an
  // end-to-end 402 is not observable here.
  async function decide(
    payRail: string,
    opts: { body?: unknown; method?: string; headers?: Record<string, string> } = {},
  ) {
    vi.resetModules();
    process.env.PAY_RAIL = payRail;
    const { paramPreflight } = await import("../api/validate");
    const gate = paramPreflight();
    const req = {
      path: "/api/grade",
      method: opts.method ?? "POST",
      body: opts.body ?? {},
      query: {},
      headers: opts.headers ?? {},
    };
    return new Promise<{ passedToGate: boolean; status?: number; body?: Record<string, unknown> }>((resolve) => {
      const res = {
        statusCode: 0,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: Record<string, unknown>) {
          resolve({ passedToGate: false, status: this.statusCode, body: payload });
          return this;
        },
      };
      gate(req as never, res as never, (() => resolve({ passedToGate: true })) as never);
    });
  }

  it("OKX rail: a param-less POST is a purchase attempt -> 400, never reaches the gate", async () => {
    const r = await decide("okx", { body: {} });
    expect(r.passedToGate).toBe(false);
    expect(r.status).toBe(400);
  });

  it("CDP rail: a param-less POST is the Bazaar validator probe -> passed to the gate", async () => {
    expect((await decide("cdp", { body: {} })).passedToGate).toBe(true);
  });

  it("both rails treat a param-less GET as discovery", async () => {
    expect((await decide("okx", { method: "GET" })).passedToGate).toBe(true);
    expect((await decide("cdp", { method: "GET" })).passedToGate).toBe(true);
  });

  it("CDP rail: params present but INVALID is still 400, never a challenge", async () => {
    const r = await decide("cdp", { body: { match: "BRA vs SRB" } }); // missing selection + odds
    expect(r.passedToGate).toBe(false);
    expect(r.status).toBe(400);
  });

  it("CDP rail: THE DEDUCTION GUARANTEE HOLDS — a PAID param-less call is 400 before the gate", async () => {
    const r = await decide("cdp", { body: {}, headers: { "x-payment": "base64-payload" } });
    expect(r.passedToGate).toBe(false);
    expect(r.status).toBe(400);
    expect(String(r.body?.payment)).toMatch(/nothing was deducted/i);
  });
});

describe("the Express adapter", () => {
  it("wraps the CDP server with paymentMiddlewareFromHTTPServer", async () => {
    const r = await rail(WITH_CREDS);
    const gate = await r.buildCdpPayGate();
    expect(paymentMiddlewareFromHTTPServer).toHaveBeenCalledTimes(1);
    expect(typeof gate).toBe("function");
  });

  it("the lazy gate builds ONCE and reuses it across requests, on either paid route", async () => {
    const r = await rail(WITH_CREDS);
    const gate = r.buildCdpPayGateLazy();
    const run = (path: string) =>
      new Promise<void>((resolve) => gate({ path } as never, {} as never, (() => resolve()) as never));
    await run("/api/grade");
    await run("/api/audit");
    await run("/api/grade/"); // trailing slash normalises to the same route
    expect(createX402Server).toHaveBeenCalledTimes(1);
    expect(paymentMiddlewareFromHTTPServer).toHaveBeenCalledTimes(1);
  });
});

describe("burn-address guard", () => {
  it("refuses to start when payTo is still the 0x…dEaD config default", async () => {
    // config.ts defaults PAYTO_ADDRESS to the burn address. Harmless locally,
    // catastrophic on a mainnet rail: every payment would be unrecoverable.
    const r = await rail({ ...WITH_CREDS, CLV_PAYTO: undefined, PAYTO_ADDRESS: undefined });
    await expect(r.buildCdpServer()).rejects.toThrow(/burn-address/i);
    await expect(r.buildCdpServer()).rejects.toThrow(/CLV_PAYTO/);
    expect(createX402Server).not.toHaveBeenCalled();
  });

  it("starts normally with a real receiver configured", async () => {
    const r = await rail({ ...WITH_CREDS, PAYTO_ADDRESS: "0x45078eD96C2bB171009A47a57aF5C085Bf4fD0e3" });
    await r.buildCdpServer();
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;
    expect(cfg.payToConfig.evm).toBe("0x45078eD96C2bB171009A47a57aF5C085Bf4fD0e3");
  });
});
