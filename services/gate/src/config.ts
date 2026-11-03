// Loads per-jurisdiction limit configuration files for the gate.
//
// Limits are configuration, never code. Each JSON file in the config
// directory describes one jurisdiction plus category pair, and every demo
// file is labeled as simulated parameters, not law.
//
// Also loads the gate-side merchant catalogs: the authoritative
// compliance attributes per SKU that the gate resolves carts against.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogMap, GateConfig } from "./engine.ts";

export function loadGateConfigs(configDir: string): GateConfig[] {
  const configs: GateConfig[] = [];
  for (const file of readdirSync(configDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(configDir, file), "utf8")) as GateConfig;
    configs.push(parsed);
  }
  return configs;
}

interface CatalogFile {
  merchant_id: string;
  items: Array<{
    sku: string;
    category: string;
    flower_equivalent_g: number;
    unit_thc_mg: number;
  }>;
}

/** Loads one catalog file per merchant into merchant_id -> SKU -> item. */
export function loadCatalogs(catalogDir: string): CatalogMap {
  const catalogs: CatalogMap = new Map();
  for (const file of readdirSync(catalogDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(catalogDir, file), "utf8")) as CatalogFile;
    const bySku = new Map();
    for (const item of parsed.items) {
      bySku.set(item.sku, {
        sku: item.sku,
        category: item.category,
        flower_equivalent_g: item.flower_equivalent_g,
        unit_thc_mg: item.unit_thc_mg,
      });
    }
    catalogs.set(parsed.merchant_id, bySku);
  }
  return catalogs;
}
