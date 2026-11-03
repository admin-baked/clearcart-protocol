// ClearCart Gate HTTP service.
//
// REFERENCE IMPLEMENTATION for a hackathon demo. Not a production system.
// The gate decides nothing about real-world legality: it evaluates demo
// rules against demo data. See docs/SAFETY.md.
//
// Endpoints:
//   GET  /                          Service banner
//   GET  /health                    Liveness
//   GET  /v1/gate/limits            Active limit config for a state + category
//   POST /v1/gate/check             Evaluate one proposed transaction
//   POST /v1/gate/receipts/verify   Verify a receipt's signature + expiry
//   POST /v1/gate/attestations/demo DEMO ONLY: mint a synthetic attestation
//
// Trust model: the gate resolves buyer attestations and purchase
// history from its own server-side store, and cart attributes from its
// own merchant catalogs. A check request carries only an attestation
// ID and SKUs; verification flags or product attributes a caller puts
// in the request are ignored.
//
// Auth: when GATE_API_KEY is set (or an apiKey is passed in), /v1 routes
// require a matching x-gate-key header. That is demo-grade auth for the
// reference implementation; production auth design is out of scope.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GateEngine, type DecisionReceipt, type GateCheckInput } from "./engine.ts";
import { loadCatalogs, loadGateConfigs } from "./config.ts";
import {
  AttestationStore,
  PurchaseLedger,
  createAttestationStore,
  createPurchaseLedger,
  loadDemoStoreSeed,
} from "./store.ts";

export interface GateServerOptions {
  port?: number;
  host?: string;
  configDir?: string;
  catalogDir?: string;
  seedPath?: string;
  apiKey?: string;
  clock?: () => Date;
  secret?: string;
  attestations?: AttestationStore;
  ledger?: PurchaseLedger;
}

export interface RunningGate {
  server: Server;
  port: number;
  baseUrl: string;
  engine: GateEngine;
  attestations: AttestationStore;
  ledger: PurchaseLedger;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

export async function startGateServer(options: GateServerOptions = {}): Promise<RunningGate> {
  const here = dirname(fileURLToPath(import.meta.url));
  const configDir = options.configDir ?? join(here, "..", "config");
  const catalogDir = options.catalogDir ?? join(here, "..", "catalog");
  const seedPath = options.seedPath ?? join(here, "..", "seed", "demo-store.json");
  const seed = loadDemoStoreSeed(seedPath);
  const attestations = options.attestations ?? createAttestationStore(seed);
  const ledger = options.ledger ?? createPurchaseLedger(seed);
  const engine = new GateEngine(loadGateConfigs(configDir), {
    clock: options.clock,
    secret: options.secret,
    attestations,
    ledger,
    catalogs: loadCatalogs(catalogDir),
  });
  const apiKey = options.apiKey ?? process.env.GATE_API_KEY;
  const clock = options.clock ?? (() => new Date());
  let attestationSeq = 0;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "/health")) {
        return sendJson(res, 200, {
          service: "ClearCart Gate",
          mode: "reference implementation, demo only, not a production system",
          ok: true,
        });
      }

      if (path.startsWith("/v1/") && apiKey && req.headers["x-gate-key"] !== apiKey) {
        return sendJson(res, 401, { error: "UNAUTHORIZED", detail: "Missing or wrong x-gate-key header." });
      }

      if (req.method === "GET" && path === "/v1/gate/limits") {
        const state = url.searchParams.get("state") ?? "";
        const category = url.searchParams.get("category") ?? "";
        const config = engine.limits("US", state, category);
        if (!config) {
          return sendJson(res, 404, {
            error: "NO_CONFIG",
            detail: `No limit configuration for state=${state} category=${category}. The gate refuses rather than guessing.`,
          });
        }
        return sendJson(res, 200, config);
      }

      if (req.method === "POST" && path === "/v1/gate/check") {
        const body = (await readJsonBody(req)) as GateCheckInput;
        if (
          !body || typeof body !== "object" || !body.jurisdiction || !body.category ||
          typeof body.merchant_id !== "string" || !body.merchant_id ||
          !body.buyer || typeof body.buyer.attestation_id !== "string" || !body.buyer.attestation_id ||
          !Array.isArray(body.cart)
        ) {
          return sendJson(res, 400, {
            error: "BAD_REQUEST",
            detail: "Body must include jurisdiction, category, merchant_id, buyer.attestation_id, and cart[]. Verification flags and product attributes in the request are ignored; the gate resolves both server-side.",
          });
        }
        return sendJson(res, 200, engine.check(body));
      }

      if (req.method === "POST" && path === "/v1/gate/receipts/verify") {
        const body = (await readJsonBody(req)) as DecisionReceipt;
        if (!body || typeof body !== "object" || typeof body.decision_id !== "string") {
          return sendJson(res, 400, {
            error: "BAD_REQUEST",
            detail: "Body must be a gate decision receipt.",
          });
        }
        return sendJson(res, 200, engine.verify(body));
      }

      if (req.method === "POST" && path === "/v1/gate/attestations/demo") {
        // DEMO ONLY. This mints a synthetic attestation with caller-chosen
        // flags so the demo can show a verified and an unverified buyer,
        // and registers it in the gate's trusted store so later checks
        // resolve it server-side. It verifies nothing about any real
        // person and must never be presented as identity verification.
        const body = (await readJsonBody(req)) as { age_verified?: boolean; id_verified?: boolean };
        attestationSeq += 1;
        const suffix = randomBytes(2).toString("hex");
        const record = {
          attestation_id: `att_demo_${suffix}${attestationSeq}`,
          age_verified: body.age_verified === true,
          id_verified: body.id_verified === true,
          issued_at: clock().toISOString(),
          method: "demo_stub",
        };
        attestations.register(record);
        return sendJson(res, 200, record);
      }

      return sendJson(res, 404, { error: "NOT_FOUND", detail: `No route for ${req.method} ${path}.` });
    } catch (err) {
      return sendJson(res, 500, { error: "INTERNAL", detail: String(err) });
    }
  });

  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    engine,
    attestations,
    ledger,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Run directly: npm run gate
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const gate = await startGateServer();
  console.log(`ClearCart Gate (reference implementation, demo only) listening on ${gate.baseUrl}`);
}
