# 07 — API boundary design

**Mostly not built yet.** Objectives 1 and 4 ship the routes marked **Built**
below; everything else is a fixed design so later objectives do not each invent
their own shape.

## Conventions

- App Router Route Handlers under `src/app/api/**/route.ts`.
- A handler does three things and nothing else: validate the request against a
  schema, call **one** service, map the result to a response. No business logic,
  no policy, no persistence.
- Responses are envelopes: `{ data }` on success, `{ error }` on failure, where
  `error` is `AppError.toPublicPayload()` — a stable code, a category, and a
  dull message. Internal messages and causes never cross this boundary.
- Status comes from the error category (see [10](./10-errors-and-logging.md)).
- Mutating routes accept an `Idempotency-Key` header.
- No internal identifiers, table names, provider payloads, prompt text or
  reasoning appear in any response.

## Planned surface

| Route                                      | Method | Owner service              | Request (validated)                                               | Response                                           | Notes                                                                                                                 |
| ------------------------------------------ | ------ | -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/api/health`                              | GET    | —                          | —                                                                 | `{ status, service, environment, timestamp }`      | **Built.** Liveness only; discloses no credential state.                                                              |
| `/api/intents`                             | POST   | Buyer Agent                | `{ prompt, constraints? }`                                        | `{ transactionId, intent, state }`                 | Creates the transaction at `INTENT_RECEIVED`. Prompt length-capped.                                                   |
| `/api/buyer-agent`                         | POST   | Buyer Agent                | `{ message }`                                                     | `{ decision }`                                     | **Built.** Proposes a product. Creates no transaction and no payment. See [19](./19-buyer-agent.md).                  |
| `/api/catalog/merchant`                    | GET    | Catalog                    | —                                                                 | `{ merchant }`                                     | **Built.** Public merchant metadata. No configuration, no credentials.                                                |
| `/api/catalog/products`                    | GET    | Catalog                    | `?category&maxAmountMinor&currency&attribute.*&sort&limit&offset` | `{ product[] }`                                    | **Built.** Deterministic filtering. Budget in minor units, never a decimal. See [18](./18-agent-readable-catalog.md). |
| `/api/catalog/products/[productId]`        | GET    | Catalog                    | path param                                                        | `{ product }`                                      | **Built.** Public product view. Price is server-read; unpublished products 404.                                       |
| `/api/transactions/[id]/select-product`    | POST   | Product Decision           | `{ }` (server-driven)                                             | `{ selection, decisionRecord, state }`             | Runs the AI proposal. Returns a proposal, not an authorization.                                                       |
| `/api/transactions/[id]/verify-product`    | POST   | Merchant                   | `{ }`                                                             | `{ verifiedProduct, state }`                       | Re-reads price, currency and stock. Accepts no amount.                                                                |
| `/api/transactions/[id]/quote`             | POST   | Quote Service              | `{ quantity? }`                                                   | `{ quote, state }`                                 | Freezes the amount. **The response is the only place an amount originates.**                                          |
| `/api/transactions/[id]/evaluate-policy`   | POST   | Policy Engine              | `{ }`                                                             | `{ decision, ruleApplied, decisionRecord, state }` | Deterministic. Accepts no amount and no policy from the caller.                                                       |
| `/api/transactions/[id]/approvals`         | POST   | Approval Gate              | `{ approvalRequestId, decision, acknowledgedAmountMinorUnits }`   | `{ state }`                                        | The acknowledged amount must match the quote, or the approval is refused.                                             |
| `/api/transactions/[id]/reserve-inventory` | POST   | Inventory                  | `{ }`                                                             | `{ reservation, state }`                           | Holds stock before any payment. Requires `AUTHORIZED`.                                                                |
| `/api/transactions/[id]`                   | GET    | Transaction                | path param                                                        | `{ transaction, state, timeline }`                 | Scoped to the requesting user.                                                                                        |
| `/api/transactions/[id]/transitions`       | GET    | Transaction                | path param                                                        | `{ transitions[] }`                                | The state transition history. Read-only, append-only upstream.                                                        |
| `/api/transactions/[id]/payments`          | POST   | Payment Provider Interface | `{ }`                                                             | `{ orderId, keyId, amountMinorUnits, currency }`   | **Amount comes from the quote, never from the body.** Requires `INVENTORY_RESERVED`.                                  |
| `/api/transactions/[id]/payments/verify`   | POST   | Razorpay Adapter           | `{ providerOrderId, providerPaymentId, signature }`               | `{ state }`                                        | Signature-checked server-side. A browser-reported success alone never completes a transaction.                        |
| `/api/webhooks/razorpay`                   | POST   | Webhook Handler            | raw body + signature header                                       | `204`                                              | Public. Verify → parse → dedupe → act. Returns success for duplicates.                                                |
| `/api/transactions/[id]/audit`             | GET    | Audit                      | path param                                                        | `{ events[] }`                                     | The user-facing timeline. Redacted by construction.                                                                   |

## What is deliberately absent

- No endpoint accepts an amount, a price, a stock level or a state from the
  caller. A catalog caller may state a _budget_ — what they are willing to spend
  — never what a product costs. The only amount in a transactional response comes
  from a server-created `PurchaseQuote`; the only amount in a catalog response is
  read from PostgreSQL.
- No endpoint lets a caller write a policy.
- No "admin" or "debug" route that bypasses the policy engine.
- No endpoint returns prompt text, model reasoning, or provider payloads.
- No endpoint exposes a Prisma model, a provider SDK object, or an internal
  table name. Route handlers speak in domain shapes only.
