// Demo data loading and reset.
//
// The demo merchant is Lakeshore Cannabis Club (Romeoville, IL) and the
// menu in demo-data/ is the store's real published catalog (names, sizes,
// THC, prices); inventory counts are demo seed values. The buyers and
// their ledgers are synthetic. Loading always returns a fresh deep copy,
// so calling loadDemoState() is the seed reset: inventory and ledger go
// back to the exact recording state described in DEMO_SCRIPT.md.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MenuItem {
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

export interface LedgerEntry {
  at: string;
  flower_equivalent_g: number;
  infused_thc_mg: number;
  decision_id: string;
}

export interface Attestation {
  attestation_id: string;
  age_verified: boolean;
  id_verified: boolean;
  issued_at: string;
  method: string;
}

export interface BuyerProfile {
  buyer_id: string;
  display_name: string;
  attestation: Attestation;
  /** Narrative mirror of the buyer's seeded history. The system of
   *  record for decisions is the gate's own server-side store
   *  (services/gate/seed/demo-store.json), seeded from this fixture. */
  ledger: LedgerEntry[];
}

export interface MerchantInfo {
  id: string;
  name: string;
  location: string;
}

export interface DemoState {
  merchant: MerchantInfo;
  menu: MenuItem[];
  buyers: BuyerProfile[];
}

export function loadDemoState(dataDir?: string): DemoState {
  const dir = dataDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "demo-data");
  const menuDoc = JSON.parse(readFileSync(join(dir, "menu.json"), "utf8")) as {
    merchant: MerchantInfo;
    menu: MenuItem[];
  };
  const buyersDoc = JSON.parse(readFileSync(join(dir, "buyers.json"), "utf8")) as {
    buyers: BuyerProfile[];
  };
  // Deep copy: callers mutate inventory and ledgers during a run.
  return structuredClone({ merchant: menuDoc.merchant, menu: menuDoc.menu, buyers: buyersDoc.buyers });
}

/** The seed reset: a fresh load is the recording state. */
export function resetDemoState(): DemoState {
  return loadDemoState();
}
