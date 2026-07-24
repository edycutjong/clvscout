/**
 * Coverage completion for the last three uncovered spots:
 *   - api/routes.ts   methodNotAllowedHandler (exported, not wired) → direct unit call
 *   - api/server.ts   the queryAsBody wrapper on a PAID GET (only reached once a
 *                     GET clears the pay gate) → real EIP-3009 paid GET round-trip
 *   - api/rails/okx.ts the resource-URL `proto` ternary — every operand branch
 *                     (https via X-Forwarded-Proto, localhost host, 127.* host,
 *                     and the non-local `"https"` fallback) via raw http requests
 *                     that can set a custom Host header (undici fetch forbids it).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import http from "node:http";
import fs from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createApp } from "../api/server";
import { methodNotAllowedHandler } from "../api/routes";
import { PATHS } from "../config";

let server: Server;
let base: string;
let port: number;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

/** Probe the paid route (POST), sign a real EIP-3009 authorization, return an X-PAYMENT header. */
async function signPaymentHeader(path: string): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  const probe = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const challenge = (await probe.json()) as {
    accepts: { network: string; asset: string; amount: string; payTo: string; extra: Record<string, string> }[];
  };
  const required = challenge.accepts[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: required.payTo as `0x${string}`,
    value: required.amount,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 3600),
    nonce: randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: {
      name: required.extra.name,
      version: required.extra.version,
      chainId: Number(required.network.split(":")[1]),
      verifyingContract: required.asset as `0x${string}`,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const payload = { x402Version: 2, accepted: required, payload: { signature, authorization } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Raw GET so a custom Host / X-Forwarded-Proto can be set (undici fetch strips Host). */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("failed to bind test server");
  port = address.port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  for (const p of [PATHS.buyerStore, PATHS.receiptLog, PATHS.usedNonces]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

describe("routes.ts — methodNotAllowedHandler", () => {
  it("responds 405 method_not_allowed", () => {
    let code = 0;
    let body: unknown;
    const res = {
      status(c: number) { code = c; return this; },
      json(b: unknown) { body = b; return this; },
    } as unknown as import("express").Response;
    methodNotAllowedHandler({} as import("express").Request, res);
    expect(code).toBe(405);
    expect((body as { error: string }).error).toBe("method_not_allowed");
  });
});

describe("server.ts — paid GET reaches the queryAsBody wrapper", () => {
  it("a PAID GET /api/grade clears the gate and hydrates req.body from the query string", async () => {
    const header = await signPaymentHeader("/api/grade");
    const q = new URLSearchParams({ match: "BRA vs SRB", selection: "Brazil ML", odds_taken: "1.55" });
    const res = await fetch(`${base}/api/grade?${q.toString()}`, {
      method: "GET",
      headers: { "X-PAYMENT": header },
    });
    // Reaching the handler at all (200, not 402/405) proves the wrapper ran.
    expect(res.status).toBe(200);
  });
});

describe("okx.ts — resource-URL proto ternary (every operand)", () => {
  it("non-local http host falls back to the https resource URL", async () => {
    // host !startsWith localhost/127 && protocol http → proto = "https" (else branch)
    expect(await rawGet("/api/grade", { Host: "example.com" })).toBe(402);
  });

  it("X-Forwarded-Proto:https makes req.protocol === 'https' (first operand true)", async () => {
    expect(await rawGet("/api/grade", { "X-Forwarded-Proto": "https" })).toBe(402);
  });

  it("a localhost Host header takes the startsWith('localhost') operand", async () => {
    expect(await rawGet("/api/grade", { Host: "localhost:1234" })).toBe(402);
  });
});
