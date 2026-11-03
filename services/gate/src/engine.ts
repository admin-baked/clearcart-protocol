// ClearCart Gate: deterministic rules engine.
//
// This module is the whole decision path for the compliance gate, and it
// is deliberately boring: no LLM, no network, no randomness. Given the
// same request, the same configuration, the same trusted-store state,
// the same clock, and the same receipt secret, it produces a
// byte-identical decision receipt. That is the point of a compliance
// gate: the answer is reproducible and auditable.
//
// Trust model. The gate resolves everything that matters itself:
// - Buyer verification comes from the gate's own attestation store,
//   looked up by attestation_id. Verification flags a caller puts in
//   the request are ignored, in both directions.
// - Product attributes (flower-equivalent grams, per-unit infused THC)
//   come from the gate-side merchant catalog, by SKU. Attribute values
//   a caller puts in the request are ignored. A SKU the catalog does
//   not know is a denial, never a guess.
// - Purchase history comes from the gate's own ledger, and an APPROVE
//   decision reserves its totals in that ledger immediately, inside
//   the same synchronous call, so concurrent carts cannot both slip
//   over a limit.
//
// Decisions must never be delegated to a language model. A model may
// word the explanation of a decision for a shopper (see the merchant
// agent), but the decision and its reason codes are fixed here, before
// any model call.

import {
  computeCartHash,
  signReceipt,
  verifyReceiptSignature,
  type DecisionReceipt,
  type DecisionValue,
  type Evaluated,
  type Reason,
  type ResolvedCartLine,
} from "./receipt.ts";
import { AttestationStore, PurchaseLedger } from "./store.ts";

export type { DecisionReceipt, DecisionValue, Evaluated, Reason, ResolvedCartLine };
export type { AttestationRecord, LedgerEntry, LedgerTotals } from "./store.ts";

export interface GateConfig {
  country: string;
  state: string;
  category: string;
  enabled: boolean;
  simulated: boolean;
  /** Policy identifier stamped onto every receipt this config produces. */
  policy_id: string;
  label: string;
  attestation_max_age_hours?: number;
  limits: {
    flower_equivalent_g_per_day?: number;
    infused_thc_mg_per_day?: number;
    items_per_day?: number;
  };
}

export interface GateBuyerInput {
  /** The only buyer field the gate reads. Everything about the buyer
   *  is resolved server-side from this ID. Any verification booleans a
   *  caller also sends are ignored by design. */
  attestation_id: string;
}

export interface GateCartLine {
  sku: string;
  category?: string;
  quantity: number;
  /** Ignored for the decision. Attributes are resolved from the
   *  gate-side catalog by SKU. Accepted in the shape only so older
   *  callers do not break; they change nothing. */
  unit_thc_mg?: number;
  flower_equivalent_g?: number;
}

export interface GateCheckInput {
  jurisdiction: { country: string; state: string };
  category: string;
  /** Identifies whose catalog resolves the cart and who the receipt
   *  is bound to. */
  merchant_id: string;
  buyer: GateBuyerInput;
  cart: GateCartLine[];
}

export interface CatalogItem {
  sku: string;
  category: string;
  flower_equivalent_g: number;
  unit_thc_mg: number;
}

export type CatalogMap = Map<string, Map<string, CatalogItem>>;

export interface GateEngineOptions {
  // Injectable clock so tests and the recorded demo are deterministic.
  clock?: () => Date;
  // Demo HMAC secret for receipt signing. Demo-grade shared secret: a
  // production deployment would sign receipts with managed keys held
  // only by the gate.
  secret?: string;
  // Trusted server-side state. Defaults are empty, which fails closed:
  // every attestation is unknown and every SKU is unresolvable.
  attestations?: AttestationStore;
  ledger?: PurchaseLedger;
  catalogs?: CatalogMap;
}

const RECEIPT_TTL_MS = 5 * 60 * 1000;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function configKey(country: string, state: string, category: string): string {
  return `${country.toUpperCase()}:${state.toUpperCase()}:${category.toLowerCase()}`;
}

export class GateEngine {
  private readonly configs: Map<string, GateConfig>;
  private readonly clock: () => Date;
  private readonly secret: string;
  private readonly attestations: AttestationStore;
  private readonly ledger: PurchaseLedger;
  private readonly catalogs: CatalogMap;
  private sequence = 0;

  constructor(configs: Iterable<GateConfig>, options: GateEngineOptions = {}) {
    this.configs = new Map();
    for (const cfg of configs) {
      this.configs.set(configKey(cfg.country, cfg.state, cfg.category), cfg);
    }
    this.clock = options.clock ?? (() => new Date());
    this.secret = options.secret ?? process.env.GATE_DEMO_SECRET ?? "demo-secret";
    this.attestations = options.attestations ?? new AttestationStore();
    this.ledger = options.ledger ?? new PurchaseLedger();
    this.catalogs = options.catalogs ?? new Map();
  }

