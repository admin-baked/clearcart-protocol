// End-to-end tests: the full protocol over real HTTP to a live gate
// service, with the buyer and merchant agents running on the mock model
// provider and the sandbox payment rail.
//
// Covered: the approved order (gate APPROVE receipt, payment, pickup code
// PR-4821), the blocked order (DENY with LIMIT_EXCEEDED, and proof that no
// payment session was ever created), the unverified buyer (AGE_UNVERIFIED
// and ID_UNVERIFIED), the standalone gate endpoints any agent can call,
// and demo API-key enforcement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startGateServer, type RunningGate } from "../services/gate/src/server.ts";
import { GateClient } from "../services/gate/src/client.ts";
import { MockProvider } from "../providers/mock.ts";
import { MetaModelAPIProvider, MetaProviderNotConfiguredError } from "../providers/meta.ts";
import { StubRail } from "../payments/stub-rail.ts";
import { MerchantAgent } from "../agents/merchant/merchant-agent.ts";
import { BuyerAgent } from "../agents/buyer/buyer-agent.ts";
import { loadDemoState, type DemoState } from "../demo/seed.ts";

const API_KEY = "demo-gate-key";

interface Harness {
  gate: RunningGate;
  state: DemoState;
  rail: StubRail;
  merchant: MerchantAgent;
  buyerA: BuyerAgent;
  buyerB: BuyerAgent;
}

const GATE_SECRET = "e2e-gate-secret";

async function makeHarness(): Promise<Harness> {
  const gate = await startGateServer({ port: 0, apiKey: API_KEY, secret: GATE_SECRET });
  const state = loadDemoState();
  const client = new GateClient(gate.baseUrl, { apiKey: API_KEY });
  const rail = new StubRail({ merchant_id: state.merchant.id, gate_secret: GATE_SECRET });
  const merchant = new MerchantAgent({ state, provider: new MockProvider(), gate: client, rail });
  const buyerA = new BuyerAgent({ provider: new MockProvider(), merchant, buyer: state.buyers[0] });
  const buyerB = new BuyerAgent({ provider: new MockProvider(), merchant, buyer: state.buyers[1] });
  return { gate, state, rail, merchant, buyerA, buyerB };
}

test("approved order end to end: gate receipt, sandbox payment, pickup code PR-4821", async (t) => {
  const h = await makeHarness();
  t.after(() => h.gate.close());

  await h.buyerA.send(
    "Find me a dispensary near Romeoville with something citrus-forward for the weekend, and keep it under a hundred dollars.",
  );
  const answer = await h.buyerA.send("Is the Cresco Lemon Bean any good for a Saturday afternoon?");
  assert.match(answer, /Lemon Bean/);
  assert.match(answer, /\$28\.11/);

  await h.buyerA.send("I will take 1 Cresco Lemon Bean, 1 IC Collective Citrus Black Grape, and 1 Uncle Arnie's Sunrise Orange, please.");
  const order = h.buyerA.lastOrder;
  assert.ok(order);
  assert.equal(order.status, "PAYMENT_PENDING");
  assert.equal(order.gate_decision?.decision, "APPROVE");
  assert.equal(order.gate_decision?.policy_id, "SIMULATED_POLICY_V1");
  assert.equal(order.gate_decision?.evaluated.flower_equivalent_g_total, 10.5);
  assert.equal(order.gate_decision?.evaluated.infused_thc_mg_total, 400);
  assert.ok(order.payment_session_id);

  const paid = await h.buyerA.confirmPayment();
  assert.equal(paid.status, "READY_FOR_PICKUP");
  assert.equal(paid.pickup_code, "PR-4821");
  assert.equal(h.rail.sessionCount(), 1);
});

test("blocked order end to end: DENY with LIMIT_EXCEEDED and no payment session", async (t) => {
  const h = await makeHarness();
  t.after(() => h.gate.close());

  await h.buyerA.send("I will take 1 Cresco Lemon Bean, 1 IC Collective Citrus Black Grape, and 1 Uncle Arnie's Sunrise Orange, please.");
  await h.buyerA.confirmPayment();
  assert.equal(h.rail.sessionCount(), 1);

  const reply = await h.buyerA.send("Restock run: 2 RYTHM Animal Face.");
  const order = h.buyerA.lastOrder;
  assert.ok(order);
  assert.equal(order.status, "GATE_DENIED");
  const codes = order.gate_decision?.reasons.map((r) => r.code) ?? [];
  assert.ok(codes.includes("LIMIT_EXCEEDED"));
  const flowerReason = order.gate_decision?.reasons.find((r) => r.limit === 30);
  assert.equal(flowerReason?.attempted, 38.5);
  assert.equal(order.payment_session_id, undefined);
  assert.equal(h.rail.sessionCount(), 1, "a denied order must never create a payment session");
  assert.match(reply, /daily purchase limit/);
});

test("unverified buyer end to end: DENY with AGE_UNVERIFIED and ID_UNVERIFIED", async (t) => {
  const h = await makeHarness();
  t.after(() => h.gate.close());

  await h.buyerB.send("I will take 1 Cresco Lemon Bean, please.");
  const order = h.buyerB.lastOrder;
  assert.ok(order);
  assert.equal(order.status, "GATE_DENIED");
  assert.deepEqual(
    order.gate_decision?.reasons.map((r) => r.code),
    ["AGE_UNVERIFIED", "ID_UNVERIFIED"],
  );
  assert.equal(h.rail.sessionCount(), 0);
});

test("standalone gate endpoints: limits, attestation demo stub, and API key enforcement", async (t) => {
  const h = await makeHarness();
  t.after(() => h.gate.close());
  const base = h.gate.baseUrl;

  const limitsRes = await fetch(`${base}/v1/gate/limits?state=IL&category=cannabis`, {
    headers: { "x-gate-key": API_KEY },
  });
  assert.equal(limitsRes.status, 200);
  const limits = (await limitsRes.json()) as { limits: { flower_equivalent_g_per_day: number } };
  assert.equal(limits.limits.flower_equivalent_g_per_day, 30);

  const attRes = await fetch(`${base}/v1/gate/attestations/demo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gate-key": API_KEY },
    body: JSON.stringify({ age_verified: true, id_verified: true }),
  });
  assert.equal(attRes.status, 200);
  const attestation = (await attRes.json()) as { attestation_id: string; method: string; age_verified: boolean };
  assert.equal(attestation.method, "demo_stub");
  assert.equal(attestation.age_verified, true);

  // A minted attestation is registered in the gate's trusted store: a
  // check carrying only its ID resolves the flags server-side.
  const client = new GateClient(base, { apiKey: API_KEY });
  const minted = await client.check({
    jurisdiction: { country: "US", state: "IL" },
    category: "cannabis",
    merchant_id: "mrc_lakeshore",
    buyer: { attestation_id: attestation.attestation_id },
    cart: [{ sku: "FLW-001", quantity: 1 }],
  });
  assert.equal(minted.decision, "APPROVE");

  const noKeyRes = await fetch(`${base}/v1/gate/limits?state=IL&category=cannabis`);
  assert.equal(noKeyRes.status, 401);
});

test("meta provider stub: refuses to fake a call when unconfigured", async () => {
  const provider = new MetaModelAPIProvider({});
  assert.equal(provider.configured, false);
  await assert.rejects(
    () => provider.complete([{ role: "user", content: "hello" }]),
    MetaProviderNotConfiguredError,
  );
});
