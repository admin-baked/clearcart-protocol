// Merchant agent: serves one demo dispensary (Prairie Test Gardens).
//
// Responsibilities: discovery entry, live menu, product Q&A grounded only
// in menu data (via ModelProvider), quotes with a TTL, the gate call before
// any payment session exists, the payment handoff, and pickup code
// issuance after the rail confirms. The merchant never decides compliance
// itself; it asks the ClearCart Gate and honors the receipt.

import type { ModelProvider } from "../../providers/model-provider.ts";
import type { GateClient } from "../../services/gate/src/client.ts";
import type { DecisionReceipt, GateCartLine } from "../../services/gate/src/engine.ts";
import type { PaymentRail, PaymentWebhook } from "../../payments/rail.ts";
import type { BuyerProfile, DemoState, MenuItem } from "../../demo/seed.ts";

export interface QuoteLine {
  sku: string;
  name: string;
  quantity: number;
  unit_price_usd: number;
  line_total_usd: number;
}

export interface Quote {
  quote_id: string;
  merchant_id: string;
  lines: QuoteLine[];
  total_usd: number;
  issued_at: string;
  expires_at: string;
}

export type OrderStatus =
  | "QUOTED"
  | "GATE_APPROVED"
  | "PAYMENT_PENDING"
  | "PAID"
  | "READY_FOR_PICKUP"
  | "GATE_DENIED"
  | "GATE_REVIEW";

export interface Order {
  order_id: string;
  merchant_id: string;
  buyer_id: string;
  lines: QuoteLine[];
  total_usd: number;
  status: OrderStatus;
  gate_decision_id?: string;
  gate_decision?: DecisionReceipt;
  payment_session_id?: string;
  pickup_code?: string;
  explanation?: string;
}

export interface MerchantAgentOptions {
  state: DemoState;
  provider: ModelProvider;
  gate: GateClient;
  rail: PaymentRail;
  clock?: () => Date;
}

const QUOTE_TTL_MS = 120_000;

export class MerchantAgent {
  private readonly state: DemoState;
  private readonly provider: ModelProvider;
  private readonly gate: GateClient;
  private readonly rail: PaymentRail;
  private readonly clock: () => Date;
  private readonly quotes = new Map<string, Quote>();
  private readonly orders = new Map<string, Order>();
  private quoteSeq = 0;
  private orderSeq = 0;

  constructor(options: MerchantAgentOptions) {
    this.state = options.state;
    this.provider = options.provider;
    this.gate = options.gate;
    this.rail = options.rail;
    this.clock = options.clock ?? (() => new Date());
  }

  get info() {
    return this.state.merchant;
  }

  directoryEntry(): { id: string; name: string; location: string } {
    const m = this.state.merchant;
    return { id: m.id, name: m.name, location: m.location };
  }

  /** Live menu: reflects inventory changes from completed orders. */
  getMenu(): MenuItem[] {
    return this.state.menu;
  }

  menuItem(sku: string): MenuItem {
    const item = this.state.menu.find((i) => i.sku === sku);
    if (!item) throw new Error(`Unknown SKU ${sku}`);
    return item;
  }

  /** Product Q&A. The model sees only the structured menu and may only
   *  describe items on it; the merchant never answers from outside data. */
  async answerQuestion(question: string): Promise<{ answer: string }> {
    const completion = await this.provider.complete([
      {
        role: "system",
        content:
          `You are the ClearCart merchant agent for ${this.state.merchant.name}. ` +
          "Answer product questions using only the menu data below. Never invent items, prices, or effects. " +
          `MENU_JSON: ${JSON.stringify(this.state.menu)}`,
      },
      { role: "user", content: question },
    ]);
    if (completion.kind !== "text") {
      throw new Error("Merchant Q&A expected a text completion");
    }
    return { answer: completion.text };
  }

  createQuote(lines: Array<{ sku: string; quantity: number }>): Quote {
    if (!lines.length) throw new Error("Cannot quote an empty cart");
    const quoteLines: QuoteLine[] = lines.map((line) => {
      const item = this.menuItem(line.sku);
      if (line.quantity > item.inventory) {
        throw new Error(`Insufficient inventory for ${line.sku}: ${item.inventory} available`);
      }
      return {
        sku: item.sku,
        name: item.name,
        quantity: line.quantity,
        unit_price_usd: item.price_usd,
        line_total_usd: line.quantity * item.price_usd,
      };
    });
    this.quoteSeq += 1;
    const now = this.clock();
    const quote: Quote = {
      quote_id: `q_${String(this.quoteSeq).padStart(4, "0")}`,
      merchant_id: this.state.merchant.id,
      lines: quoteLines,
      total_usd: quoteLines.reduce((s, l) => s + l.line_total_usd, 0),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
    };
    this.quotes.set(quote.quote_id, quote);
    return quote;
  }

