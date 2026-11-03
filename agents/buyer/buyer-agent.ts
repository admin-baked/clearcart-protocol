// Buyer agent: represents the shopper.
//
// It holds a synthetic buyer profile (a demo attestation plus a purchase
// ledger) and turns shopper instructions into tool calls through the
// ModelProvider interface: discover a merchant, read its live menu, ask
// grounded product questions, build a cart, take a quote, and place the
// order. Payment approval is an explicit shopper action, mirroring the
// hosted approval screen on a real rail.

import type { Message, ModelProvider, ToolCall, ToolDefinition } from "../../providers/model-provider.ts";
import type { MerchantAgent, Order, Quote } from "../merchant/merchant-agent.ts";
import type { BuyerProfile } from "../../demo/seed.ts";

export const BUYER_TOOLS: ToolDefinition[] = [
  {
    name: "discover_merchants",
    description: "Find ClearCart merchant agents near a place.",
    parameters: { type: "object", properties: { near: { type: "string" } }, required: ["near"] },
  },
  {
    name: "get_menu",
    description: "Fetch a merchant agent's live menu with prices and inventory.",
    parameters: { type: "object", properties: { merchant_id: { type: "string" } }, required: ["merchant_id"] },
  },
  {
    name: "ask_merchant",
    description: "Ask the merchant agent a product question, answered only from its menu data.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  {
    name: "add_to_cart",
    description: "Add a menu item to the cart by SKU.",
    parameters: {
      type: "object",
      properties: { sku: { type: "string" }, quantity: { type: "number" } },
      required: ["sku", "quantity"],
    },
  },
  {
    name: "get_quote",
    description: "Get a priced quote with a TTL for the current cart.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "place_order",
    description: "Submit the quoted cart. The merchant runs the compliance gate before any payment session exists.",
    parameters: { type: "object", properties: {} },
  },
];

const MAX_TURNS = 16;

export interface BuyerAgentOptions {
  provider: ModelProvider;
  merchant: MerchantAgent;
  buyer: BuyerProfile;
}

export class BuyerAgent {
  private readonly provider: ModelProvider;
  private readonly merchant: MerchantAgent;
  readonly buyer: BuyerProfile;
  private readonly messages: Message[] = [];
  private cart: Array<{ sku: string; quantity: number }> = [];
  private currentQuote: Quote | null = null;
  lastOrder: Order | null = null;

  constructor(options: BuyerAgentOptions) {
    this.provider = options.provider;
    this.merchant = options.merchant;
    this.buyer = options.buyer;
    this.messages.push({
      role: "system",
      content:
        "You are the ClearCart buyer agent. You shop on behalf of a demo buyer by calling tools: " +
        "discover_merchants, get_menu, ask_merchant, add_to_cart, get_quote, place_order. " +
        "Never invent products, prices, or inventory; use only what tool results return.",
    });
  }

  /** One shopper turn: an instruction or a question. Returns the agent's
   *  final text for the turn. A new non-question instruction starts a
   *  fresh cart, like a shopper starting a new order. */
  async send(instruction: string): Promise<string> {
    if (!instruction.trim().endsWith("?")) {
      this.cart = [];
      this.currentQuote = null;
    }
    this.messages.push({ role: "user", content: instruction });
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const completion = await this.provider.complete(this.messages, BUYER_TOOLS);
      if (completion.kind === "text") {
        this.messages.push({ role: "assistant", content: completion.text });
        return completion.text;
      }
      for (const call of completion.toolCalls) {
        this.messages.push({ role: "assistant", content: `[tool call: ${call.name}]` });
        const result = await this.executeTool(call);
        this.messages.push({ role: "tool", toolName: call.name, content: JSON.stringify(result) });
      }
    }
    throw new Error(`Buyer agent exceeded ${MAX_TURNS} tool turns`);
  }

  /** The shopper approves the hosted payment session for the last order. */
  async confirmPayment(): Promise<Order> {
    if (!this.lastOrder) throw new Error("No order to pay for yet");
    const order = await this.merchant.approvePayment(this.lastOrder.order_id);
    this.lastOrder = order;
    return order;
  }

  private async executeTool(call: ToolCall): Promise<unknown> {
    const args = call.arguments;
    switch (call.name) {
      case "discover_merchants": {
        // The reference implementation ships one demo merchant. A real
        // directory would rank every ClearCart merchant near the shopper.
        void args.near;
        return { merchants: [this.merchant.directoryEntry()] };
      }
      case "get_menu": {
        return { merchant_id: this.merchant.info.id, items: this.merchant.getMenu() };
      }
      case "ask_merchant": {
        return this.merchant.answerQuestion(String(args.question ?? ""));
      }
      case "add_to_cart": {
        const sku = String(args.sku ?? "");
        const quantity = Number(args.quantity ?? 1);
        this.merchant.menuItem(sku); // throws on an invented SKU
        const existing = this.cart.find((l) => l.sku === sku);
        if (existing) existing.quantity += quantity;
        else this.cart.push({ sku, quantity });
        return { sku, quantity, cart: this.cart };
      }
      case "get_quote": {
        this.currentQuote = this.merchant.createQuote(this.cart);
        return this.currentQuote;
      }
      case "place_order": {
        if (!this.currentQuote) throw new Error("place_order called before get_quote");
        const order = await this.merchant.placeOrder({
          quote_id: this.currentQuote.quote_id,
          buyer_id: this.buyer.buyer_id,
        });
        this.lastOrder = order;
        return {
          order_id: order.order_id,
          status: order.status,
          total_usd: order.total_usd,
          gate_decision_id: order.gate_decision_id,
          payment_session_id: order.payment_session_id,
          explanation: order.explanation,
        };
      }
      default:
        throw new Error(`Unknown tool ${call.name}`);
    }
  }
}
