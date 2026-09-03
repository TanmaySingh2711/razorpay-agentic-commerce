# Staging deployment

The application runs as a public staging deployment on **Vercel**:

**https://razorpay-agentic-commerce-xi.vercel.app**

This is a staging and demonstration environment. It is **not** a claim of
production readiness, and it must never run against Razorpay Live Mode.

## What "staging" means here

Everything moves through **Razorpay Test Mode**. No real money is charged, no
real card is accepted, and no settlement occurs. Test Mode is not a
configuration preference that a deployment may reverse: the configuration
boundary refuses to start the payment path with anything that is not an
`rzp_test_` key id, so pasting a live key into the hosting dashboard fails
closed rather than quietly working.

The staging URL is stable, and it is the base URL for the
Razorpay webhook endpoint. That endpoint does not exist yet and is deliberately
not configured.

## Platform and runtime

| Concern      | Choice                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| Platform     | Vercel, deploying automatically from `main`                             |
| Framework    | Next.js App Router                                                      |
| Node runtime | Node.js 24                                                              |
| Database     | Neon PostgreSQL through Prisma ORM, over Neon's pooled endpoint         |
| AI provider  | Google Gemini, `gemini-3.6-flash`, through the provider-neutral adapter |
| Payments     | Razorpay **Test Mode**, through the payment-provider adapter            |

Every API route declares `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
Both are load-bearing rather than habitual. The routes use Node built-ins that
have no edge equivalent here — `crypto` for HMAC signature verification, Prisma
over TCP for persistence — and every one of them reads live data or a
server-only secret, so none may be prerendered or cached.

## Deployment environment variables

Names only. Values live in the hosting dashboard and in the git-ignored
`.env.local`; none belongs in this repository.

| Variable                  | Purpose in the deployed runtime                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | **Pooled** PostgreSQL connection. Serverless invocations would exhaust a database's connection limit over a direct endpoint.                                                                                                                                      |
| `GEMINI_API_KEY`          | Gemini credentials. Server-only.                                                                                                                                                                                                                                  |
| `GEMINI_MODEL`            | Pinned to `gemini-3.6-flash` for staging consistency.                                                                                                                                                                                                             |
| `RAZORPAY_KEY_ID`         | Test Mode key id. Reaches the browser only through the checkout session DTO.                                                                                                                                                                                      |
| `RAZORPAY_KEY_SECRET`     | Test Mode key secret. Server-only, without qualification.                                                                                                                                                                                                         |
| `RAZORPAY_WEBHOOK_SECRET` | Authenticates inbound Razorpay webhooks. A different credential from the key secret: that one authenticates us to Razorpay, this one authenticates Razorpay to us. Server-only, and validated as its own section so a deployment without it still creates orders. |
| `APP_URL`                 | The stable staging URL above.                                                                                                                                                                                                                                     |
| `LOG_LEVEL`               | `info`.                                                                                                                                                                                                                                                           |

### Variables that are deliberately absent

| Variable          | Why it is not deployed                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DIRECT_URL`      | A migration and admin concern, not a runtime one. The application runs on the pooled URL alone, so there is no reason to place an unpooled admin connection string in a hosting dashboard. Prisma's CLI reads it from `.env.local` when schema work is done. |
| `TEST_DIRECT_URL` | Test-only, read solely by the test harness and the test-schema script. A test asserts that no file under `src/` reads it, so it can never become a runtime dependency.                                                                                       |
| `APP_SECRET`      | Declared in the config layer for future session and CSRF signing, and consumed by nothing today. It is validated lazily, so its absence blocks nothing.                                                                                                      |
| `NODE_ENV`        | Set by the platform.                                                                                                                                                                                                                                         |
| `NEXT_PUBLIC_*`   | Anything so prefixed is inlined into the client bundle at build time. No configuration this application holds belongs there, so the safe number is zero — asserted by a test rather than by convention.                                                      |

## The webhook endpoint

`POST /api/webhooks/razorpay` is subscribed in the Razorpay **Test Mode**
dashboard for `payment.captured` and `payment.failed`.

It reads the raw request body before anything looks at it, verifies
`X-Razorpay-Signature` as an HMAC-SHA256 of those exact bytes under
`RAZORPAY_WEBHOOK_SECRET`, and only then parses the JSON. `x-razorpay-event-id`
is claimed under a unique index in the same database transaction as the
reconciliation it authorises, so a redelivery is a no-op and a failed attempt
leaves nothing behind for the provider's retry to trip over.

An unauthenticated caller gets `401` and no detail. Every authenticated
outcome - reconciled, duplicate, ignored, or refused for not matching our
records - answers `200`, because each is a finished decision the provider has no
reason to retry.

## Migrations

The deployed runtime never runs migrations. Schema changes are applied from a
trusted environment over Neon's **direct** (unpooled) connection, because
connection poolers generally cannot run DDL. The commands say `:staging` out
loud, because the plain names target the local development database:

```
npm run db:status:staging   # read-only: is the hosted database up to date?
npm run db:migrate:staging  # apply committed migrations to Neon
npm run db:verify:staging   # does the live schema still match the design?
```

`db push` is never a substitute for migration history, and the staging database
is never reset, truncated, dropped or recreated to resolve a migration problem.

## What the deployment does not prove

`PAYMENT_VERIFIED` is **not** `PAYMENT_CAPTURED`, and neither is `COMPLETED`.

A verified signature proves the payment confirmation is authentic and belongs to
the order this server created. It does not prove funds were captured, that the
order should be fulfilled, or that stock should be committed. Confirming capture
is the payment provider's job to assert through a webhook, which the deployment now
verifies and reconciles. Capture is still not fulfilment: inventory commit and final
completion remain later objectives.
Until then the lifecycle stops at `PAYMENT_VERIFIED`, stock stays reserved rather
than sold, and no transaction is marked complete.
