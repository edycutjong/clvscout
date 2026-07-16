/**
 * CLV Scout API — Express app.
 *
 *   POST /api/grade             $0.01 x402 (okxPayGate)
 *   POST /api/audit             $0.20 x402 (okxPayGate)
 *   POST /api/calibration       free
 *   POST /api/me                free
 *   POST /api/receipts/verify   free
 *   GET  /api/grade             405
 *   GET  /api/audit             405
 *   GET  /health
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
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
  methodNotAllowedHandler,
  healthHandler,
} from "./routes";
import { PAY_RAIL } from "../config";

function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors);
  app.use(express.json());

  if (PAY_RAIL === "okx") {
    app.use(okxPayGate());
  }

  app.post("/api/grade", gradeHandler);
  app.get("/api/grade", methodNotAllowedHandler);

  app.post("/api/audit", auditHandler);
  app.get("/api/audit", methodNotAllowedHandler);

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
