// The gate's trusted server-side store: buyer attestations and the
// purchase ledger.
//
// This is the trust boundary the review demanded. The gate never accepts
// a caller's word for who is verified or what they already bought:
//
// - Attestations are resolved by the gate itself, from this store, by
//   attestation_id. A caller-supplied age_verified or id_verified flag
//   in a check request is ignored, in both directions.
// - Purchase history lives here too, keyed by attestation. When the
//   gate approves a check it reserves the cart totals in the ledger
//   immediately, inside the same synchronous decision, so two carts
//   that each fit alone cannot both pass together over a limit.
//
// The store is in-memory and seeded with synthetic demo records. A
// production deployment replaces it with a durable store fed by
// licensed verification providers; the interface is the contract.

import { readFileSync } from "node:fs";

export interface AttestationRecord {
  attestation_id: string;
  age_verified: boolean;
  id_verified: boolean;
  /** ISO timestamp of when the verification was issued. */
  issued_at: string;
  method: string;
}

export class AttestationStore {
  private readonly records = new Map<string, AttestationRecord>();

  constructor(records: AttestationRecord[] = []) {
    for (const r of records) this.records.set(r.attestation_id, { ...r });
  }

  resolve(attestation_id: string): AttestationRecord | undefined {
    const found = this.records.get(attestation_id);
    return found ? { ...found } : undefined;
  }

  /** Registers an attestation so the gate can resolve it later. Used by
   *  the demo minting stub; in production, licensed providers write
   *  here after verifying a real buyer. */
  register(record: AttestationRecord): void {
    this.records.set(record.attestation_id, { ...record });
  }
}

export interface LedgerEntry {
  flower_equivalent_g: number;
  infused_thc_mg: number;
  items: number;
}

export interface LedgerTotals {
  flower_equivalent_g: number;
  infused_thc_mg: number;
  items: number;
}

const ZERO: LedgerTotals = { flower_equivalent_g: 0, infused_thc_mg: 0, items: 0 };

export class PurchaseLedger {
  private readonly entries = new Map<string, LedgerEntry[]>();

  constructor(seed: Record<string, LedgerEntry[]> = {}) {
    for (const [id, list] of Object.entries(seed)) {
      this.entries.set(id, list.map((e) => ({ ...e })));
    }
  }

  /** Rolling totals the gate has on record for one attestation: seeded
   *  history plus every reservation this gate has made. */
  totalsFor(attestation_id: string): LedgerTotals {
    const totals = { ...ZERO };
    for (const e of this.entries.get(attestation_id) ?? []) {
      totals.flower_equivalent_g += e.flower_equivalent_g;
      totals.infused_thc_mg += e.infused_thc_mg;
      totals.items += e.items;
    }
    return totals;
  }

  /** Records an approved cart against the buyer, effective immediately.
   *  Called synchronously inside the decision, before the receipt is
   *  issued, so the reservation is atomic with the approval in this
   *  single-process store. */
  reserve(attestation_id: string, entry: LedgerEntry): void {
    const list = this.entries.get(attestation_id) ?? [];
    list.push({ ...entry });
    this.entries.set(attestation_id, list);
  }
}

export interface DemoStoreSeed {
  attestations: AttestationRecord[];
  purchases: Record<string, LedgerEntry[]>;
}

export function loadDemoStoreSeed(seedPath: string): DemoStoreSeed {
  const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as DemoStoreSeed;
  return {
    attestations: parsed.attestations ?? [],
    purchases: parsed.purchases ?? {},
  };
}

export function createAttestationStore(seed: DemoStoreSeed): AttestationStore {
  return new AttestationStore(seed.attestations);
}

export function createPurchaseLedger(seed: DemoStoreSeed): PurchaseLedger {
  return new PurchaseLedger(seed.purchases);
}
