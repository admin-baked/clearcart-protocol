// ClearCart demo runner: executes the four DEMO_SCRIPT.md beats, in order,
// against a live gate service, the merchant and buyer agents, and the
// sandbox payment rail. Agent language runs on the deterministic
// MockProvider, so the run is reproducible with zero API access.
//
// Run it:  npm run demo        (or demo/run-demo.sh)
// The runner self-checks the headline expectations of each beat and exits
// non-zero if any beat misbehaves, so it doubles as a smoke test.

import { startGateServer } from "../services/gate/src/server.ts";
import { GateClient } from "../services/gate/src/client.ts";
import { MockProvider } from "../providers/mock.ts";
import { StubRail } from "../payments/stub-rail.ts";
import { MerchantAgent } from "../agents/merchant/merchant-agent.ts";
import { BuyerAgent } from "../agents/buyer/buyer-agent.ts";
import { loadDemoState } from "./seed.ts";

const DEMO_GATE_KEY = "demo-gate-key";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failures += 1;
}

function header(text: string) {
  console.log(`\n=== ${text} ===`);
}

async function main(): Promise<void> {
  console.log("ClearCart Protocol + ClearCart Gate: reference implementation demo");
  console.log("Model provider: mock (deterministic). Payment rail: sandbox stub. No real money moves: the merchant is Lakeshore Cannabis Club (Romeoville, IL) and its catalog is the store's real published menu; buyers and transactions are simulated.");

  const gate = await startGateServer({ port: 0, apiKey: DEMO_GATE_KEY });
  console.log(`Gate service listening at ${gate.baseUrl} (standalone, x-gate-key auth on)`);
  try {
    const state = loadDemoState();
    const gateClient = new GateClient(gate.baseUrl, { apiKey: DEMO_GATE_KEY });
    const rail = new StubRail({ merchant_id: state.merchant.id });
    const merchant = new MerchantAgent({
      state,
      provider: new MockProvider(),
      gate: gateClient,
      rail,
    });
    const buyer = new BuyerAgent({
      provider: new MockProvider(),
      merchant,
      buyer: state.buyers[0],
    });

    // ----- Beat 1: discovery and a grounded product question ---------------
    header("BEAT 1: Discovery and a product question");
    const shopperAsk =
      "Find me a dispensary near Romeoville with something citrus-forward for the weekend, and keep it under a hundred dollars.";
    console.log(`Shopper: ${shopperAsk}`);
    console.log(`Buyer agent: ${await buyer.send(shopperAsk)}`);
    const followUp = "Is the Cresco Lemon Bean any good for a Saturday afternoon?";
    console.log(`Shopper: ${followUp}`);
    const answer = await buyer.send(followUp);
    console.log(`Buyer agent (relaying the merchant): ${answer}`);
    check("merchant answered from menu data (names the item, size, price)", answer.includes("Lemon Bean") && answer.includes("$28.11"));

    // ----- Beat 2: the approved order ---------------------------------------
    header("BEAT 2: The approved order");
    const orderAsk = "I will take 1 Cresco Lemon Bean, 1 IC Collective Citrus Black Grape, and 1 Uncle Arnie's Sunrise Orange, please.";
    console.log(`Shopper: ${orderAsk}`);
    console.log(`Buyer agent: ${await buyer.send(orderAsk)}`);
    const approvedOrder = buyer.lastOrder;
    if (!approvedOrder) throw new Error("Beat 2 produced no order");
    console.log("Gate receipt:");
    console.log(JSON.stringify(approvedOrder.gate_decision, null, 2));
    check("gate decision is APPROVE", approvedOrder.gate_decision?.decision === "APPROVE");
    check(
      "evaluated totals are 10.5 g flower and 400 mg infused THC",
      approvedOrder.gate_decision?.evaluated.flower_equivalent_g_total === 10.5 &&
        approvedOrder.gate_decision?.evaluated.infused_thc_mg_total === 400,
    );
    check(
      "receipt names the simulated policy",
      approvedOrder.gate_decision?.policy_id === "SIMULATED_POLICY_V1",
    );
    check("a payment session exists only after approval", Boolean(approvedOrder.payment_session_id));
    const paid = await buyer.confirmPayment();
    console.log(`Payment: sandbox rail confirmed session ${paid.payment_session_id}.`);
    console.log(`Order status: ${paid.status}. Pickup code: ${paid.pickup_code}`);
    check("order is READY_FOR_PICKUP", paid.status === "READY_FOR_PICKUP");
    check("pickup code is PR-4821", paid.pickup_code === "PR-4821");

    // ----- Beat 3: the blocked order ----------------------------------------
    header("BEAT 3: The blocked order");
    const restockAsk = "Restock run: 2 RYTHM Animal Face.";
    console.log(`Shopper: ${restockAsk}`);
    console.log(`Buyer agent: ${await buyer.send(restockAsk)}`);
    const deniedOrder = buyer.lastOrder;
    if (!deniedOrder) throw new Error("Beat 3 produced no order");
    console.log("Gate receipt:");
    console.log(JSON.stringify(deniedOrder.gate_decision, null, 2));
    const reasonCodes = deniedOrder.gate_decision?.reasons.map((r) => r.code) ?? [];
    check("gate decision is DENY", deniedOrder.gate_decision?.decision === "DENY");
    check("reason codes include LIMIT_EXCEEDED", reasonCodes.includes("LIMIT_EXCEEDED"));
    check(
      "attempted flower-equivalent total is 38.5 g against the 30 g limit",
      deniedOrder.gate_decision?.reasons.some((r) => r.limit === 30 && r.attempted === 38.5) ?? false,
    );
    check("no payment session was created for the denied order", !deniedOrder.payment_session_id);
    check("rail still has exactly 1 session (the approved order only)", rail.sessionCount() === 1);

    // The bypass attempt: skip the gate entirely and ask the payment
    // rail for a session anyway. The rail requires a valid gate
    // receipt, so this is rejected before any session exists.
    console.log("Bypass attempt: the buyer asks the payment rail for a session directly, no gate receipt:");
    let bypassError = "";
    try {
      await rail.createSession({
        order_id: deniedOrder.order_id,
        merchant_id: state.merchant.id,
        amount_usd: deniedOrder.total_usd,
      });
    } catch (err) {
      bypassError = (err as Error).message;
    }
    console.log(`Payment rail: REJECTED. ${bypassError}`);
    check("bypass attempt without a gate receipt is rejected", bypassError.startsWith("GATE_RECEIPT_MISSING"));
    check("rail still has exactly 1 session after the bypass attempt", rail.sessionCount() === 1);

    // ----- Beat 4: the gate stands alone --------------------------------------
    header("BEAT 4: The gate stands alone (someone else's agent, alcohol)");
    const alcoholPayload = {
      jurisdiction: { country: "US", state: "IL" },
      category: "alcohol",
      merchant_id: "ext_demo",
      buyer: { attestation_id: state.buyers[0].attestation.attestation_id },
      cart: [{ sku: "ALC-001", category: "alcohol", quantity: 2 }],
    };
    console.log("Equivalent call from any agent, in any framework:");
    console.log(
      `curl -s -X POST ${gate.baseUrl}/v1/gate/check -H "content-type: application/json" ` +
        `-H "x-gate-key: ${DEMO_GATE_KEY}" -d '${JSON.stringify(alcoholPayload)}'`,
    );
    const res = await fetch(`${gate.baseUrl}/v1/gate/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gate-key": DEMO_GATE_KEY },
      body: JSON.stringify(alcoholPayload),
    });
    const alcoholDecision = (await res.json()) as { decision?: string; evaluated?: { items_total?: number } };
    console.log("Gate response:");
    console.log(JSON.stringify(alcoholDecision, null, 2));
    check("standalone alcohol check returns APPROVE", alcoholDecision.decision === "APPROVE");
    check("standalone check evaluated 2 items", alcoholDecision.evaluated?.items_total === 2);

    header("DEMO COMPLETE");
    if (failures > 0) {
      console.log(`${failures} beat check(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log("All four beats produced the expected outputs.");
    }
  } finally {
    await gate.close();
  }
}

await main();
