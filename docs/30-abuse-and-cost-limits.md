# 30 — Abuse and cost limits

The deployment is a public URL, and every assistant request spends real model
quota. Without a ceiling, one script could spend the day's quota in minutes and
leave every genuine visitor - including a judge in the middle of a demo - with an
error. This document covers the limiter that prevents that.

**Code:** [`src/domain/rate-limit/rules.ts`](../src/domain/rate-limit/rules.ts)
(pure arithmetic), [`src/services/rate-limit/rate-limit-service.ts`](../src/services/rate-limit/rate-limit-service.ts)
(the counter), [`src/lib/http/rate-limited.ts`](../src/lib/http/rate-limited.ts)
(the HTTP wrapper). **Tests:** `tests/unit/rate-limit-rules.test.ts`,
`tests/db/rate-limit.test.ts`.

## The ceilings

| Surface                                | Rule               | Default | Window                   |
| -------------------------------------- | ------------------ | ------- | ------------------------ |
| Assistant (server action + API route)  | `agent-minute`     | 5       | per client per minute    |
|                                        | `agent-day`        | 60      | per client per day       |
|                                        | `agent-global-day` | 1500    | whole deployment per day |
| Payment order, checkout, retry, refund | `payment-minute`   | 20      | per client per minute    |

All four are configuration (`RATE_LIMIT_*`, see [09](./09-configuration.md)).
The payment callback and the webhook are deliberately **not** limited: they are
how a real payment gets confirmed, and refusing one would strand money that has
already moved.

## Why PostgreSQL, not memory

The app runs on serverless functions. Each warm instance has its own memory, so
an in-process counter would multiply every caller's allowance by the number of
instances. The counter is a row per `(bucket, window)` in `rate_limit_window`,
incremented by a single atomic upsert (`SET hits = hits + 1`). Two concurrent
requests never both read "under the limit", because neither reads: each learns
the count its own increment produced. `tests/db/rate-limit.test.ts` fires twelve
requests at once against a limit of three and asserts exactly three are admitted.

## Order is part of the control

Checks run in order and stop at the first refusal: per-client minute, per-client
day, then global. A caller already over its own limit is refused **before** the
global counter is touched, so one abusive client cannot spend everybody else's
daily allowance by being refused (asserted in the same suite).

## Who "a client" is

`clientKeyFromHeaders` reads `x-real-ip`, then the first hop of
`x-forwarded-for` - both overwritten by Vercel at its edge, so a caller cannot
pick its own bucket there - and stores only a SHA-256 digest. The limiter needs
"the same caller as before", not "who the caller is". A request with no address
shares one bucket with every other such request, which fails towards more
limiting, never less. The global ceiling exists precisely because a proxy that
does not overwrite the header would let a caller rotate it.

## Failing closed

If the database cannot answer, the request is refused: the API routes return an
error and the server action tells the shopper to try again. Every path the
limiter guards needs the same database a moment later anyway, and "the limiter
was down, so there was no limit" is precisely the outage a quota ceiling exists
to prevent.

## What a refusal looks like

- **API routes:** HTTP 429 in the standard error envelope
  (`{"error":{"code":"RATE_LIMITED","category":"rate_limited",...}}`) with a
  `Retry-After` header.
- **The shop page:** a sentence saying how long to wait, or that the demo has
  used today's allowance. Nothing is charged and no model is called.
- **The merchant dashboard:** refused requests are counted as `RATE_LIMITED`, so
  an attack shows up as an attack rather than as demand.

Expired windows (older than two days) are pruned by roughly one request in fifty;
pruning failure is logged and never refuses a request that was within its limits.
