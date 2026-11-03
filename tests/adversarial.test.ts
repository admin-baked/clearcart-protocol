// Adversarial tests: the gate as an enforceable boundary.
//
// The happy path is covered by tests/e2e.test.ts. This suite attacks
// the authorization semantics the way a judge, or a hostile agent,
// would: forge the receipt, change the cart after approval, replay a
// decision, let it expire, skip the gate entirely, deliver the
// payment webhook twice, and race two carts against one limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GateEngine, type DecisionReceipt, type GateCheckInput } from "../services/gate/src/engine.ts";
import { loadCatalogs, loadGateConfigs } from "../services/gate/src/config.ts";
import { createAttestationStore, createPurchaseLedger, loadDemoStoreSeed } from "../services/gate/src/store.ts";
import { startGateServer } from "../services/gate/src/server.ts";
import { StubRail } from "../payments/stub-rail.ts";
import { MockProvider } from "../providers/mock.ts";
import { GateClient } from "../services/gate/src/client.ts";
import { MerchantAgent } from "../agents/merchant/merchant-agent.ts";
import { BuyerAgent } from "../agents/buyer/buyer-agent.ts";
import { loadDemoState } from "../demo/seed.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = join(HERE, "..", "services", "gate");
const T0 = new Date("2026-11-03T15:00:00Z");
const SECRET = "adversarial-secret";
const MERCHANT = "mrc_lakeshore";

function makeEngine(clock: () => Date = () => T0): GateEngine {
  const seed = loadDemoStoreSeed(join(GATE_DIR, "seed", "demo-store.json"));
  return new GateEngine(loadGateConfigs(join(GATE_DIR, "config")), {
    clock,
    secret: SECRET,
    attestations: createAttestationStore(seed),
    ledger: createPurchaseLedger(seed),
    catalogs: loadCatalogs(join(GATE_DIR, "catalog")),
  });
}

const APPROVED_CART: GateCheckInput["cart"] = [
  { sku: "FLW-001", quantity: 1 },
  { sku: "EDB-002", quantity: 2 },
];

const APPROVED_LINES = [
  { sku: "FLW-001", quantity: 1, flower_equivalent_g: 3.5, unit_thc_mg: 0 },
  { sku: "EDB-002", quantity: 2, flower_equivalent_g: 0, unit_thc_mg: 100 },
];

function checkInput(cart: GateCheckInput["cart"], attestation_id = "att_demo_7f3a"): GateCheckInput {
  return {
    jurisdiction: { country: "US", state: "IL" },
    category: "cannabis",
    merchant_id: MERCHANT,
    buyer: { attestation_id },
    cart,
  };
}

function makeRail(clock: () => Date = () => T0): StubRail {
  // The rail must judge receipts at the same fixed clock the engine
  // minted them with (T0); defaulting to wall-clock time made these
  // tests expire their own receipts five minutes after T0's date.
  // The expired-receipt test passes its own late clock explicitly.
  return new StubRail({ merchant_id: MERCHANT, gate_secret: SECRET, clock });
}

function sessionInput(receipt: DecisionReceipt, lines = APPROVED_LINES) {
  return {
    order_id: "ord_attack_0001",
    merchant_id: MERCHANT,
    amount_usd: 45.95, // 1 x FLW-001 ($28.11) + 2 x EDB-002 ($8.92)
    gate_receipt: receipt,
    cart_lines: lines,
  };
}

test("forged receipt signature is rejected at payment", async () => {
  const receipt = makeEngine().check(checkInput(APPROVED_CART));
  assert.equal(receipt.decision, "APPROVE");
  const forged: DecisionReceipt = {
    ...receipt,
    receipt_signature: (receipt.receipt_signature[0] === "0" ? "1" : "0") + receipt.receipt_signature.slice(1),
  };
  await assert.rejects(() => makeRail().createSession(sessionInput(forged)), /GATE_RECEIPT_FORGED/);
});

test("cart altered after gate approval is rejected at payment (hash mismatch)", async () => {
  const receipt = makeEngine().check(checkInput(APPROVED_CART));
  const altered = APPROVED_LINES.map((l) => (l.sku === "EDB-002" ? { ...l, quantity: 3 } : l));
  await assert.rejects(() => makeRail().createSession(sessionInput(receipt, altered)), /GATE_CART_MISMATCH/);
});

