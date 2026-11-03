# ClearCart Protocol Specification (v1, reference implementation)

This document defines the ClearCart message flow and the ClearCart Gate
contract as implemented in this repository. It is written so another team
can implement a compatible buyer agent, merchant agent, or gate client
without reading the code. The gate's HTTP contract is also published as
an OpenAPI document (`docs/openapi.yaml`).

## Actors

- **Buyer agent.** Represents a shopper. Holds a buyer profile whose
  verification is an attestation ID the gate can resolve.
- **Merchant agent.** Represents one merchant. Serves a live menu, answers
  product questions grounded only in that menu, issues quotes, calls the
  gate, creates payment sessions, and issues pickup codes.
- **ClearCart Gate.** A standalone service. Deterministic rules engine; no
  language model in the decision path. Holds the trusted state: buyer
  attestations, purchase history, merchant catalogs, and policies.
- **Payment rail.** Merchant-scoped payment provider behind a handoff
  interface: hosted approval session plus webhook confirmation. A rail
  must refuse to open a session without a valid gate receipt (see
  Payment enforcement). This repository ships a sandbox stub only.

## Message flow

1. **Discover.** Buyer agent queries a merchant directory and connects to
   a merchant agent.
2. **Menu.** Merchant agent returns its live menu: SKUs, categories,
   prices, and inventory. (Compliance attributes are not taken from the
   menu or the caller; the gate resolves them from its own catalog.)
3. **Q&A.** Buyer agent asks product questions. The merchant agent answers
   only from structured menu data.
4. **Quote.** Merchant agent prices the cart and returns a quote with an
   ID and a TTL. Numbers come from the quote object, never from a model.
5. **Gate check.** Merchant agent calls `POST /v1/gate/check` with the
   merchant ID, the buyer's attestation ID, and the cart's SKUs and
   quantities. The gate resolves verification status, purchase history,
   and product attributes from its own store and catalogs. No payment
   session exists before this step completes, and an APPROVE decision
   reserves the cart totals in the gate's ledger immediately.
6. **Payment handoff (APPROVE only).** Merchant agent presents the gate
   receipt to the rail; the rail verifies it (signature, decision,
   expiry, merchant, cart hash, single use) and only then creates a
   session; the buyer approves the hosted session; the rail confirms by
   webhook. Duplicate webhook deliveries are idempotent.
7. **Fulfillment.** On confirmation the order becomes READY_FOR_PICKUP and
   the merchant issues a pickup code.

Any external agent may skip the flow and call the gate directly at step 5.

## Order states

```
QUOTED -> GATE_APPROVED -> PAYMENT_PENDING -> PAID -> READY_FOR_PICKUP
QUOTED -> GATE_DENIED          (gate returned DENY; no payment session exists)
QUOTED -> GATE_REVIEW          (gate returned REVIEW; a human operator decides)
```

## Buyer attestation

Verification is represented by an attestation record held by the gate,
never by raw identity documents and never by flags in a request:

```json
{
  "attestation_id": "att_demo_7f3a",
  "age_verified": true,
  "id_verified": true,
  "issued_at": "2026-11-03T09:00:00Z",
  "verification_method": "demo_stub"
}
```

A check request carries only the `attestation_id`. The gate resolves the
record from its trusted store; an ID it does not hold fails both
verification checks. In production, licensed verification providers write
these records. In this reference implementation the store is seeded with
synthetic records, and a clearly labeled demo stub
(`POST /v1/gate/attestations/demo`) can mint new ones. The stub verifies
nothing about any real person.

Purchase history likewise lives at the gate, keyed by attestation, seeded
for the demo and extended by the gate itself: every APPROVE reserves its
totals at decision time, so concurrent carts cannot both pass over a
limit.

## Gate contract

Base: HTTPS + JSON. Demo auth: `x-gate-key` header when the service is
configured with a key (demo-grade only).

### POST /v1/gate/check

Input. Note what is absent: no verification flags, no product attributes,
no purchase history. The gate ignores any a caller sends.

```json
{
  "jurisdiction": { "country": "US", "state": "IL" },
  "category": "cannabis",
  "merchant_id": "mrc_lakeshore",
  "buyer": { "attestation_id": "att_demo_7f3a" },
  "cart": [
    { "sku": "FLW-001", "quantity": 1 },
    { "sku": "EDB-002", "quantity": 2 }
  ]
}
```

Output is a decision receipt:

