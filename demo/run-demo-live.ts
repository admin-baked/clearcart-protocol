// ClearCart demo runner, LIVE variant: the same four beats as
// demo/run-demo.ts, but agent language runs on the real Meta Model API
// (muse-spark-1.3) through MetaLiveProvider, so this is the dress
// rehearsal for the recorded demo. The gate, the rail, and every
// compliance decision are the same deterministic code as the mock run,
// and every beat check below is identical to the mock run's.
//
// Run it:  npm run demo:live
// Every model call's request and response JSON is written verbatim to
// the evidence directory (default
// ~/workspace/hackathon-meta-2026/evidence/live-run-2026-11-03, override
// with CLEARCART_EVIDENCE_DIR), plus a summary.json for the run. This
// runner is never invoked by the test suite.
//
// One structural difference from the mock runner, forced by live model
// behavior: Beat 1 runs as its own browsing session, and the gate is
// restarted (fresh seeded ledger) before the order session of Beats 2
// and 3. The mock's scripted buyer only browses in Beat 1, but a live
// agent reasonably carts its discovery picks and orders them, which
// would consume gate ledger the order beats' expectations are written
// against. Isolating the sessions keeps every check honest and
// unchanged. Beats 2 and 3 share one session, exactly as in the mock
// run, because Beat 3's denial depends on Beat 2's reservation.
//
// A second live-model behavior the runner absorbs: where the mock's
// buyer places the order immediately after the quote, the live model
// presents the quote and asks the shopper to confirm. The runner plays
// the shopper honestly and answers "Yes, place the order." (visible in
// the transcript), which mirrors the explicit approval step the
// protocol already requires for payment.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startGateServer } from "../services/gate/src/server.ts";
import { GateClient } from "../services/gate/src/client.ts";
import { MetaLiveProvider, type MetaLiveCallRecord } from "../providers/meta-live.ts";
import { StubRail } from "../payments/stub-rail.ts";
import { MerchantAgent } from "../agents/merchant/merchant-agent.ts";
import { BuyerAgent } from "../agents/buyer/buyer-agent.ts";
import { loadDemoState } from "./seed.ts";

const DEMO_GATE_KEY = "demo-gate-key";
const MODEL = "muse-spark-1.3";

const evidenceDir =
  process.env.CLEARCART_EVIDENCE_DIR ??
  join(homedir(), "workspace/hackathon-meta-2026/evidence/live-run-2026-11-03");
mkdirSync(evidenceDir, { recursive: true });

const startedAt = new Date().toISOString();
const callRecords: MetaLiveCallRecord[] = [];
const checks: Array<{ beat: string; label: string; ok: boolean }> = [];
let currentBeat = "setup";
let failures = 0;
let runError: string | undefined;

function check(label: string, ok: boolean) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  checks.push({ beat: currentBeat, label, ok });
  if (!ok) failures += 1;
}

