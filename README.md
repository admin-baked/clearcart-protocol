# ClearCart Protocol + ClearCart Gate

**ClearCart: the agent-to-agent commerce protocol with the compliance gate built in, and a gate any agent can call on its own.**

Built by BakedBot AI for the Meta Global AI Developer Hackathon (Cerebral Valley), Startup track.

> **Reference implementation.** This repository is a hackathon reference implementation. It is not a production system. It moves no money, collects no real identity documents, and contains no real customer data. See [docs/SAFETY.md](docs/SAFETY.md) before reading anything else into it.

## The problem

AI agents are about to do the buying, but age-restricted commerce has no legal way to sell to them. A buyer agent can browse a menu and fill a cart, yet the moment an order involves anything age-restricted, the flow stops, because there is no standard way for the buyer's verification status and the jurisdiction's purchase limits to be checked before money moves.

ClearCart is the missing layer, in two pieces:

1. **ClearCart Protocol.** A documented message flow and reference implementation for agent-to-agent commerce: a buyer agent discovers a merchant agent, reads its live menu, asks questions grounded in that menu, receives a quote, and pays through a compliant payment rail handoff. Every order passes through the compliance gate before a payment session exists.
2. **ClearCart Gate.** A standalone HTTP service with one job: given a buyer attestation ID and a cart of SKUs, answer APPROVE, DENY, or REVIEW with machine-readable reason codes and a signed, auditable decision receipt. Any agent, in any framework, can call it directly. It is not locked inside BakedBot's checkout.

Cannabis is the demo category because it is the hardest test case in retail: 21+ buyers, identity checks, and per-state purchase limits all apply at once. The gate is category-agnostic; the demo also shows it answering a plain API call for alcohol from an agent that is not part of this project.

## Why the gate is a rules engine, not a model

Compliance decisions must be reproducible and auditable, so the gate's decision path contains no language model at all. It is a deterministic rules engine over per-jurisdiction configuration: same inputs, same answer, every time, with a receipt to prove it. Language models (through the Meta Model API, behind the provider interface in `providers/`) do what they are good at in this system: the buyer agent's intent parsing and tool choices, the merchant agent's product answers grounded in menu data, and plain-language explanations of decisions the gate has already made.

## The trust model

The gate is an enforceable boundary, not an advisory check. It resolves everything that matters from its own server-side state, and payment refuses to proceed without its authorization:

- **Attestations live at the gate.** A check request carries only an `attestation_id`. The gate looks the buyer up in its trusted store and reads the verification flags itself. Flags a caller puts in the request are ignored, in both directions. An ID the gate does not hold is denied with `AGE_UNVERIFIED` and `ID_UNVERIFIED`.
- **Purchase history lives at the gate.** The gate keeps the rolling ledger. An APPROVE decision reserves the cart totals in that ledger immediately, inside the same synchronous decision, so two carts that each fit alone cannot both pass over a limit.
- **Cart attributes come from the catalog.** Flower-equivalent grams and per-unit infused THC are resolved from the merchant's authoritative catalog, held gate-side by SKU. Values a caller supplies for its own cart are ignored. A SKU the catalog does not know is denied with `CART_ITEM_UNKNOWN`.
- **Receipts are bound and single-use.** The receipt signature is HMAC-SHA256 over the canonical receipt body, binding the merchant, the decision ID, the decision, a SHA-256 hash of the catalog-resolved cart, the policy ID, and the issue and expiry times. The payment rail verifies all of it before opening a session and consumes the decision ID: a forged, altered, expired, denied, or replayed authorization cannot create a payment session.
- **Merchants verify before acting.** A merchant can ask the gate to verify a receipt (`POST /v1/gate/receipts/verify`) before trusting it; the reference merchant does exactly that.

The signing key in this build is a demo shared secret. Production deployments sign with managed keys held only by the gate; the binding and single-use semantics are what this implementation demonstrates.

## Quickstart