```json
{
  "merchant_id": "mrc_lakeshore",
  "decision_id": "dec_20261103_0001",
  "decision": "APPROVE",
  "reasons": [],
  "evaluated": {
    "flower_equivalent_g_total": 10.5,
    "infused_thc_mg_total": 400,
    "limits_applied": { "flower_equivalent_g_per_day": 30, "infused_thc_mg_per_day": 500 }
  },
  "policy_id": "SIMULATED_POLICY_V1",
  "cart_hash": "sha256 hex of the canonical cart lines as resolved from the catalog",
  "receipt_signature": "HMAC-SHA256 hex over the canonical receipt body",
  "issued_at": "2026-11-03T15:00:00Z",
  "expires_at": "2026-11-03T15:05:00Z"
}
```

The evaluated block always shows the totals the decision was computed
from and the limits applied, so a receipt can be re-checked by hand.
`infused_thc_mg_total` counts THC in infused products only; flower
contributes 0 to that metric by design and is limited separately by
`flower_equivalent_g_total`.

Decisions are APPROVE, DENY, or REVIEW. REVIEW means the inputs were
well-formed but a configured rule requires a human operator; it is part of
the contract so real deployments can be honest about it. Denials carry one
or more reason objects:

```json
{ "code": "LIMIT_EXCEEDED", "detail": "...", "limit": 30, "attempted": 38.5 }
```

Reason codes (v1):

| Code | Meaning |
|---|---|
| `AGE_UNVERIFIED` | Attestation unknown to the gate, or age not verified on file |
| `ID_UNVERIFIED` | Attestation unknown to the gate, or identity not verified on file |
| `ATTESTATION_EXPIRED` | Attestation on file is older than the configured freshness window |
| `LIMIT_EXCEEDED` | Cart plus the gate's recorded history exceeds a configured limit |
| `CART_ITEM_UNKNOWN` | A cart SKU is not in the merchant catalog the gate holds; its contents cannot be verified |
| `JURISDICTION_NOT_SERVED` | No configuration exists for the jurisdiction; the gate refuses rather than guessing |
| `CATEGORY_NOT_ENABLED` | The requested category is not enabled for the jurisdiction |

### Receipt binding

`receipt_signature` is HMAC-SHA256 (hex) over the canonical receipt body.
It binds: `merchant_id`, `decision_id`, `decision`, `reasons`,
`evaluated`, `policy_id`, `cart_hash`, `issued_at`, and `expires_at`.
Changing any bound field after issuance invalidates the signature. The
signing key in this reference implementation is a demo shared secret; a
production deployment signs with managed keys held only by the gate.

### POST /v1/gate/receipts/verify

Body: a decision receipt. Returns `{ "valid": true, "errors": [] }` or
`valid: false` with error codes (`SIGNATURE_INVALID`, `RECEIPT_EXPIRED`).
Merchants use this to verify a receipt before acting on it.

### GET /v1/gate/limits?state=IL&category=cannabis

Returns the active limit configuration for a jurisdiction and category,
so any agent can pre-check a cart locally before calling `/check`.
Configurations are data, not code, carry a `policy_id`, and demo
configurations are labeled as simulated parameters.

### POST /v1/gate/attestations/demo

Demo-only stub. Mints a synthetic attestation with chosen verification
flags and registers it in the gate's store so checks can resolve it. It
must never be presented as identity verification.

## Payment enforcement

Opening a payment session requires a gate receipt. A conforming rail
verifies, in order: a receipt is present; it names the merchant being
paid; the signature is valid; the decision is APPROVE; the receipt has
not expired; the cart being paid hashes to `cart_hash`; and the
`decision_id` has not been consumed before. Receipts are single-use:
one approved decision authorizes exactly one payment session. Any
failure rejects session creation with a coded error
(`GATE_RECEIPT_MISSING`, `GATE_MERCHANT_MISMATCH`, `GATE_RECEIPT_FORGED`,
`GATE_DECISION_NOT_APPROVED`, `GATE_RECEIPT_EXPIRED`,
`GATE_CART_MISMATCH`, `GATE_RECEIPT_REPLAYED`).

## Determinism

Decision content is a pure function of (request, configuration, trusted
store state, clock, receipt secret). Given the same five, the receipt is
byte-identical; the test suite pins this property with fresh stores.
State changes are explicit and auditable: the only mutation a check
performs is reserving an approved cart in the ledger.
