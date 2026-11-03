// Minimal HTTP client for the ClearCart Gate, used by the merchant agent
// and the end-to-end tests. Any agent in any framework can do exactly this
// with a plain HTTPS call; this client exists only for convenience.

import type { DecisionReceipt, GateCheckInput, GateConfig } from "./engine.ts";

export interface GateClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface ReceiptVerification {
  valid: boolean;
  errors: string[];
}

export class GateClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options: GateClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["x-gate-key"] = this.apiKey;
    return h;
  }

  async check(input: GateCheckInput): Promise<DecisionReceipt> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/gate/check`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`Gate check failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as DecisionReceipt;
  }

  /** Asks the gate to verify one of its own receipts (signature over the
   *  bound fields, plus expiry). Merchants call this before trusting a
   *  receipt enough to act on it. */
  async verifyReceipt(receipt: DecisionReceipt): Promise<ReceiptVerification> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/gate/receipts/verify`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(receipt),
    });
    if (!res.ok) {
      throw new Error(`Gate receipt verify failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as ReceiptVerification;
  }

  async limits(state: string, category: string): Promise<GateConfig> {
    const url = `${this.baseUrl}/v1/gate/limits?state=${encodeURIComponent(state)}&category=${encodeURIComponent(category)}`;
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Gate limits failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as GateConfig;
  }
}