Requirements: Node.js 22.6 or newer. There are no dependencies to install.

```sh
npm test          # gate unit tests + full end-to-end protocol tests
npm run demo      # the four demo beats from DEMO_SCRIPT, live in your terminal
npm run gate      # boot the standalone gate service on port 8787
```

Try the gate the way any external agent would:

```sh
curl -s "http://127.0.0.1:8787/v1/gate/limits?state=IL&category=cannabis" \
  -H "x-gate-key: demo-gate-key"

curl -s -X POST http://127.0.0.1:8787/v1/gate/check \
  -H "content-type: application/json" -H "x-gate-key: demo-gate-key" \
  -d '{"jurisdiction":{"country":"US","state":"IL"},"category":"cannabis",
       "merchant_id":"mrc_demo_prairie",
       "buyer":{"attestation_id":"att_demo_7f3a"},
       "cart":[{"sku":"FLW-001","quantity":1},{"sku":"EDB-002","quantity":2}]}'
```

Note what the request does not contain: no verification flags, no product attributes, no purchase history. The gate resolves all three server-side. The API contract is published as an OpenAPI document at [docs/openapi.yaml](docs/openapi.yaml), and [examples/external-client/](examples/external-client/) is a standalone client that uses nothing from this repository's packages, only that contract.

Auth note: when `GATE_API_KEY` is set, `/v1` routes require a matching `x-gate-key` header. That is demo-grade auth for the reference implementation; production authentication design is out of scope here and is called out as a production requirement in [docs/SAFETY.md](docs/SAFETY.md).

## The demo

`npm run demo` boots the gate, the merchant agent, and the buyer agent, then runs four beats:

1. **Discovery and Q&A.** A buyer agent finds Prairie Test Gardens (a fictional demo dispensary) and asks a product question, answered only from the menu data.
2. **The approved order.** Cart: 1 flower unit plus 2 edibles. The gate approves with evaluated totals on the receipt (10.5 g flower-equivalent against a 30 g demo limit, 400 mg infused THC against a 500 mg demo limit) and the policy ID `SIMULATED_POLICY_V1` printed on the receipt. Only then does a sandbox payment session exist; the buyer approves it and receives pickup code PR-4821.
3. **The blocked order, and the bypass attempt.** A restock cart that would take the buyer to 38.5 g is denied with `LIMIT_EXCEEDED` before any payment session exists. The buyer then tries to skip the gate and ask the payment rail for a session directly; the rail rejects it, because a session requires a valid gate receipt. Nothing to refund, nothing to argue about, no way around.
4. **The gate stands alone.** A plain `curl` call, category alcohol, no BakedBot interface anywhere. The gate answers in the same shape.

The demo runs on the deterministic mock model provider (`providers/mock.ts`), so it is reproducible with zero API access. Set `META_MODEL_API_KEY` and `META_MODEL_ID` (see `.env.example`) to point the agents at the Meta Model API instead; the model ID is configuration, never a code constant, because the IDs available on an account are account specific.

## Demo limits are simulated (SIMULATED_POLICY_V1)

**The demo policy is simulated and is not a statement of Illinois law.** The numbers in `services/gate/config/` (30 g flower-equivalent per day, 500 mg infused THC per day, 24 items per day for alcohol) are **simulated demo parameters**, chosen to make the demo arithmetic clean. Every config carries `policy_id: SIMULATED_POLICY_V1` and `simulated: true`, and every receipt the gate issues is stamped with that policy ID, so no demo decision can be mistaken for a legal determination. This project makes no claim about statutory limits.

## Tests

`npm test` runs the full suite: **29 tests, all passing.** The suite is split by what it proves.

Gate unit tests (15, `services/gate/tests/gate.test.ts`):