  /**
   * The compliance heart of the protocol. Order of operations is the
   * product: quote, then gate check, and only on APPROVE does a payment
   * session come into existence. On DENY there is nothing to refund,
   * because nothing was ever charged.
   */
  async placeOrder(input: { quote_id: string; buyer_id: string }): Promise<Order> {
    const quote = this.quotes.get(input.quote_id);
    if (!quote) throw new Error(`Unknown quote ${input.quote_id}`);
    if (Date.parse(quote.expires_at) < this.clock().getTime()) {
      throw new Error(`Quote ${input.quote_id} has expired`);
    }
    const buyer = this.state.buyers.find((b) => b.buyer_id === input.buyer_id);
    if (!buyer) throw new Error(`Unknown buyer ${input.buyer_id}`);

    // The merchant sends the gate only an attestation ID and SKUs.
    // Verification status, purchase history, and product attributes
    // are all resolved by the gate from its own trusted store and
    // catalog; nothing the merchant (or buyer) claims about them is
    // part of the decision.
    const gateCart: GateCartLine[] = quote.lines.map((line) => {
      const item = this.menuItem(line.sku);
      return { sku: item.sku, category: item.category, quantity: line.quantity };
    });

    const receipt = await this.gate.check({
      jurisdiction: { country: "US", state: "IL" },
      category: "cannabis",
      merchant_id: this.state.merchant.id,
      buyer: { attestation_id: buyer.attestation.attestation_id },
      cart: gateCart,
    });

    this.orderSeq += 1;
    const order: Order = {
      order_id: `ord_${String(this.orderSeq).padStart(4, "0")}`,
      merchant_id: this.state.merchant.id,
      buyer_id: buyer.buyer_id,
      lines: quote.lines,
      total_usd: quote.total_usd,
      status: "QUOTED",
      gate_decision_id: receipt.decision_id,
      gate_decision: receipt,
    };
    this.orders.set(order.order_id, order);

    if (receipt.decision === "DENY") {
      order.status = "GATE_DENIED";
      order.explanation = await this.explainDenial(receipt);
      return order;
    }
    if (receipt.decision === "REVIEW") {
      order.status = "GATE_REVIEW";
      order.explanation =
        "A human operator needs to review this order before it can proceed.";
      return order;
    }

    // APPROVE: before acting on it, the merchant asks the gate to
    // verify its own receipt (signature over the bound fields, plus
    // expiry). Then, and only then, a payment session may exist. The
    // rail independently re-verifies the receipt and enforces single
    // use of the decision ID.
    const verification = await this.gate.verifyReceipt(receipt);
    if (!verification.valid) {
      order.status = "GATE_DENIED";
      order.explanation = `Gate receipt failed verification: ${verification.errors.join(", ")}`;
      return order;
    }
    order.status = "GATE_APPROVED";
    const resolvedLines = quote.lines.map((line) => {
      const item = this.menuItem(line.sku);
      return {
        sku: item.sku,
        quantity: line.quantity,
        flower_equivalent_g: item.flower_equivalent_g,
        unit_thc_mg: item.thc_mg,
      };
    });
    const session = await this.rail.createSession({
      order_id: order.order_id,
      merchant_id: this.state.merchant.id,
      amount_usd: order.total_usd,
      gate_receipt: receipt,
      cart_lines: resolvedLines,
    });
    order.payment_session_id = session.session_id;
    order.status = "PAYMENT_PENDING";

    // Inventory moves on approval. The purchase itself was already
    // reserved in the gate's own ledger at decision time; that ledger
    // is the system of record now, not anything the merchant keeps.
    for (const line of quote.lines) {
      this.menuItem(line.sku).inventory -= line.quantity;
    }
    return order;
  }

  /** Buyer approves the hosted sandbox session; the rail answers with a
   *  webhook payload, which the merchant honors like a real callback. */
  async approvePayment(order_id: string): Promise<Order> {
    const order = this.orders.get(order_id);
    if (!order) throw new Error(`Unknown order ${order_id}`);
    if (order.status !== "PAYMENT_PENDING" || !order.payment_session_id) {
      throw new Error(`Order ${order_id} is not waiting for payment (status ${order.status})`);
    }
    const webhook = await this.rail.approve(order.payment_session_id);
    return this.handlePaymentWebhook(webhook);
  }

  handlePaymentWebhook(webhook: PaymentWebhook): Order {
    const order = this.orders.get(webhook.order_id);
    if (!order) throw new Error(`Webhook for unknown order ${webhook.order_id}`);
    if (order.payment_session_id !== webhook.session_id) {
      throw new Error(`Webhook session mismatch for order ${webhook.order_id}`);
    }
    // Duplicate delivery is a fact of webhook life: a second confirm
    // for an order already fulfilled is a no-op, not a second pickup
    // code or a state regression.
    if (order.status === "READY_FOR_PICKUP") {
      return order;
    }
    order.status = "PAID";
    order.pickup_code = this.rail.pickupCodeFor(webhook.session_id);
    order.status = "READY_FOR_PICKUP";
    return order;
  }

  getOrder(order_id: string): Order {
    const order = this.orders.get(order_id);
    if (!order) throw new Error(`Unknown order ${order_id}`);
    return order;
  }

  /** Plain-language denial. This is an explanation layer only: it receives
   *  the gate's fixed decision and reason codes and words them for the
   *  shopper. It can never change the decision. If the model provider is
   *  unavailable, the merchant falls back to the reason codes' own text. */
  private async explainDenial(receipt: DecisionReceipt): Promise<string> {
    try {
      const completion = await this.provider.complete([
        {
          role: "system",
          content:
            "You are the ClearCart explanation assistant. You receive a compliance gate decision " +
            "that is already final. Explain it to the shopper in one or two plain sentences. " +
            "Never soften, reverse, or reinterpret the decision or its reason codes.",
        },
        { role: "user", content: `DECISION_JSON: ${JSON.stringify(receipt)}` },
      ]);
      if (completion.kind === "text" && completion.text) return completion.text;
    } catch {
      // Fall through to the deterministic fallback below.
    }
    return receipt.reasons.map((r) => `${r.code}: ${r.detail}`).join(" ");
  }
}