  /** True when any limit configuration exists for the jurisdiction at all. */
  private hasJurisdiction(country: string, state: string): boolean {
    const prefix = `${country.toUpperCase()}:${state.toUpperCase()}:`;
    for (const key of this.configs.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Returns the active limit configuration, or null when none applies. */
  limits(country: string, state: string, category: string): GateConfig | null {
    return this.configs.get(configKey(country, state, category)) ?? null;
  }

  /** Resolves cart lines against the merchant's gate-side catalog.
   *  Unknown SKUs resolve to zero attributes and are reported by SKU so
   *  the caller of check() can deny them by name. */
  private resolveCart(input: GateCheckInput): { resolved: ResolvedCartLine[]; unknownSkus: string[] } {
    const catalog = this.catalogs.get(input.merchant_id);
    const resolved: ResolvedCartLine[] = [];
    const unknownSkus: string[] = [];
    for (const line of input.cart) {
      const item = catalog?.get(line.sku);
      if (!item) {
        unknownSkus.push(line.sku);
        resolved.push({ sku: line.sku, quantity: line.quantity, flower_equivalent_g: 0, unit_thc_mg: 0 });
      } else {
        resolved.push({
          sku: item.sku,
          quantity: line.quantity,
          flower_equivalent_g: item.flower_equivalent_g,
          unit_thc_mg: item.unit_thc_mg,
        });
      }
    }
    return { resolved, unknownSkus };
  }

  check(input: GateCheckInput): DecisionReceipt {
    const now = this.clock();
    const { country, state } = input.jurisdiction;
    const config = this.limits(country, state, input.category);
    const merchant_id = input.merchant_id ?? "";
    const policy_id = config?.policy_id ?? "NONE";
    const { resolved, unknownSkus } = this.resolveCart(input);
    const cart_hash = computeCartHash(resolved);
    const evaluated: Evaluated = { limits_applied: {} };
    const issue = (decision: DecisionValue, reasons: Reason[]): DecisionReceipt =>
      this.issue({ merchant_id, policy_id, cart_hash, decision, reasons, evaluated, now });

    if (!config) {
      // Refuse rather than guess: an unconfigured jurisdiction or
      // category is a denial with a machine-readable reason, never a
      // silent pass.
      if (this.hasJurisdiction(country, state)) {
        return issue("DENY", [{
          code: "CATEGORY_NOT_ENABLED",
          detail: `The gate has no enabled ${input.category} configuration for ${state.toUpperCase()}.`,
        }]);
      }
      return issue("DENY", [{
        code: "JURISDICTION_NOT_SERVED",
        detail: `The gate serves no jurisdiction matching ${state.toUpperCase()}, ${country.toUpperCase()}.`,
      }]);
    }

    if (!config.enabled) {
      return issue("DENY", [{
        code: "CATEGORY_NOT_ENABLED",
        detail: `Category ${input.category} is not enabled for ${state.toUpperCase()}.`,
      }]);
    }

    // Buyer verification, resolved from the gate's trusted store. An
    // attestation the gate does not hold cannot establish anything:
    // both checks fail, and the receipt says why.
    const attestation = this.attestations.resolve(input.buyer.attestation_id);
    if (!attestation) {
      return issue("DENY", [
        {
          code: "AGE_UNVERIFIED",
          detail: `Attestation ${input.buyer.attestation_id} is unknown to the gate, so age verification cannot be established.`,
        },
        {
          code: "ID_UNVERIFIED",
          detail: `Attestation ${input.buyer.attestation_id} is unknown to the gate, so identity verification cannot be established.`,
        },
      ]);
    }

    const reasons: Reason[] = [];
    if (attestation.age_verified !== true) {
      reasons.push({
        code: "AGE_UNVERIFIED",
        detail: "Buyer attestation on file does not confirm age verification (21+).",
      });
    }
    if (attestation.id_verified !== true) {
      reasons.push({
        code: "ID_UNVERIFIED",
        detail: "Buyer attestation on file does not confirm identity verification.",
      });
    }
    if (config.attestation_max_age_hours) {
      const issuedMs = Date.parse(attestation.issued_at);
      if (!Number.isNaN(issuedMs)) {
        const ageHours = (now.getTime() - issuedMs) / 3_600_000;
        if (ageHours > config.attestation_max_age_hours) {
          reasons.push({
            code: "ATTESTATION_EXPIRED",
            detail: `Attestation is ${Math.floor(ageHours)} hours old; the freshness window is ${config.attestation_max_age_hours} hours.`,
          });
        }
      }
    }

    // Catalog integrity: every line must be a product the merchant's
    // catalog can price for compliance. An unknown SKU means the gate
    // cannot know what is being sold, so it refuses.
    for (const sku of unknownSkus) {
      reasons.push({
        code: "CART_ITEM_UNKNOWN",
        detail: `SKU ${sku} is not in the catalog the gate holds for merchant ${merchant_id}; its contents cannot be verified.`,
      });
    }

    // Limit arithmetic. Cart totals come from catalog-resolved
    // attributes; history comes from the gate's ledger. Totals are
    // computed only for the metrics this configuration limits.
    const priors = this.ledger.totalsFor(attestation.attestation_id);
    const limits = config.limits;
    const cartFlower = resolved.reduce((s, l) => s + l.quantity * l.flower_equivalent_g, 0);
    const cartInfused = resolved.reduce((s, l) => s + l.quantity * l.unit_thc_mg, 0);
    const cartItems = resolved.reduce((s, l) => s + l.quantity, 0);

    if (limits.flower_equivalent_g_per_day !== undefined) {
      const total = round3(cartFlower + priors.flower_equivalent_g);
      evaluated.flower_equivalent_g_total = total;
      evaluated.limits_applied.flower_equivalent_g_per_day = limits.flower_equivalent_g_per_day;
      if (total > limits.flower_equivalent_g_per_day) {
        reasons.push({
          code: "LIMIT_EXCEEDED",
          detail: `This purchase would put the buyer at ${total} g flower-equivalent against a ${limits.flower_equivalent_g_per_day} g daily limit.`,
          limit: limits.flower_equivalent_g_per_day,
          attempted: total,
        });
      }
    }

    if (limits.infused_thc_mg_per_day !== undefined) {
      const total = round3(cartInfused + priors.infused_thc_mg);
      evaluated.infused_thc_mg_total = total;
      evaluated.limits_applied.infused_thc_mg_per_day = limits.infused_thc_mg_per_day;
      if (total > limits.infused_thc_mg_per_day) {
        reasons.push({
          code: "LIMIT_EXCEEDED",
          detail: `This purchase would put the buyer at ${total} mg infused THC against a ${limits.infused_thc_mg_per_day} mg daily limit.`,
          limit: limits.infused_thc_mg_per_day,
          attempted: total,
        });
      }
    }

    if (limits.items_per_day !== undefined) {
      const total = cartItems + priors.items;
      evaluated.items_total = total;
      evaluated.limits_applied.items_per_day = limits.items_per_day;
      if (total > limits.items_per_day) {
        reasons.push({
          code: "LIMIT_EXCEEDED",
          detail: `This purchase would put the buyer at ${total} items against a ${limits.items_per_day} items daily limit.`,
          limit: limits.items_per_day,
          attempted: total,
        });
      }
    }

    const decision: DecisionValue = reasons.length > 0 ? "DENY" : "APPROVE";
    if (decision === "APPROVE") {
      // Reserve immediately, before the receipt leaves the gate. In
      // this single-process store the check and the reservation are
      // one synchronous step, so no second cart can be evaluated
      // against the pre-reservation history. Only the metrics this
      // policy actually limits are reserved: the ledger records what
      // each policy counts.
      this.ledger.reserve(attestation.attestation_id, {
        flower_equivalent_g: limits.flower_equivalent_g_per_day !== undefined ? round3(cartFlower) : 0,
        infused_thc_mg: limits.infused_thc_mg_per_day !== undefined ? round3(cartInfused) : 0,
        items: limits.items_per_day !== undefined ? cartItems : 0,
      });
    }
    return issue(decision, reasons);
  }

  /** Verifies a receipt the gate issued: signature intact over the
   *  bound fields, and not expired at the current clock. Merchants use
   *  this (directly or via POST /v1/gate/receipts/verify) before
   *  trusting a receipt; the payment rail runs the same checks plus
   *  single-use enforcement. */
  verify(receipt: DecisionReceipt): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!receipt || typeof receipt !== "object") {
      return { valid: false, errors: ["RECEIPT_MALFORMED"] };
    }
    if (!verifyReceiptSignature(receipt, this.secret)) {
      errors.push("SIGNATURE_INVALID");
    }
    if (this.clock().getTime() > Date.parse(receipt.expires_at)) {
      errors.push("RECEIPT_EXPIRED");
    }
    return { valid: errors.length === 0, errors };
  }

  private issue(fields: {
    merchant_id: string;
    policy_id: string;
    cart_hash: string;
    decision: DecisionValue;
    reasons: Reason[];
    evaluated: Evaluated;
    now: Date;
  }): DecisionReceipt {
    this.sequence += 1;
    const yyyymmdd = fields.now.toISOString().slice(0, 10).replaceAll("-", "");
    const unsigned: Omit<DecisionReceipt, "receipt_signature"> = {
      merchant_id: fields.merchant_id,
      decision_id: `dec_${yyyymmdd}_${String(this.sequence).padStart(4, "0")}`,
      decision: fields.decision,
      reasons: fields.reasons,
      evaluated: fields.evaluated,
      policy_id: fields.policy_id,
      cart_hash: fields.cart_hash,
      issued_at: fields.now.toISOString(),
      expires_at: new Date(fields.now.getTime() + RECEIPT_TTL_MS).toISOString(),
    };
    // HMAC-SHA256 over the canonical receipt body, binding merchant,
    // decision, the catalog-resolved cart hash, policy, and expiry.
    // Tampering with any bound field invalidates the signature.
    return { ...unsigned, receipt_signature: signReceipt(unsigned, this.secret) };
  }
}