- approve: a verified buyer inside the limits is approved with evaluated totals
- deny over limit: cart plus gate-side history past the flower limit is LIMIT_EXCEEDED
- deny unverified buyer: store record without age and ID verification returns both codes
- deny underage: store record with age not verified and ID verified returns AGE_UNVERIFIED only
- deny expired attestation: store record older than the freshness window is ATTESTATION_EXPIRED
- deny unknown attestation: an ID the gate does not hold returns both codes and says so
- caller-supplied verification booleans are ignored: lying about an unverified buyer still denies
- deny unknown SKU: a cart line the catalog cannot resolve is CART_ITEM_UNKNOWN
- server-side ledger: an approval reserves its totals, so the same cart again is denied
- refuse to guess: an unconfigured state is JURISDICTION_NOT_SERVED
- refuse to guess: an unconfigured category in a served state is CATEGORY_NOT_ENABLED
- alcohol standalone: a small verified alcohol cart is approved by item count
- alcohol standalone: past the item cap is LIMIT_EXCEEDED
- determinism: the same input and store state produces a byte-identical decision
- limits lookup: IL cannabis config is exposed for local pre-checks, labeled simulated

Adversarial tests (8, `tests/adversarial.test.ts`):

- forged receipt signature is rejected at payment
- cart altered after gate approval is rejected at payment (hash mismatch)
- reused decision_id is rejected (replay)
- expired receipt is rejected at payment
- payment attempted with no gate decision is rejected
- a DENY receipt cannot authorize payment
- duplicate payment webhook confirm is idempotent
- two concurrent carts that each fit alone cannot both pass over the limit

End-to-end tests (5, `tests/e2e.test.ts`):

- approved order end to end: gate receipt, sandbox payment, pickup code PR-4821
- blocked order end to end: DENY with LIMIT_EXCEEDED and no payment session
- unverified buyer end to end: DENY with AGE_UNVERIFIED and ID_UNVERIFIED
- standalone gate endpoints: limits, attestation demo stub, and API key enforcement
- meta provider stub: refuses to fake a call when unconfigured

External client test (1, `tests/external-client.test.ts`):

- independent external client runs a gate check against a locally started gate

## Repository layout

```
SPEC.md               The protocol: message flow, order states, gate contract
services/gate/        ClearCart Gate: standalone rules-engine service + tests
  config/             Per-jurisdiction policy configs (all labeled simulated)
  catalog/            Gate-side merchant catalogs: authoritative SKU attributes
  seed/               Demo seed for the gate's trusted attestation + ledger store
  src/engine.ts       The deterministic decision path
  src/store.ts        Trusted attestation store and purchase ledger
  src/receipt.ts      Receipt shape, cart hash, HMAC signing and verification
agents/buyer/         Buyer agent (ModelProvider-driven tool calls)
agents/merchant/      Merchant agent (menu, Q&A, quote, gate call, payment, pickup code)
providers/            ModelProvider interface, Meta Model API provider, mock provider
payments/             PaymentRail interface + sandbox handoff stub (receipt enforced)
demo-data/            Fictional Prairie Test Gardens menu and two synthetic buyers
demo/                 One-command demo runner and seed reset
docs/                 Architecture notes, safety boundary, OpenAPI contract
examples/             Standalone external client using only the published API
tests/                End-to-end, adversarial, and external-client tests
```

## Roadmap

- Live Meta Model API verification once project account access is confirmed, then a full dress rehearsal on live models.
- More jurisdiction and category configs, each reviewed against the real rules of that market before use.
- A multimodal budtender with product label scanning as a future merchant-agent capability.
- Production hardening per [docs/SAFETY.md](docs/SAFETY.md): licensed verification providers, counsel-reviewed jurisdictional rules, production authentication, and a licensed payment rail. In BakedBot AI's production model, that rail is CanPay, integrated per merchant with each merchant holding its own account and keys.

## License

Apache-2.0. See [LICENSE](LICENSE). A protocol only matters if other builders can implement it without legal friction; Apache-2.0's express patent grant is deliberate for an industry where payments and regulated retail patents are active.
