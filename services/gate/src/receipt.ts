// Decision receipt shape, cart hashing, and receipt signing.
//
// A receipt is the gate's authorization artifact. Its HMAC-SHA256
// signature binds the fields a payment rail must trust: the merchant,
// the decision ID, a hash of the cart exactly as the gate resolved it
// from the merchant catalog, the decision itself, the policy that
// produced it, and the issue and expiry times. Changing any of those
// after the fact invalidates the signature.
//
// The signing key is a demo shared secret in this reference
// implementation. A production deployment would sign with managed keys
// held only by the gate; the binding semantics are the point here.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type DecisionValue = "APPROVE" | "DENY" | "REVIEW";

export interface Reason {
  code: string;
  detail: string;
  limit?: number;
  attempted?: number;
}

export interface Evaluated {
  flower_equivalent_g_total?: number;
  infused_thc_mg_total?: number;
  items_total?: number;
  limits_applied: Record<string, number>;
}

export interface DecisionReceipt {
  merchant_id: string;
  decision_id: string;
  decision: DecisionValue;
  reasons: Reason[];
  evaluated: Evaluated;
  policy_id: string;
  /** SHA-256 of the canonical cart lines as resolved from the catalog. */
  cart_hash: string;
  receipt_signature: string;
  issued_at: string;
  expires_at: string;
}

/** One cart line with its compliance attributes resolved from the
 *  merchant's authoritative catalog. This is the only shape whose totals
 *  the gate will ever decide on; caller-supplied attributes never enter
 *  the decision. */
export interface ResolvedCartLine {
  sku: string;
  quantity: number;
  flower_equivalent_g: number;
  unit_thc_mg: number;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Canonical cart hash: SHA-256 over the resolved lines in a fixed
 *  order and shape, so the gate and a payment rail independently compute
 *  the identical hash for the identical cart. */
export function computeCartHash(lines: ResolvedCartLine[]): string {
  const canonical = [...lines]
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.quantity - b.quantity))
    .map((l) => ({
      sku: l.sku,
      quantity: l.quantity,
      flower_equivalent_g: round3(l.flower_equivalent_g),
      unit_thc_mg: round3(l.unit_thc_mg),
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalReason(r: Reason): Record<string, unknown> {
  const out: Record<string, unknown> = { code: r.code, detail: r.detail };
  if (r.limit !== undefined) out.limit = r.limit;
  if (r.attempted !== undefined) out.attempted = r.attempted;
  return out;
}

const LIMIT_KEY_ORDER = ["flower_equivalent_g_per_day", "infused_thc_mg_per_day", "items_per_day"];

function canonicalEvaluated(e: Evaluated): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.flower_equivalent_g_total !== undefined) out.flower_equivalent_g_total = e.flower_equivalent_g_total;
  if (e.infused_thc_mg_total !== undefined) out.infused_thc_mg_total = e.infused_thc_mg_total;
  if (e.items_total !== undefined) out.items_total = e.items_total;
  const limits: Record<string, number> = {};
  for (const key of LIMIT_KEY_ORDER) {
    if (e.limits_applied[key] !== undefined) limits[key] = e.limits_applied[key];
  }
  for (const key of Object.keys(e.limits_applied).sort()) {
    if (!(key in limits)) limits[key] = e.limits_applied[key];
  }
  out.limits_applied = limits;
  return out;
}

/** The exact string the signature covers, rebuilt in a fixed field
 *  order so a receipt that round-tripped through JSON still verifies. */
export function canonicalReceiptPayload(receipt: Omit<DecisionReceipt, "receipt_signature">): string {
  return JSON.stringify({
    merchant_id: receipt.merchant_id,
    decision_id: receipt.decision_id,
    decision: receipt.decision,
    reasons: receipt.reasons.map(canonicalReason),
    evaluated: canonicalEvaluated(receipt.evaluated),
    policy_id: receipt.policy_id,
    cart_hash: receipt.cart_hash,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
  });
}

export function signReceipt(unsigned: Omit<DecisionReceipt, "receipt_signature">, secret: string): string {
  return createHmac("sha256", secret).update(canonicalReceiptPayload(unsigned)).digest("hex");
}

export function verifyReceiptSignature(receipt: DecisionReceipt, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(receipt.receipt_signature ?? "")) return false;
  const expected = signReceipt(receipt, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(receipt.receipt_signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
