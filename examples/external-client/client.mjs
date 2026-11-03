#!/usr/bin/env node
// Independent ClearCart Gate client.
//
// This file is deliberately standalone: plain fetch, zero imports from
// the repository's packages, nothing shared with the gate
// implementation. It exists to prove the gate's contract is usable by
// an agent that knows nothing about the codebase, only the published
// API (docs/openapi.yaml).
//
// Usage:
//   node examples/external-client/client.mjs [--url http://127.0.0.1:8787] [--key demo-gate-key]
//
// It runs one check for the demo merchant, Lakeshore Cannabis Club (a verified buyer,
// a small cart) and prints the gate's decision receipt as JSON on
// stdout. Start the gate first:  GATE_API_KEY=demo-gate-key npm run gate

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const baseUrl = argValue("--url", "http://127.0.0.1:8787").replace(/\/$/, "");
const apiKey = argValue("--key", process.env.GATE_API_KEY ?? "demo-gate-key");

const request = {
  jurisdiction: { country: "US", state: "IL" },
  category: "cannabis",
  merchant_id: "mrc_lakeshore",
  buyer: { attestation_id: "att_demo_7f3a" },
  cart: [
    { sku: "FLW-001", quantity: 1 },
    { sku: "EDB-002", quantity: 2 },
  ],
};

const res = await fetch(`${baseUrl}/v1/gate/check`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-gate-key": apiKey },
  body: JSON.stringify(request),
});

if (!res.ok) {
  console.error(`Gate check failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}

const receipt = await res.json();
console.log(JSON.stringify(receipt, null, 2));
