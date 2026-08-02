/**
 * CLV Scout API — Express app.
 *
 *   POST /api/grade             $0.01 x402 (okxPayGate)
 *   POST /api/audit             $0.20 x402 (okxPayGate)
 *   POST /api/calibration       free
 *   POST /api/me                free
 *   POST /api/receipts/verify   free
 *   GET  /api/grade             same x402 gate (OKX's review probe is a GET; params ride the query string)
 *   GET  /api/audit             same x402 gate
 *   GET  /health
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { okxPayGate } from "./rails/okx";
import {
  gradeHandler,
  auditHandler,
  calibrationHandler,
  meHandler,
  receiptsVerifyHandler,
  demoRunHandler,
  healthHandler,
} from "./routes";
import { PAY_RAIL } from "../config";

function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind Railway's proxy req.protocol is "http" without this, which would
  // leak an http:// resource.url into the 402 challenge — OKX's validator
  // compares it against the registered https endpoint. Hop count 1 (not
  // `true`) so clients can't spoof their IP past the rate limiter via
  // X-Forwarded-For.
  app.set("trust proxy", 1);
  app.use(cors);
  app.use(express.json());

  // Basic per-IP rate limit ahead of the pay gate: signature verification is
  // CPU work an attacker could spam for free. Generous enough that OKX's
  // review probes and real buyers never hit it.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: Number(process.env.RATE_LIMIT_MAX ?? 600),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Per-paid-route shim that makes the official SDK's paymentMiddleware behave
  // the way OKX.AI's marketplace validator (and CLV Scout's v1-style clients)
  // expect — applied to the two gated paths BEFORE the gate itself:
  //
  //  1. Force `Accept: application/json`. The SDK's browser sniff (Accept:
  //     text/html) swaps the 402 for an HTML paywall WITHOUT the
  //     PAYMENT-REQUIRED header — and that header is what the validator reads.
  //  2. Mirror `X-PAYMENT` (v1) into `PAYMENT-SIGNATURE` (what the SDK core's
  //     extractPayment actually reads) so a v1-style payer isn't re-402'd
  //     forever ("x402 validation failed" / "task timed out" in review).
  //  3. Mirror the base64 PAYMENT-REQUIRED challenge into the 402 JSON BODY —
  //     the SDK sends `{}` there, but validators (and our own buyer/demo
  //     clients) that read the body need the full challenge.
  //  4. Mirror the settlement `PAYMENT-RESPONSE` header into
  //     `X-PAYMENT-RESPONSE` for v1-style clients.
  if (PAY_RAIL === "okx") {
    app.use(["/api/grade", "/api/audit"], (req: Request, res: Response, next: NextFunction) => {
      req.headers.accept = "application/json";
      if (!req.headers["payment-signature"] && req.headers["x-payment"]) {
        req.headers["payment-signature"] = req.headers["x-payment"];
      }
      const origJson = res.json.bind(res);
      res.json = (body?: unknown) => {
        const hdr = res.getHeader("PAYMENT-REQUIRED");
        const isEmpty = body == null || (typeof body === "object" && Object.keys(body as object).length === 0);
        if (res.statusCode === 402 && typeof hdr === "string" && isEmpty) {
          try {
            return origJson(JSON.parse(Buffer.from(hdr, "base64").toString("utf8")));
          } catch {
            /* fall through to the SDK body */
          }
        }
        return origJson(body);
      };
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: number | string | readonly string[]) => {
        const out = origSetHeader(name, value);
        if (String(name).toLowerCase() === "payment-response") origSetHeader("X-PAYMENT-RESPONSE", value);
        return out;
      }) as typeof res.setHeader;
      next();
    });
    app.use(okxPayGate());
  }

  // Paid GET support: OKX's x402 client sends business params in the query
  // string when the paid call is a GET. Unpaid GETs never reach these handlers
  // (okxPayGate answers them with the 402 challenge, same as POST — its review
  // probe is a GET, and a 405 there reads as "endpoint unreachable").
  const queryAsBody = (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response): Promise<void> => {
      req.body = { ...req.query };
      return handler(req, res);
    };

  app.post("/api/grade", gradeHandler);
  app.get("/api/grade", queryAsBody(gradeHandler));

  app.post("/api/audit", auditHandler);
  app.get("/api/audit", queryAsBody(auditHandler));

  app.post("/api/calibration", calibrationHandler);
  app.post("/api/me", meHandler);
  app.post("/api/receipts/verify", receiptsVerifyHandler);
  app.post("/api/demo/run", demoRunHandler);

  app.get("/health", healthHandler);
  app.get("/api", (_req, res) =>
    res.json({ service: "clvscout-api", see: ["/api/calibration", "/health"] }),
  );

  // Visible proof surface: a single served page that drives the live paid API
  // and renders the reveal (grade card + audit dossier). Static, self-contained.
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
  app.use(express.static(webDir));

  return app;
}
