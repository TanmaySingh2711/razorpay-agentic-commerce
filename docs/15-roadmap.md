# 15 — Roadmap

Later objectives, ordered so each one lands against a working system and none
requires revisiting the architecture. No feature here is an invention beyond
the Track 01 brief.

| #   | Objective                                                                           | Builds                                                                                                                                                                                                               | Lands in                                                                                | Dependencies it introduces                            |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 2   | **Persistence and merchant catalog** - **DONE (models only; catalog API deferred)** | Prisma schema for every entity in [08](./08-data-model.md) including `PurchaseQuote`, `InventoryReservation` and `TransactionStateTransition`; migrations; seed catalog; agent-readable projection; `/api/catalog/*` | `src/integrations/persistence/`, `src/services/merchant/`                               | Prisma, PostgreSQL, `DATABASE_URL`, `DIRECT_URL`      |
| 3   | **Transaction service** - **DONE**                                                  | Transaction entity writer wrapping `evaluateTransition`, idempotency storage, **transition history writes**                                                                                                          | `src/services/transaction/`                                                             | none                                                  |
| 4   | **Policy / authorization engine**                                                   | `AuthorizationPolicy` evaluation over a quote, `PolicyDecision` and decision records                                                                                                                                 | `src/domain/policy/`                                                                    | none                                                  |
| 5   | **Audit and explainability services**                                               | Append-only audit writer, decision record writer, per-transaction timeline                                                                                                                                           | `src/services/audit/`                                                                   | none                                                  |
| 6   | **AI Provider Adapter, buyer agent and PurchaseQuote**                              | Provider adapter behind an interface, schema-validated intent extraction, quote creation and expiry                                                                                                                  | `src/integrations/llm/`, `src/services/buyer-agent/`, `src/services/quote/` - **built** | `@google/genai`, `GEMINI_API_KEY`                     |
| 7   | **Product decision engine**                                                         | Deterministic pre/post filters around model ranking, selection decision records                                                                                                                                      | `src/services/product-decision/`                                                        | none                                                  |
| 8   | **Human approval gate and inventory reservation**                                   | `ApprovalRequest` flow with expiry; atomic reserve, commit and release                                                                                                                                               | `src/services/approval/`, `src/services/inventory/`                                     | none                                                  |
| 9   | **Payment provider interface and Razorpay adapter**                                 | Order creation, Checkout, server-side signature verification, `PaymentAttempt`                                                                                                                                       | `src/integrations/payment/`, `src/integrations/payment/razorpay/`                       | Razorpay SDK or `fetch`, the three Razorpay variables |
| 10  | **Webhooks and reconciliation**                                                     | Webhook route, HMAC verification, `WebhookEvent` dedupe, out-of-order reconciliation                                                                                                                                 | `src/app/api/webhooks/razorpay/`, `src/services/webhook/`                               | `RAZORPAY_WEBHOOK_SECRET`                             |
| 11  | **Failure paths**                                                                   | Declined payment, verification mismatch, policy denial, approval expiry, quote expiry, reservation release — each ending in a clean audited state                                                                    | across services                                                                         | none                                                  |
| 12  | **Demo UI**                                                                         | Buyer chat, product view, approval prompt, audit timeline, transition history                                                                                                                                        | `src/app/`, `src/components/`                                                           | none                                                  |

## Sequencing rationale

Persistence comes first because almost everything else needs a source of truth,
and the merchant catalog is the thing the whole demo is _about_. The transaction
service and policy engine follow so that the deterministic half of the system is
complete and tested **before** any model is connected — when the agent arrives
at objective 6, every control it could try to bypass already exists and already
refuses.

Razorpay lands late for the same reason: by then the authorized amount it
receives has already been verified, policy-checked and, where required,
human-approved.

## Constraints every later objective inherits

1. **No LLM output may directly cause a payment.** If a change would let a model
   response reach a payment call without crossing schema validation, server-side
   verification and deterministic authorization, the change is wrong.
2. **Money stays integer minor units with an explicit currency.** No decimal,
   float or `numeric` column; no amount without its currency.
3. **`process.env` is read only in `src/config/env.ts`.**
4. **AI actors keep exactly one edge in the transition table.** A test enforces
   this; do not edit it to make a feature fit.
5. **Audit and operational logs stay separate systems.**
6. **New provider integrations go behind an adapter** that returns domain
   shapes, never raw provider objects.
7. **Razorpay behaviour is verified against current documentation** when
   implemented — the assumptions flagged in [02](./02-architecture.md) and
   [06](./06-security-and-trust-boundaries.md) as _to be verified during the
   Razorpay integration objective_ must be checked, not inherited.
8. **A new module means a new folder with a real file in it**, in the home named
   by [13](./13-repository-structure.md). No placeholder directories.
9. **PostgreSQL everywhere.** No SQLite tier, no "migrate later" plan. Tests run
   on PostgreSQL too.
10. **Money stays BIGINT minor units + explicit currency.** Cross the bigint
    boundary only through `moneyFromBigInt` / `moneyToBigInt`; serialise through
    `MoneyDto`, never a JSON number.
11. **Every foreign key stays `ON DELETE RESTRICT`.** Financial history is not
    deletable by deleting a parent.
12. **No module assigns `Transaction.status` directly.** Emit a domain event
    through `applyTransactionEvent`; the state machine decides the next state.
13. **The Prisma enums stay bound to the domain lists** - `enum-parity.test.ts`
    fails the build on drift.
14. **The domain core names no vendor.** Gemini stays inside the AI Provider
    Adapter; Razorpay stays inside the Razorpay adapter. A test enforces this
    for the state machine's actors.
15. **Node.js 24 LTS.** Keep `engines` and `.nvmrc` in step.
16. **This stays a modular monolith.** Do not split it into services.
