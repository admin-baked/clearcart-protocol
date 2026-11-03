# Safety boundary

This repository is a **reference implementation** built for a hackathon
demo. Read this page before deploying, extending, or describing it.

## What this build is not

- **Not a production system.** It has not been hardened, load tested, or
  reviewed for production use, and it must not be connected to real
  commerce.
- **No real transactions.** The payment rail is a stub. No money moves,
  no card or bank details are collected, and no real payment credentials
  appear anywhere in the repo. `.env.example` ships placeholders only.
- **No real identity verification.** Buyer verification is represented by
  synthetic attestations minted by a demo stub
  (`POST /v1/gate/attestations/demo`). No driver's license, passport,
  photo, date of birth, or any other real personal data is requested,
  stored, or shown. The stub verifies nothing about any real person and
  must never be presented as identity verification.
- **No real customer data.** The merchant (Prairie Test Gardens), the
  menu, the buyers, and the ledger are fictional and were generated for
  this project. No real dispensary's name, menu, pricing, or sales data
  appears anywhere in this repository.
- **No legal determinations.** The gate evaluates demo rules against demo
  data. It decides nothing about real-world legality. The per-state
  numbers in `services/gate/config/` are simulated demo parameters,
  labeled as such in the files, chosen to make the demo arithmetic clean.
  Every policy carries `policy_id: SIMULATED_POLICY_V1` and
  `simulated: true`, and every receipt is stamped with that policy ID.
  They are not statements of any jurisdiction's law.
- **The trusted store is demo data too.** The gate resolves attestations
  and purchase history from its own server-side store because that is
  the architecture being demonstrated. In this build that store is
  seeded with synthetic records (`services/gate/seed/demo-store.json`)
  and topped up by the demo minting stub. The records are fictional;
  the resolution path is real.
- **Receipt cryptography is demo-grade.** Receipts are signed with
  HMAC-SHA256 and the binding (merchant, decision, cart hash, policy,
  expiry) and single-use enforcement are genuinely implemented and
  tested. The key, however, is a shared demo secret from the
  environment, not a managed signing key, so the signatures prove the
  design, not a production key-management story.

## What a real deployment requires

None of the following are features of this build; they are prerequisites
for taking the protocol live, listed so nobody mistakes the demo for the
destination:

1. **Licensed verification providers** issuing attestations, replacing
   the demo stub.
2. **Counsel-reviewed jurisdictional rules** encoded as limit
   configurations, per market and category, with a maintenance process
   as rules change.
3. **Production authentication and authorization** for gate and merchant
   endpoints. The demo's `x-gate-key` header check is a placeholder.
4. **A licensed payment rail** integrated per merchant, with each
   merchant holding its own account and credentials, plus production
   webhook signature verification and managed signing keys for gate
   receipts. The demo implements receipt verification and single-use
   enforcement, but with a shared demo secret and a stub rail; the
   production key management and rail are still to build.
5. **Operational controls**: audit log retention, monitoring, incident
   response, and data protection appropriate to regulated retail.

## Framing

The demo's compliance story is a system refusing sales that fail checks:
under-verified buyers and over-limit carts are denied before payment, in
the open, with reasons. Nothing in this project encourages or enables
evading any check, and the gate's default for anything unconfigured is
to refuse rather than guess.
