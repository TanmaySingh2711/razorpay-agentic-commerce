# 07 — API boundary design

**Nothing here is built.** Objective 1 ships exactly one route,
`GET /api/health`, and no placeholder endpoints. This document fixes the
surface so later objectives do not each invent their own shape.

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

| Route                                    | Method | Owner service        | Request (validated)                                             | Response                                           | Notes                                                                                            |
| ---------------------------------------- | ------ | -------------------- | --------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/health`                            | GET    | —                    | —                                                               | `{ status, service, environment, timestamp }`      | **Built.** Liveness only; discloses no credential state.                                         |
| `/api/intents`                           | POST   | Buyer Agent          | `{ prompt, constraints? }`                                      | `{ transactionId, intent, state }`                 | Creates the transaction at `INTENT_RECEIVED`. The prompt is capped in length.                    |
| `/api/catalog/search`                    | GET    | Catalog              | `?q&maxPriceMinorUnits&category&limit`                          | `{ candidates[] }`                                 | Bounded projection. Budget is expressed in minor units, never a decimal.                         |
| `/api/catalog/products/[productId]`      | GET    | Merchant             | path param                                                      | `{ product }`                                      | Public product view. Price is server-read.                                                       |
| `/api/transactions/[id]/select-product`  | POST   | Product Decision     | `{ }` (server-driven)                                           | `{ selection, decisionRecord, state }`             | Runs the AI proposal. Returns a proposal, not an authorization.                                  |
| `/api/transactions/[id]/verify-product`  | POST   | Merchant             | `{ }`                                                           | `{ verifiedProduct, state }`                       | Re-reads price, currency and stock. Deliberately accepts no amount.                              |
| `/api/transactions/[id]/evaluate-policy` | POST   | Policy Engine        | `{ }`                                                           | `{ decision, ruleApplied, decisionRecord, state }` | Deterministic. Accepts no amount and no policy from the caller.                                  |
| `/api/transactions/[id]/approvals`       | POST   | Approval Gate        | `{ approvalRequestId, decision, acknowledgedAmountMinorUnits }` | `{ state }`                                        | The acknowledged amount must match the verified amount, or the approval is refused.              |
| `/api/transactions/[id]`                 | GET    | Transaction          | path param                                                      | `{ transaction, state, timeline }`                 | Scoped to the requesting user.                                                                   |
| `/api/transactions/[id]/payments`        | POST   | Razorpay Integration | `{ }`                                                           | `{ orderId, keyId, amountMinorUnits, currency }`   | **Amount comes from the authorization, never from the body.** Requires state `AUTHORIZED`.       |
| `/api/transactions/[id]/payments/verify` | POST   | Razorpay Integration | `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }`     | `{ state }`                                        | Signature-checked. A browser-reported success alone never completes a transaction (invariant 9). |
| `/api/webhooks/razorpay`                 | POST   | Webhook Handler      | raw body + signature header                                     | `204`                                              | Public. Verify → parse → dedupe → act. Returns success for duplicates.                           |
| `/api/transactions/[id]/audit`           | GET    | Audit                | path param                                                      | `{ events[] }`                                     | The user-facing timeline. Redacted by construction.                                              |

## What is deliberately absent

- No endpoint accepts an amount, a price, or a state from the caller.
- No endpoint lets a caller write a policy.
- No "admin" or "debug" route that bypasses the policy engine.
- No endpoint returns prompt text, model reasoning, or provider payloads.
