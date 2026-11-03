// Unit tests for the ClearCart Gate rules engine.
//
// The engine is the compliance decision path, so these tests pin the
// behaviors that must never drift: approvals inside the limits, denials
// with exact machine-readable reason codes, refusals to guess for
// unconfigured jurisdictions, byte-identical determinism, and the
// trust model: attestations, cart attributes, and purchase history are
// all resolved by the gate server-side, never taken from the request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GateEngine, type GateCheckInput } from "../src/engine.ts";
import { loadCatalogs, loadGateConfigs } from "../src/config.ts";
import { createAttestationStore, createPurchaseLedger, loadDemoStoreSeed } from "../src/store.ts";

const FIXED_NOW = new Date("2026-11-03T15:00:00Z");
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(HERE, "..", "config");
const CATALOG_DIR = join(HERE, "..", "catalog");
const SEED_PATH = join(HERE, "..", "seed", "demo-store.json");

/** Fresh engine with a fresh trusted store per call: state isolation
 *  between tests, and the setup the determinism test relies on. */
function makeEngine(): GateEngine {
  const seed = loadDemoStoreSeed(SEED_PATH);
  return new GateEngine(loadGateConfigs(CONFIG_DIR), {
    clock: () => FIXED_NOW,
    secret: "test-secret",
    attestations: createAttestationStore(seed),
    ledger: createPurchaseLedger(seed),
    catalogs: loadCatalogs(CATALOG_DIR),
  });
}

function verifiedBuyer(): GateCheckInput["buyer"] {
  return { attestation_id: "att_demo_7f3a" };
}

/** The worked example from PROJECT_SPEC.md, hardened: the caller
 *  supplies wildly wrong attribute values for both lines, and the
 *  gate must still decide on catalog values. History (7.0 g, 200 mg)
 *  comes from the gate's seeded ledger, not the request. */
function specExampleInput(): GateCheckInput {
  return {
    jurisdiction: { country: "US", state: "IL" },
    category: "cannabis",
    merchant_id: "mrc_demo_prairie",
    buyer: verifiedBuyer(),
    cart: [
      { sku: "FLW-001", category: "flower", quantity: 1, unit_thc_mg: 9999, flower_equivalent_g: 999 },
      { sku: "EDB-002", category: "edible", quantity: 2, unit_thc_mg: 1, flower_equivalent_g: 50 },
    ],
  };
}

test("approve: a verified buyer inside the limits is approved with evaluated totals", () => {
  const receipt = makeEngine().check(specExampleInput());
  assert.equal(receipt.decision, "APPROVE");
  assert.deepEqual(receipt.reasons, []);
  assert.equal(receipt.evaluated.flower_equivalent_g_total, 10.5);
  assert.equal(receipt.evaluated.infused_thc_mg_total, 400);
  assert.deepEqual(receipt.evaluated.limits_applied, {
    flower_equivalent_g_per_day: 30,
    infused_thc_mg_per_day: 500,
  });
  assert.equal(receipt.merchant_id, "mrc_demo_prairie");
  assert.equal(receipt.policy_id, "SIMULATED_POLICY_V1");
  assert.equal(receipt.decision_id, "dec_20261103_0001");
  assert.equal(receipt.issued_at, "2026-11-03T15:00:00.000Z");
  assert.equal(receipt.expires_at, "2026-11-03T15:05:00.000Z");
  assert.match(receipt.cart_hash, /^[0-9a-f]{64}$/);
  assert.match(receipt.receipt_signature, /^[0-9a-f]{64}$/);
});

test("deny over limit: cart plus gate-side history past the flower limit is LIMIT_EXCEEDED", () => {
  const input = specExampleInput();
  input.cart = [{ sku: "FLW-001", category: "flower", quantity: 8 }];
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  const reason = receipt.reasons.find((r) => r.code === "LIMIT_EXCEEDED");
  assert.ok(reason, "expected a LIMIT_EXCEEDED reason");
  assert.equal(reason.limit, 30);
  assert.equal(reason.attempted, 35); // 8 x 3.5 g cart + 7.0 g seeded history
});

test("deny unverified buyer: store record without age and ID verification returns both codes", () => {
  const input = specExampleInput();
  input.buyer = { attestation_id: "att_demo_9b2c" };
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["AGE_UNVERIFIED", "ID_UNVERIFIED"],
  );
});

test("deny underage: store record with age not verified and ID verified returns AGE_UNVERIFIED only", () => {
  const input = specExampleInput();
  input.buyer = { attestation_id: "att_demo_age0" };
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["AGE_UNVERIFIED"],
  );
});