function header(text: string) {
  console.log(`\n=== ${text} ===`);
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

const provider = new MetaLiveProvider({
  model: MODEL,
  onCall: (record) => {
    callRecords.push(record);
    writeFileSync(
      join(evidenceDir, `call-${pad3(record.seq)}-request.json`),
      JSON.stringify(record.request, null, 2) + "\n",
    );
    writeFileSync(
      join(evidenceDir, `call-${pad3(record.seq)}-response.json`),
      JSON.stringify(record.response, null, 2) + "\n",
    );
  },
});

function usageTotals(): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const record of callRecords) {
    const usage = (record.response as { usage?: Record<string, unknown> }).usage;
    if (!usage) continue;
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
      const value = usage[key];
      if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

function writeSummary() {
  const beats: Record<string, { passed: boolean; checks: typeof checks }> = {};
  for (const c of checks) {
    beats[c.beat] ??= { passed: true, checks: [] };
    beats[c.beat].checks.push(c);
    if (!c.ok) beats[c.beat].passed = false;
  }
  const summary = {
    run: "clearcart demo:live dress rehearsal",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    provider: provider.name,
    model: MODEL,
    total_model_calls: callRecords.length,
    usage_totals: usageTotals(),
    beats,
    failures,
    error: runError ?? null,
    all_beats_passed: failures === 0 && runError === undefined,
  };
  writeFileSync(join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

interface Session {
  state: ReturnType<typeof loadDemoState>;
  rail: StubRail;
  merchant: MerchantAgent;
  buyer: BuyerAgent;
}

function buildSession(gateBaseUrl: string): Session {
  const state = loadDemoState();
  const gateClient = new GateClient(gateBaseUrl, { apiKey: DEMO_GATE_KEY });
  const rail = new StubRail({ merchant_id: state.merchant.id });
  const merchant = new MerchantAgent({ state, provider, gate: gateClient, rail });
  const buyer = new BuyerAgent({ provider, merchant, buyer: state.buyers[0] });
  return { state, rail, merchant, buyer };
}

/** One shopper order instruction. If the agent answers with a quote and
 *  a confirmation question instead of placing the order (the live
 *  model's habit), the shopper confirms, once, in plain words. */
async function sendOrderInstruction(buyer: BuyerAgent, instruction: string): Promise<void> {
  const previousOrder = buyer.lastOrder;
  console.log(`Shopper: ${instruction}`);
  console.log(`Buyer agent: ${await buyer.send(instruction)}`);
  if (buyer.lastOrder === previousOrder) {
    const confirm = "Yes, place the order.";
    console.log(`Shopper: ${confirm}`);
    console.log(`Buyer agent: ${await buyer.send(confirm)}`);
  }
}

async function main(): Promise<void> {
  console.log("ClearCart Protocol + ClearCart Gate: LIVE dress rehearsal");
  console.log(`Model provider: Meta Model API (live, model ${MODEL}) via the connected helper. Payment rail: sandbox stub. No real money moves: the merchant is Lakeshore Cannabis Club (Romeoville, IL) and its catalog is the store's real published menu; buyers and transactions are simulated.`);
  console.log(`Evidence directory: ${evidenceDir}`);

  try {
    // ----- Beat 1: discovery and a grounded product question -------------
    // Browsing session: its own gate, closed before the order session.
    const gateA = await startGateServer({ port: 0, apiKey: DEMO_GATE_KEY });
    console.log(`Gate service (browsing session) listening at ${gateA.baseUrl} (standalone, x-gate-key auth on)`);
    try {
      const { buyer } = buildSession(gateA.baseUrl);
      currentBeat = "Beat 1";
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
    } finally {
      await gateA.close();
    }

    // ----- Order session: Beats 2, 3 and 4 on a fresh seeded gate -------
    const gate = await startGateServer({ port: 0, apiKey: DEMO_GATE_KEY });
    console.log(`Gate service (order session) listening at ${gate.baseUrl} (standalone, x-gate-key auth on)`);
    try {
      const { state, rail, buyer } = buildSession(gate.baseUrl);

      // ----- Beat 2: the approved order -----------------------------------
      currentBeat = "Beat 2";
      header("BEAT 2: The approved order");
      const orderAsk = "I will take 1 Cresco Lemon Bean, 1 IC Collective Citrus Black Grape, and 1 Uncle Arnie's Sunrise Orange, please.";
      await sendOrderInstruction(buyer, orderAsk);
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

      // ----- Beat 3: the blocked order --------------------------------------
      currentBeat = "Beat 3";
      header("BEAT 3: The blocked order");
      const restockAsk = "Restock run: 2 RYTHM Animal Face.";
      await sendOrderInstruction(buyer, restockAsk);
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

      // ----- Beat 4: the gate stands alone ------------------------------------
      currentBeat = "Beat 4";
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
    } finally {
      await gate.close();
    }

    header("DEMO COMPLETE");
    if (failures > 0) {
      console.log(`${failures} beat check(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log("All four beats produced the expected outputs.");
    }
  } catch (err) {
    runError = (err as Error).message;
    failures += 1;
    console.log(`\nRUN ERROR: ${runError}`);
    process.exitCode = 1;
  } finally {
    writeSummary();
  }
}

await main();
