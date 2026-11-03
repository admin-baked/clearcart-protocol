// External-client test: the standalone client in examples/ is the
// only code under test here. It shares no code with the gate, the
// agents, or this repository's packages; it speaks only the published
// HTTP contract (docs/openapi.yaml) to a locally started gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateServer } from "../services/gate/src/server.ts";
import type { DecisionReceipt } from "../services/gate/src/engine.ts";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "examples", "external-client", "client.mjs");
const API_KEY = "external-client-key";

test("independent external client runs a gate check against a locally started gate", async (t) => {
  const gate = await startGateServer({ port: 0, apiKey: API_KEY });
  t.after(() => gate.close());

  const { stdout } = await run("node", [CLIENT, "--url", gate.baseUrl, "--key", API_KEY]);
  const receipt = JSON.parse(stdout) as DecisionReceipt;
  assert.equal(receipt.decision, "APPROVE");
  assert.equal(receipt.merchant_id, "mrc_lakeshore");
  assert.equal(receipt.policy_id, "SIMULATED_POLICY_V1");
  assert.equal(receipt.evaluated.flower_equivalent_g_total, 10.5);
  assert.equal(receipt.evaluated.infused_thc_mg_total, 400);
  assert.match(receipt.receipt_signature, /^[0-9a-f]{64}$/);
});
