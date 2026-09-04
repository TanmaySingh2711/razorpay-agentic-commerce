# 07 — API boundaries

The request surface as it is implemented: HTTP route handlers under
`src/app/api/**/route.ts`, plus the server actions the pages call directly.

## Conventions

- A handler does three things and nothing else: validate the request against a
  schema, call **one** service, map the result to a response. No business logic,
  no policy, no persistence.
- Responses are envelopes: `{ data }` on success, `{ error }` on failure, where
  `error` is `AppError.toPublicPayload()` — a stable code, a category, and a
  dull message. Internal messages and causes never cross this boundary.
- Status comes from the error category (see [10](./10-errors-and-logging.md)).
- **Every mutating JSON request body is a `z.strictObject`.** An unknown key is
  a `400`, not something quietly ignored — the difference matters, because
  "ignored" is indistinguishable from "honoured" to whoever is probing, and a
  loud refusal is what makes the boundary testable. The one endpoint that does
  not parse a JSON body is the Razorpay webhook, which reads the **raw** body so
  its HMAC can be verified over the exact bytes received, before anything in it
  is trusted.
- No internal identifiers, table names, provider payloads, prompt text or
  reasoning appear in any response.

## The implemented surface

| Route                               | Method | Owner service         | Request (validated)                                                                                | Notes                                                                                                      |
| ----------------------------------- | ------ | --------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/api/health`                       | GET    | —                     | —                                                                                                  | Liveness only; discloses no credential state.                                                              |
| `/api/buyer-agent`                  | POST   | Buyer Agent           | `{ message }`                                                                                      | Proposes a product. Creates no transaction and no payment. See [19](./19-buyer-agent.md).                  |
| `/api/catalog/merchant`             | GET    | Catalog               | —                                                                                                  | Public merchant metadata. No configuration, no credentials.                                                |
| `/api/catalog/products`             | GET    | Catalog               | `?category&maxAmountMinor&currency&attribute.*&sort&limit&offset`                                  | Deterministic filtering. Budget in minor units, never a decimal. See [18](./18-agent-readable-catalog.md). |
| `/api/catalog/products/[productId]` | GET    | Catalog               | path param                                                                                         | Public product view. Price is server-read; unpublished products 404.                                       |
| `/api/payments/order`               | POST   | Payment Order Service | `{ transactionId, operationId? }`                                                                  | Creates the Razorpay order. **The amount comes from the persisted quote, never the body.**                 |
| `/api/payments/checkout`            | POST   | Checkout Service      | `{ transactionId }`                                                                                | Starts a checkout session and records that payment began.                                                  |
| `/api/payments/callback`            | POST   | Checkout Service      | `{ transactionId, paymentAttemptId?, razorpay_payment_id, razorpay_order_id, razorpay_signature }` | Signature verified server-side against the **server-stored** order id. Verified ≠ captured.                |
| `/api/payments/retry`               | POST   | Retry Service         | `{ transactionId }`                                                                                | Bounded, human-triggered retry. See [27](./27-payment-retry.md).                                           |
| `/api/payments/dismissed`           | POST   | Checkout Service      | `{ transactionId }`                                                                                | Records that the checkout window was closed. Decides nothing.                                              |
| `/api/webhooks/razorpay`            | POST   | Webhook Service       | raw body + signature header                                                                        | Public. Verify → parse → dedupe → act. Duplicates are recorded and change nothing.                         |

## Server actions

The buyer-facing pages call server actions in `src/app/actions/purchase.ts`
rather than fetching their own API routes. The security property is the same and
worth stating explicitly: **a server action is a function the browser may
_invoke_, not one the browser may _define_.** Their complete parameter surface
is a sentence and a transaction id — there is deliberately nowhere to put an
amount, a currency, a product id, a policy result, an approval verdict or a
retry count.

A different UI calling these actions in a different order cannot reach a state
the server would not otherwise allow, because the gate in every service is the
transaction's own persisted state.

## What is deliberately absent

- **No endpoint accepts an amount, a price, a stock level or a state from the
  caller.** A catalog caller may state a _budget_ — what they are willing to
  spend — never what a product costs. The only amount in a transactional
  response comes from a server-created `PurchaseQuote`; the only amount in a
  catalog response is read from PostgreSQL.
- No endpoint accepts a retry count or a retry limit. `retryCount: 0`,
  `retryLimit: 999`, `approved: true` and `policy: "ALLOWED"` are all unknown
  keys and are all refused **by name**. Attempts are counted from
  `payment_attempt` rows.
- No endpoint lets a caller write a policy.
- No "admin" or "debug" route that bypasses the policy engine.
- No endpoint returns prompt text, model reasoning, or provider payloads.
- No endpoint exposes a Prisma model, a provider SDK object, or an internal
  table name. Route handlers speak in domain shapes only.
