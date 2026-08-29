# 15 — Roadmap

Later objectives, ordered so each one lands against a working system and none
requires revisiting the architecture. No feature here is an invention beyond
the Track 01 brief.

| #   | Objective                                | Builds                                                                                                         | Lands in                                                  | Dependencies it introduces                            |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| 2   | **Persistence and merchant catalog**     | Datastore, product and merchant entities, seed catalog, the agent-readable projection, `/api/catalog/*`        | `src/integrations/persistence/`, `src/services/merchant/` | one datastore/ORM choice, `DATABASE_URL`              |
| 3   | **Transaction service**                  | Transaction entity, the writer that wraps `evaluateTransition`, idempotency storage, transition log            | `src/services/transaction/`                               | none                                                  |
| 4   | **Policy / authorization engine**        | `AuthorizationPolicy` entity, deterministic rule evaluation, `PolicyDecision` and its decision records         | `src/domain/policy/`                                      | none                                                  |
| 5   | **Audit and explainability services**    | Append-only audit writer, decision record writer, the per-transaction timeline                                 | `src/services/audit/`                                     | none                                                  |
| 6   | **LLM provider adapter and buyer agent** | Provider adapter behind an interface, structured intent extraction, schema-validated output                    | `src/integrations/llm/`, `src/services/buyer-agent/`      | Anthropic SDK, `ANTHROPIC_API_KEY`                    |
| 7   | **Product decision engine**              | Deterministic pre/post filters around model ranking, selection decision records                                | `src/services/product-decision/`                          | none                                                  |
| 8   | **Human approval gate**                  | `ApprovalRequest` entity, approval routes, approval UI, expiry                                                 | `src/services/approval/`                                  | none                                                  |
| 9   | **Razorpay integration**                 | Order creation, Checkout, payment signature verification, `PaymentAttempt`                                     | `src/integrations/razorpay/`                              | Razorpay SDK or `fetch`, the three Razorpay variables |
| 10  | **Razorpay webhooks**                    | Webhook route, HMAC verification, `WebhookEvent` dedupe, verified transitions                                  | `src/app/api/webhooks/razorpay/`, `src/services/webhook/` | `RAZORPAY_WEBHOOK_SECRET`                             |
| 11  | **Failure paths**                        | Declined payment, verification mismatch, policy denial, approval expiry — each ending in a clean audited state | across services                                           | none                                                  |
| 12  | **Demo UI**                              | Buyer chat, product view, approval prompt, audit timeline                                                      | `src/app/`, `src/components/`                             | none                                                  |

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
2. **Money stays integer minor units with an explicit currency.** No decimal
   column, no float, no amount without its currency.
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