test("reused decision_id is rejected (replay)", async () => {
  const receipt = makeEngine().check(checkInput(APPROVED_CART));
  const rail = makeRail();
  const session = await rail.createSession(sessionInput(receipt));
  assert.ok(session.session_id);
  await assert.rejects(
    () => rail.createSession({ ...sessionInput(receipt), order_id: "ord_attack_0002" }),
    /GATE_RECEIPT_REPLAYED/,
  );
  assert.equal(rail.sessionCount(), 1);
});

test("expired receipt is rejected at payment", async () => {
  const receipt = makeEngine().check(checkInput(APPROVED_CART));
  const lateRail = makeRail(() => new Date(T0.getTime() + 6 * 60_000)); // receipts live 5 minutes
  await assert.rejects(() => lateRail.createSession(sessionInput(receipt)), /GATE_RECEIPT_EXPIRED/);
});

test("payment attempted with no gate decision is rejected", async () => {
  await assert.rejects(
    () => makeRail().createSession({ order_id: "ord_attack_0003", merchant_id: MERCHANT, amount_usd: 10 }),
    /GATE_RECEIPT_MISSING/,
  );
});

test("a DENY receipt cannot authorize payment", async () => {
  const denied = makeEngine().check(checkInput([{ sku: "FLW-001", quantity: 1 }], "att_demo_9b2c"));
  assert.equal(denied.decision, "DENY");
  const lines = [{ sku: "FLW-001", quantity: 1, flower_equivalent_g: 3.5, unit_thc_mg: 0 }];
  await assert.rejects(() => makeRail().createSession(sessionInput(denied, lines)), /GATE_DECISION_NOT_APPROVED/);
});

test("duplicate payment webhook confirm is idempotent", async (t) => {
  const gate = await startGateServer({ port: 0, apiKey: "adv-key", secret: SECRET });
  t.after(() => gate.close());
  const state = loadDemoState();
  const client = new GateClient(gate.baseUrl, { apiKey: "adv-key" });
  const rail = new StubRail({ merchant_id: state.merchant.id, gate_secret: SECRET });
  const merchant = new MerchantAgent({ state, provider: new MockProvider(), gate: client, rail });
  const buyer = new BuyerAgent({ provider: new MockProvider(), merchant, buyer: state.buyers[0] });

  await buyer.send("I will take 1 Cresco Lemon Bean, 1 IC Collective Citrus Black Grape, and 1 Uncle Arnie's Sunrise Orange, please.");
  const paid = await buyer.confirmPayment();
  assert.equal(paid.status, "READY_FOR_PICKUP");
  assert.equal(paid.pickup_code, "PR-4821");

  const order = buyer.lastOrder;
  assert.ok(order?.payment_session_id);
  const duplicate = merchant.handlePaymentWebhook({
    type: "payment.confirmed",
    session_id: order.payment_session_id,
    order_id: order.order_id,
  });
  assert.equal(duplicate.status, "READY_FOR_PICKUP");
  assert.equal(duplicate.pickup_code, "PR-4821");
  assert.equal(rail.sessionCount(), 1);
});

test("two concurrent carts that each fit alone cannot both pass over the limit", async (t) => {
  const gate = await startGateServer({ port: 0, apiKey: "adv-key", secret: SECRET });
  t.after(() => gate.close());
  // 6 x 3.5 g = 21 g per cart. Seeded history is 7 g, so one cart
  // lands at 28 g (inside the 30 g limit) and the second, evaluated
  // after the first reserves, lands at 49 g (denied).
  const body = JSON.stringify({
    jurisdiction: { country: "US", state: "IL" },
    category: "cannabis",
    merchant_id: MERCHANT,
    buyer: { attestation_id: "att_demo_7f3a" },
    cart: [{ sku: "FLW-001", quantity: 6 }],
  });
  const fire = () =>
    fetch(`${gate.baseUrl}/v1/gate/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gate-key": "adv-key" },
      body,
    }).then((r) => r.json() as Promise<DecisionReceipt>);
  const [a, b] = await Promise.all([fire(), fire()]);
  const decisions = [a.decision, b.decision].sort();
  assert.deepEqual(decisions, ["APPROVE", "DENY"]);
  const denied = [a, b].find((r) => r.decision === "DENY");
  assert.ok(denied?.reasons.some((r) => r.code === "LIMIT_EXCEEDED"));
});
