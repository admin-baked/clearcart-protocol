// Sandbox payment rail stub.
//
// SANDBOX ONLY: no money moves, no card or bank details are collected, and
// the merchant credentials below are fake demo values. The stub mimics the
// handoff shape of a compliant debit rail (hosted approval session plus
// webhook confirmation) so the protocol flow can be demonstrated and
// tested end to end.
//
// Enforcement: opening a session requires a ClearCart Gate receipt, and
// the stub verifies it the way a real rail integration must:
//   1. a receipt is present at all,
//   2. it was issued for this merchant,
//   3. its HMAC signature is valid over the bound fields (merchant,
//      decision, catalog-resolved cart hash, policy, expiry),
//   4. the decision is APPROVE,
//   5. it has not expired,
//   6. the cart being paid hashes to the cart the gate approved,
//   7. the decision ID has never been consumed before (single use).
// Any failure rejects session creation. There is no code path from a
// denied, forged, altered, expired, or replayed authorization to a
// payment session.

import { computeCartHash, verifyReceiptSignature } from "../services/gate/src/receipt.ts";
import type { CreateSessionInput, PaymentRail, PaymentSession, PaymentWebhook } from "./rail.ts";

export interface StubRailOptions {
  // Merchant-scoped demo credentials, mirroring the production model where
  // each merchant holds its own account and keys. Fake values, demo only.
  merchant_id: string;
  demo_api_key?: string;
  // Shared demo secret the gate signs receipts with. Demo-grade: a real
  // rail would verify with the gate's public key or a managed secret.
  gate_secret?: string;
  // Injectable clock so expiry behavior is testable.
  clock?: () => Date;
}

export class StubRail implements PaymentRail {
  readonly name = "sandbox-stub-rail";
  private readonly merchantId: string;
  private readonly demoApiKey: string;
  private readonly gateSecret: string;
  private readonly clock: () => Date;
  private readonly sessions = new Map<string, PaymentSession>();
  private readonly pickupCodes = new Map<string, string>();
  private readonly consumedDecisionIds = new Set<string>();
  private seq = 0;
  private confirmedCount = 0;

  constructor(options: StubRailOptions) {
    this.merchantId = options.merchant_id;
    this.demoApiKey = options.demo_api_key ?? "demo-merchant-key-not-real";
    void this.demoApiKey; // Held to mirror the real rail's shape; never sent anywhere.
    this.gateSecret = options.gate_secret ?? process.env.GATE_DEMO_SECRET ?? "demo-secret";
    this.clock = options.clock ?? (() => new Date());
  }

  async createSession(input: CreateSessionInput): Promise<PaymentSession> {
    if (input.merchant_id !== this.merchantId) {
      throw new Error(`Stub rail: unknown merchant ${input.merchant_id}`);
    }
    this.verifyGateAuthorization(input);
    this.seq += 1;
    const session: PaymentSession = {
      session_id: `sess_demo_${String(this.seq).padStart(4, "0")}`,
      order_id: input.order_id,
      merchant_id: input.merchant_id,
      amount_usd: input.amount_usd,
      status: "open",
      approval_screen: `Sandbox: no real money. Demo hosted approval screen for order ${input.order_id}, $${input.amount_usd.toFixed(2)}.`,
    };
    this.sessions.set(session.session_id, session);
    return session;
  }

  /** The enforcement boundary. Throws a coded error on any failure and
   *  consumes the decision ID only after every check has passed. */
  private verifyGateAuthorization(input: CreateSessionInput): void {
    const receipt = input.gate_receipt;
    if (!receipt) {
      throw new Error("GATE_RECEIPT_MISSING: a payment session requires an approved ClearCart Gate receipt.");
    }
    if (receipt.merchant_id !== input.merchant_id) {
      throw new Error(
        `GATE_MERCHANT_MISMATCH: receipt was issued for merchant ${receipt.merchant_id}, not ${input.merchant_id}.`,
      );
    }
    if (!verifyReceiptSignature(receipt, this.gateSecret)) {
      throw new Error("GATE_RECEIPT_FORGED: receipt signature verification failed.");
    }
    if (receipt.decision !== "APPROVE") {
      throw new Error(`GATE_DECISION_NOT_APPROVED: gate decision is ${receipt.decision}; payment requires APPROVE.`);
    }
    if (this.clock().getTime() > Date.parse(receipt.expires_at)) {
      throw new Error(`GATE_RECEIPT_EXPIRED: receipt ${receipt.decision_id} expired at ${receipt.expires_at}.`);
    }
    if (!input.cart_lines || computeCartHash(input.cart_lines) !== receipt.cart_hash) {
      throw new Error("GATE_CART_MISMATCH: the cart being paid does not match the cart the gate approved.");
    }
    if (this.consumedDecisionIds.has(receipt.decision_id)) {
      throw new Error(`GATE_RECEIPT_REPLAYED: gate decision ${receipt.decision_id} was already consumed by an earlier payment session.`);
    }
    this.consumedDecisionIds.add(receipt.decision_id);
  }

  async approve(session_id: string): Promise<PaymentWebhook> {
    const session = this.sessions.get(session_id);
    if (!session) throw new Error(`Stub rail: unknown session ${session_id}`);
    session.status = "confirmed";
    this.confirmedCount += 1;
    // Deterministic demo codes: the first confirmed order in the recorded
    // demo issues PR-4821, matching DEMO_SCRIPT.md.
    this.pickupCodes.set(session_id, `PR-${4820 + this.confirmedCount}`);
    return { type: "payment.confirmed", session_id, order_id: session.order_id };
  }

  pickupCodeFor(session_id: string): string {
    const session = this.sessions.get(session_id);
    if (!session || session.status !== "confirmed") {
      throw new Error(`Stub rail: no pickup code before confirmation (${session_id})`);
    }
    const code = this.pickupCodes.get(session_id);
    if (!code) throw new Error(`Stub rail: no pickup code recorded for ${session_id}`);
    return code;
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}
