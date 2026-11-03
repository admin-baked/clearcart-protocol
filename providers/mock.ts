// MockProvider: a deterministic stand-in for a live language model.
//
// It implements the exact ModelProvider interface the agents use with a
// real model, including tool calls, so the full demo runs end to end with
// zero API access. Its "choices" are a small deterministic policy over the
// conversation: it reads the shopper's instruction, the tool results so
// far, and (for merchant answers) the menu JSON it was given, and it never
// invents facts outside those inputs. A live model makes these choices
// itself; the mock makes them by rule so the recorded demo is reproducible.
//
// Three conversation shapes are recognized by their system prompt:
//   buyer agent session      "You are the ClearCart buyer agent"
//   merchant product Q&A     "You are the ClearCart merchant agent"
//   gate denial explanation  "You are the ClearCart explanation assistant"

import type { Completion, Message, ModelProvider, ToolCall, ToolDefinition } from "./model-provider.ts";

interface MenuItemLike {
  sku: string;
  name: string;
  category: string;
  size_g: number;
  flower_equivalent_g: number;
  thc_mg: number;
  thc_percent: number;
  price_usd: number;
  inventory: number;
  description: string;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Menu names are brand-prefixed ("Cresco Lemon Bean") and used whole;
 *  a "Category: Name" prefix, if one ever appears, is stripped. */
function shortName(name: string): string {
  const parts = name.split(":");
  return parts[parts.length - 1].trim();
}

function toolResults(messages: Message[], name?: string): Message[] {
  return messages.filter((m) => m.role === "tool" && (name === undefined || m.toolName === name));
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Finds the menu wherever the session carries it: a get_menu tool result
 *  in this conversation, or the session-context system note. */
function extractMenu(messages: Message[]): MenuItemLike[] | null {
  const menuResults = toolResults(messages, "get_menu");
  for (const r of menuResults) {
    const parsed = parseJson<{ items?: MenuItemLike[] }>(r.content);
    if (parsed?.items) return parsed.items;
  }
  for (const m of messages) {
    const marker = "MENU_JSON:";
    const idx = m.content.indexOf(marker);
    if (idx >= 0) {
      const parsed = parseJson<MenuItemLike[]>(m.content.slice(idx + marker.length).trim());
      if (parsed) return parsed;
    }
  }
  return null;
}

/** Parses "1 Cresco Lemon Bean and 2 x RYTHM Animal Face" style
 *  instructions into concrete cart intents, matched against the menu. */
function parseDesiredItems(instruction: string, menu: MenuItemLike[]): Array<{ sku: string; quantity: number }> {
  const text = instruction.toLowerCase();
  const desired: Array<{ sku: string; quantity: number }> = [];
  for (const item of menu) {
    const short = escapeRegExp(shortName(item.name).toLowerCase());
    const digitQty = new RegExp(`(\\d+)\\s*(?:x|\\u00d7)?\\s*(?:of\\s+)?${short}`).exec(text);
    if (digitQty) {
      desired.push({ sku: item.sku, quantity: Number(digitQty[1]) });
      continue;
    }
    const wordQty = new RegExp(`(${Object.keys(WORD_NUMBERS).join("|")})\\s+${short}`).exec(text);
    if (wordQty) {
      desired.push({ sku: item.sku, quantity: WORD_NUMBERS[wordQty[1]] });
      continue;
    }
    if (text.includes(shortName(item.name).toLowerCase())) {
      desired.push({ sku: item.sku, quantity: 1 });
    }
  }
  return desired;
}

export class MockProvider implements ModelProvider {
  readonly name = "mock";
  private callSeq = 0;

  async complete(messages: Message[], _tools: ToolDefinition[] = []): Promise<Completion> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (system.startsWith("You are the ClearCart buyer agent")) {
      return this.buyerTurn(messages);
    }
    if (system.startsWith("You are the ClearCart merchant agent")) {
      return this.merchantAnswer(messages);
    }
    if (system.startsWith("You are the ClearCart explanation assistant")) {
      return this.explain(messages);
    }
    return { kind: "text", text: "Mock provider: no scripted response for this conversation shape." };
  }

  private call(name: string, args: Record<string, unknown>): Completion {
    this.callSeq += 1;
    const toolCall: ToolCall = { id: `mock_call_${this.callSeq}`, name, arguments: args };
    return { kind: "tool_calls", toolCalls: [toolCall] };
  }

  // ----- Buyer agent policy -------------------------------------------------

  private buyerTurn(messages: Message[]): Completion {
    let lastUserIdx = -1;
    messages.forEach((m, i) => {
      if (m.role === "user") lastUserIdx = i;
    });
    const instruction = lastUserIdx >= 0 ? messages[lastUserIdx].content : "";
    const turn = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
    const turnToolNames = toolResults(turn).map((m) => m.toolName);
    const allToolNames = toolResults(messages).map((m) => m.toolName);

    // A question turn: ask the merchant, then relay its grounded answer.
    if (instruction.trim().endsWith("?")) {
      if (!turnToolNames.includes("ask_merchant")) {
        return this.call("ask_merchant", { question: instruction });
      }
      const result = toolResults(turn, "ask_merchant").pop();
      const parsed = result ? parseJson<{ answer?: string }>(result.content) : null;
      return { kind: "text", text: parsed?.answer ?? "The merchant did not answer." };
    }

    // Discovery, once per session.
    if (!allToolNames.includes("discover_merchants")) {
      const nearMatch = /near\s+([A-Za-z ]+?)(,| with| and|$)/i.exec(instruction);
      return this.call("discover_merchants", { near: nearMatch ? nearMatch[1].trim() : "Romeoville" });
    }
    if (!allToolNames.includes("get_menu")) {
      const discovery = toolResults(messages, "discover_merchants").pop();
      const parsed = discovery
        ? parseJson<{ merchants?: Array<{ id: string }> }>(discovery.content)
        : null;
      const merchantId = parsed?.merchants?.[0]?.id ?? "mrc_lakeshore";
      return this.call("get_menu", { merchant_id: merchantId });
    }

    const menu = extractMenu(messages);
    if (!menu) {
      return { kind: "text", text: "I could not load a menu to shop from." };
    }
    const desired = parseDesiredItems(instruction, menu);

    // Discovery-only turn: summarize what was found, grounded in the menu.
    if (desired.length === 0) {
      const discovery = toolResults(messages, "discover_merchants").pop();
      const parsed = discovery
        ? parseJson<{ merchants?: Array<{ name: string }> }>(discovery.content)
        : null;
      const merchantName = parsed?.merchants?.[0]?.name ?? "the merchant";
      const citrus = menu.find(
        (i) => i.inventory > 0 && `${i.name} ${i.description}`.toLowerCase().includes("citrus"),
      );
      const citrusLine = citrus
        ? ` A citrus-forward pick under $100: ${citrus.name}, ${citrus.size_g} g for $${citrus.price_usd}.`
        : "";
      return {
        kind: "text",
        text: `Found ${merchantName}. Its live menu has ${menu.length} items with prices and inventory.${citrusLine}`,
      };
    }

    // Cart building: add each desired item not yet added this turn.
    const addedSkus = toolResults(turn, "add_to_cart").map((r) => parseJson<{ sku?: string }>(r.content)?.sku);
    const next = desired.find((d) => !addedSkus.includes(d.sku));
    if (next) {
      return this.call("add_to_cart", { sku: next.sku, quantity: next.quantity });
    }
    if (!turnToolNames.includes("get_quote")) {
      return this.call("get_quote", {});
    }
    if (!turnToolNames.includes("place_order")) {
      return this.call("place_order", {});
    }

    // Final summary, phrased from the order object. Numbers come from the
    // order, never from the mock.
    const orderResult = toolResults(turn, "place_order").pop();
    const order = orderResult
      ? parseJson<{
          order_id?: string;
          status?: string;
          total_usd?: number;
          payment_session_id?: string;
          explanation?: string;
        }>(orderResult.content)
      : null;
    if (!order) return { kind: "text", text: "The order did not complete." };
    if (order.status === "GATE_DENIED") {
      return { kind: "text", text: order.explanation ?? "The gate denied this order." };
    }
    return {
      kind: "text",
      text:
        `Order ${order.order_id} is placed and the gate approved it. ` +
        `Total $${(order.total_usd ?? 0).toFixed(2)}. ` +
        `Payment session ${order.payment_session_id} is open on the sandbox rail, waiting for the buyer to approve it.`,
    };
  }

  // ----- Merchant Q&A policy --------------------------------------------------

  private merchantAnswer(messages: Message[]): Completion {
    const menu = extractMenu(messages);
    const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (!menu) {
      return { kind: "text", text: "I do not have menu data to answer from." };
    }
    const item = menu.find((i) =>
      question.toLowerCase().includes(shortName(i.name).toLowerCase()),
    );
    if (!item) {
      const names = menu.map((i) => i.name).join("; ");
      return {
        kind: "text",
        text: `That item is not on the Lakeshore Cannabis Club menu, so I cannot describe it. On the menu: ${names}.`,
      };
    }
    const potency =
      item.category === "flower"
        ? `${item.thc_percent}% THC`
        : `${item.thc_mg} mg THC per unit`;
    const stock = item.inventory > 0 ? `${item.inventory} in stock` : "currently out of stock";
    return {
      kind: "text",
      text:
        `${item.name} is ${item.size_g} g at $${item.price_usd}, ${potency}, ${stock}. ` +
        `From the menu: ${item.description}`,
    };
  }

  // ----- Gate denial explanation policy ---------------------------------------

  private explain(messages: Message[]): Completion {
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const marker = "DECISION_JSON:";
    const idx = user.indexOf(marker);
    const decision = idx >= 0
      ? parseJson<{ reasons?: Array<{ code: string; detail: string }> }>(user.slice(idx + marker.length).trim())
      : null;
    if (!decision?.reasons?.length) {
      return { kind: "text", text: "This order cannot proceed." };
    }
    const sentences = decision.reasons.map((r) => {
      if (r.code === "LIMIT_EXCEEDED" && r.detail.includes("flower-equivalent")) {
        return "This order would put you over your daily purchase limit for Illinois. Try removing items, or come back tomorrow.";
      }
      if (r.code === "LIMIT_EXCEEDED" && r.detail.includes("infused THC")) {
        return "This order would put you over your daily THC limit for Illinois. Try removing items, or come back tomorrow.";
      }
      if (r.code === "LIMIT_EXCEEDED") {
        return "This order would put you over your daily purchase limit. Try removing items, or come back tomorrow.";
      }
      if (r.code === "AGE_UNVERIFIED") {
        return "We could not confirm that the buyer is verified as 21 or older, so this order cannot proceed.";
      }
      if (r.code === "ID_UNVERIFIED") {
        return "We could not confirm the buyer's identity verification, so this order cannot proceed.";
      }
      if (r.code === "ATTESTATION_EXPIRED") {
        return "The buyer's verification has expired and needs to be renewed before ordering.";
      }
      return `The gate returned ${r.code}: ${r.detail}`;
    });
    return { kind: "text", text: [...new Set(sentences)].join(" ") };
  }
}
