# Architecture

```
Buyer Agent  --(1. discover, menu, Q&A, quote)-->  Merchant Agent
Merchant Agent --(2. POST /v1/gate/check)-->  ClearCart Gate (standalone service)
Merchant Agent --(3. create payment session)-->  Payment Rail Stub (sandbox)
Payment Rail Stub --(4. webhook: payment confirmed)-->  Merchant Agent
Merchant Agent --(5. order confirmed + pickup code)-->  Buyer Agent
Any external agent --(direct HTTPS call)-->  ClearCart Gate
```

## Components

**Buyer agent** (`agents/buyer/`). A tool-calling loop over the
ModelProvider interface. Tools: `discover_merchants`, `get_menu`,
`ask_merchant`, `add_to_cart`, `get_quote`, `place_order`. The buyer
holds the demo attestation and ledger for its shopper profile. Payment
approval is an explicit method call, mirroring a shopper approving a
hosted payment screen, rather than something the model decides silently.

**Merchant agent** (`agents/merchant/`). Serves the menu from structured
demo data, answers questions through the ModelProvider with the menu as
the only context, issues TTL quotes, and builds the gate request from
nothing but the buyer's attestation ID and the cart's SKUs: verification
status, purchase history, and product attributes are the gate's to
resolve, not the merchant's to claim. It honors the gate receipt exactly:
on APPROVE it first asks the gate to verify the receipt, then presents
the receipt to the rail; DENY returns a plain-language explanation with
no session created; REVIEW parks the order for a human. Webhook handling
is idempotent: a duplicate confirmation for a fulfilled order is a
no-op. On confirmation it issues the pickup code.

**ClearCart Gate** (`services/gate/`). Layers with strict separation:

- `src/engine.ts`: the deterministic rules engine. No I/O, no model,
  injectable clock and receipt secret. All decision logic lives here
  and nowhere else.
- `src/store.ts`: the trusted server-side state: the attestation store
  (verification records resolved by ID) and the purchase ledger
  (rolling history, reserved into at approval time). Seeded from
  `seed/demo-store.json` with synthetic records.
- `src/receipt.ts`: the receipt shape, the canonical cart hash, and
  HMAC-SHA256 signing and verification over the bound fields.
- `src/config.ts`: loads per-jurisdiction JSON policy configs from
  `config/` and per-merchant catalogs from `catalog/`. Policies and
  catalogs are data; adding a state, category, or merchant is adding a
  file.
- `src/server.ts`: a zero-dependency Node HTTP service exposing
  `/v1/gate/check`, `/v1/gate/limits`, `/v1/gate/receipts/verify`, and
  the demo attestation stub, with optional demo-grade `x-gate-key`
  auth.
- `src/client.ts`: a thin client so the merchant agent (and the tests)
  talk to the gate over real HTTP, exactly as an external agent would.

**Model providers** (`providers/`). `model-provider.ts` is the only LLM
seam. `mock.ts` is a deterministic policy implementation used for
development, tests, and the recorded demo. `meta.ts` calls the Meta
Model API with key and model ID read from the environment; it throws a
clear not-configured error rather than faking a response when unset.

**Payments** (`payments/`). `rail.ts` defines the handoff interface
(session, buyer approval, webhook). `stub-rail.ts` is the sandbox
implementation, and it enforces the gate boundary: `createSession`
requires a gate receipt and verifies its signature, decision, expiry,
merchant, and cart hash, and consumes the decision ID so a receipt
authorizes exactly one session. It also keeps deterministic pickup
codes (first confirmed demo order: PR-4821) and a session counter the
demo uses to prove denied orders never create sessions.

**Independent client** (`examples/external-client/`). A standalone
script using plain fetch and zero imports from this repository. It
speaks only the published contract in `docs/openapi.yaml`, and an
end-to-end test runs it against a locally started gate. That is the
interop evidence: the gate is usable by code that shares nothing with
this codebase.

**Demo data and runner** (`demo-data/`, `demo/`). Lakeshore Cannabis
Club's real published menu (14 items, from the store's live Jane menu)
and two synthetic buyers: Buyer A, fully verified with 7.0 g and 200 mg
of synthetic prior purchases today, and Buyer B, unverified.
`demo/seed.ts` returns a fresh deep copy per load, which is the seed
reset. `demo/run-demo.ts` boots the gate on an ephemeral port and runs
the four script beats with self-checks.

## Design decisions worth noticing

- **Gate before payment, always.** The order state machine has no path
  from QUOTED to PAYMENT_PENDING that skips the gate receipt, and the
  rail itself re-verifies that receipt before opening a session.
  Denied, forged, altered, expired, or replayed authorizations all
  fail at the rail. Denied orders have nothing to refund because
  nothing was charged.
- **Trust lives server-side.** The request carries an attestation ID
  and SKUs, nothing more. Verification records, purchase history, and
  product attributes are resolved by the gate from its own store and
  catalogs, so a caller cannot talk the gate into anything by
  supplying friendlier inputs. Decision content stays deterministic:
  a pure function of request, configuration, store state, clock, and
  receipt secret, with approval-time ledger reservation as the one
  explicit state change.
- **Models explain, rules decide.** The only model call downstream of a
  gate decision is the denial explanation, and it receives the decision
  as fixed input. If that call fails, the merchant falls back to the
  reason codes' own text.
- **Numbers never come from a model.** Prices, totals, and evaluated
  limit arithmetic are computed by code from structured data. Models
  phrase; code counts.