test("deny expired attestation: store record older than the freshness window is ATTESTATION_EXPIRED", () => {
  const input = specExampleInput();
  input.buyer = { attestation_id: "att_demo_old1" };
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["ATTESTATION_EXPIRED"],
  );
});

test("deny unknown attestation: an ID the gate does not hold returns both codes and says so", () => {
  const input = specExampleInput();
  input.buyer = { attestation_id: "att_unknown_zzz" };
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["AGE_UNVERIFIED", "ID_UNVERIFIED"],
  );
  assert.match(receipt.reasons[0].detail, /unknown to the gate/);
  assert.match(receipt.reasons[1].detail, /unknown to the gate/);
});

test("caller-supplied verification booleans are ignored: lying about an unverified buyer still denies", () => {
  const input = specExampleInput();
  // The store says att_demo_9b2c is unverified. The caller claims
  // otherwise in the request body; the gate must not care.
  input.buyer = {
    attestation_id: "att_demo_9b2c",
    age_verified: true,
    id_verified: true,
  } as GateCheckInput["buyer"];
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["AGE_UNVERIFIED", "ID_UNVERIFIED"],
  );
});

test("deny unknown SKU: a cart line the catalog cannot resolve is CART_ITEM_UNKNOWN", () => {
  const input = specExampleInput();
  input.cart = [{ sku: "NOPE-999", category: "flower", quantity: 1 }];
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["CART_ITEM_UNKNOWN"],
  );
});

test("server-side ledger: an approval reserves its totals, so the same cart again is denied", () => {
  const engine = makeEngine();
  const cart: GateCheckInput = {
    jurisdiction: { country: "US", state: "IL" },
    category: "cannabis",
    merchant_id: "mrc_demo_prairie",
    buyer: verifiedBuyer(),
    cart: [{ sku: "FLW-001", category: "flower", quantity: 6 }],
  };
  const first = engine.check(cart);
  assert.equal(first.decision, "APPROVE"); // 21 g cart + 7 g history = 28 g, inside 30 g
  const second = engine.check(cart);
  assert.equal(second.decision, "DENY"); // 21 g cart + 28 g now on record = 49 g
  const reason = second.reasons.find((r) => r.code === "LIMIT_EXCEEDED");
  assert.equal(reason?.attempted, 49);
});

test("refuse to guess: an unconfigured state is JURISDICTION_NOT_SERVED", () => {
  const input = specExampleInput();
  input.jurisdiction = { country: "US", state: "XX" };
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["JURISDICTION_NOT_SERVED"],
  );
});

test("refuse to guess: an unconfigured category in a served state is CATEGORY_NOT_ENABLED", () => {
  const input = specExampleInput();
  input.category = "tobacco";
  const receipt = makeEngine().check(input);
  assert.equal(receipt.decision, "DENY");
  assert.deepEqual(
    receipt.reasons.map((r) => r.code),
    ["CATEGORY_NOT_ENABLED"],
  );
});

test("alcohol standalone: a small verified alcohol cart is approved by item count", () => {
  const receipt = makeEngine().check({
    jurisdiction: { country: "US", state: "IL" },
    category: "alcohol",
    merchant_id: "ext_demo",
    buyer: verifiedBuyer(),
    cart: [{ sku: "ALC-001", category: "alcohol", quantity: 2 }],
  });
  assert.equal(receipt.decision, "APPROVE");
  assert.equal(receipt.evaluated.items_total, 2);
  assert.deepEqual(receipt.evaluated.limits_applied, { items_per_day: 24 });
});

test("alcohol standalone: past the item cap is LIMIT_EXCEEDED", () => {
  const receipt = makeEngine().check({
    jurisdiction: { country: "US", state: "IL" },
    category: "alcohol",
    merchant_id: "ext_demo",
    buyer: verifiedBuyer(),
    cart: [{ sku: "ALC-001", category: "alcohol", quantity: 30 }],
  });
  assert.equal(receipt.decision, "DENY");
  assert.equal(receipt.reasons[0].code, "LIMIT_EXCEEDED");
  assert.equal(receipt.reasons[0].attempted, 30);
});

test("determinism: the same input and store state produces a byte-identical decision", () => {
  const a = makeEngine().check(specExampleInput());
  const b = makeEngine().check(specExampleInput());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("limits lookup: IL cannabis config is exposed for local pre-checks, labeled simulated", () => {
  const engine = makeEngine();
  const config = engine.limits("US", "IL", "cannabis");
  assert.ok(config);
  assert.equal(config.limits.flower_equivalent_g_per_day, 30);
  assert.equal(config.limits.infused_thc_mg_per_day, 500);
  assert.equal(config.simulated, true);
  assert.equal(config.policy_id, "SIMULATED_POLICY_V1");
  assert.equal(engine.limits("US", "XX", "cannabis"), null);
});
