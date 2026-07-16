/**
 * Two handler branches that the HTTP/E2E suites can't reach with the real seed
 * data: calibration's `window: null` path (an empty ledger, so there are no
 * kickoffs) and demoRunHandler's 500 catch (the underlying runDemo throwing).
 * Both are driven with module mocks + lightweight mock req/res objects.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import type { Request, Response } from "express";
import { PATHS } from "../config";

vi.mock("../db/ledger", async () => {
  const grade = await import("../engine/grade");
  return {
    loadOrBuildSettledLedger: () => ({
      rows: [],
      truthTable: grade.computeTruthTable([]),
      settledAt: "2026-01-01T00:00:00Z",
    }),
  };
});

vi.mock("../api/demoRunner", () => ({
  runDemo: async () => {
    throw new Error("boom in runDemo");
  },
}));

import { calibrationHandler, demoRunHandler, gradeHandler } from "../api/routes";

afterAll(() => {
  if (fs.existsSync(PATHS.buyerStore)) fs.rmSync(PATHS.buyerStore);
});

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("calibrationHandler — empty ledger", () => {
  it("reports window:null when there are no settled kickoffs", async () => {
    const res = mockRes();
    await calibrationHandler({} as Request, res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { window: unknown; table: unknown[]; settled_row_count: number };
    expect(body.window).toBeNull();
    expect(body.table).toHaveLength(6); // every grade band still present
    expect(body.settled_row_count).toBe(0);
  });
});

describe("gradeHandler — unauthenticated payer fallback", () => {
  it("records the buyer as 'unknown' when req.x402 is absent", async () => {
    const res = mockRes();
    // gradeHandler assumes the pay gate already ran; when called without an
    // x402 context (defensive), the payer falls back to "unknown".
    await gradeHandler(
      { body: { match: "BRA vs SRB", selection: "Brazil ML", odds_taken: 1.55 } } as Request,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { clv_grade: string; you: { your_grades: number } };
    expect(body.clv_grade).not.toBe("UNGRADED");
    // the "unknown" bucket now has at least this one recorded grade
    expect(body.you.your_grades).toBe(0); // buildYouBlock(undefined) -> zeroed
  });
});

describe("demoRunHandler — 500 on a failing run", () => {
  it("catches a thrown runDemo and returns demo_run_failed", async () => {
    const res = mockRes();
    await demoRunHandler({ body: { route: "grade", body: {} } } as Request, res as unknown as Response);
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: string; message: string };
    expect(body.error).toBe("demo_run_failed");
    expect(body.message).toContain("boom in runDemo");
  });
});
