import type { DecisionReceipt, ResolvedCartLine } from "../services/gate/src/receipt.ts";

// PaymentRail: the seam between the merchant agent and a payment rail.
//
// The shape follows the compliant debit-rail handoff pattern BakedBot uses
// in its production model: merchant-scoped credentials, a hosted payment
// session the buyer approves, and a webhook confirmation back to the
// merchant. The reference implementation ships one stub implementation
// (payments/stub-rail.ts) that moves no money and holds no real
// credentials. A live rail integration is production roadmap, not part of
// this demo.

export interface PaymentSession {
  session_id: string;
  order_id: string;
  merchant_id: string;
  amount_usd: number;
  status: "open" | "approved" | "confirmed";
  // Hosted approval page in a real rail. In the stub this is a labeled
  // sandbox string, never a real URL a buyer could pay through.
  approval_screen: string;
}

export interface PaymentWebhook {
  type: "payment.confirmed";
  session_id: string;
  order_id: string;
}

export interface CreateSessionInput {
  order_id: string;
  merchant_id: string;
  amount_usd: number;
  /** The ClearCart Gate receipt authorizing this payment. Required:
   *  a rail must refuse to open a session without one. The rail
   *  verifies the receipt's signature, decision, expiry, merchant,
   *  and cart binding, and enforces single use of the decision ID. */
  gate_receipt?: DecisionReceipt;
  /** The order's cart lines with catalog-resolved attributes, so the
   *  rail can recompute the cart hash and compare it against the hash
   *  bound into the receipt. */
  cart_lines?: ResolvedCartLine[];
}

export interface PaymentRail {
  readonly name: string;
  createSession(input: CreateSessionInput): Promise<PaymentSession>;
  /** Simulates the buyer approving the hosted session. Returns the webhook
   *  payload the rail would POST back to the merchant. */
  approve(session_id: string): Promise<PaymentWebhook>;
  /** Pickup code issued once a session is confirmed. */
  pickupCodeFor(session_id: string): string;
  /** Number of sessions ever created. The demo uses this to prove a denied
   *  order never created one. */
  sessionCount(): number;
}
