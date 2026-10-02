# 33 — Merchant insights

The rest of this system makes an AI-assisted purchase safe for the buyer; `/merchant` shows what it is worth to the seller -
what shoppers asked the assistant for, what turned into paid orders, and what
the merchant could stock or price differently to sell more.

**Code:** [`src/app/merchant/page.tsx`](../src/app/merchant/page.tsx),
[`src/services/merchant-insights-service.ts`](../src/services/merchant-insights-service.ts),
[`src/services/agent-request-log.ts`](../src/services/agent-request-log.ts),
[`src/domain/insights.ts`](../src/domain/insights.ts).
**Tests:** `tests/unit/insights-metrics.test.ts`, `tests/db/merchant-insights.test.ts`.

## What it shows (last 30 days)

| Section                        | Built from                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Net revenue, paid orders, AOV  | `CAPTURED` payment attempts, less `PROCESSED` refunds                        |
| Asked → paid, the funnel       | agent requests → quotes → `AUTHORIZED` transitions → captured payments       |
| Time to a verified price       | median and p90 of recorded request durations; average model calls            |
| **Demand you did not capture** | `NO_MATCH` requests grouped by category, against the cheapest in-stock price |
| How requests ended             | every agent request outcome, including rate-limited ones                     |
| What the spending rules did    | `POLICY_ALLOWED`, `POLICY_REQUIRES_APPROVAL`, approval and block transitions |
| Payments recovered by retry    | purchases with a failed attempt that were captured on a later one            |
| Best sellers, recent purchases | captured attempts and quotes, by product name                                |

"Demand you did not capture" is the growth signal. It separates two things a
merchant can act on: categories they do not stock ("webcam - 3 requests, not in
your catalog") and price points they do not reach ("2 wanted to spend less than
your cheapest (₹799); the typical budget was ₹500").

## The request log stores shape, not words

`agent_request` holds one row per assistant request: outcome, request type,
category, server-verified budget, the purchase it opened, turn, and the trace
counters. It never holds the sentence the shopper typed. The category may have
come from the model (the shopper's word for something this merchant does not
sell), so it is normalised to a bounded label before it is stored - an
instruction smuggled into a category name has nowhere left to live.

Writing this row is **best-effort**: it is insight, not evidence. The audit trail
is the record of what happened to money and is written inside the transactions
that move it. If the insight insert fails, the shopper still gets their answer.

## Read-only, aggregate, identity-free

The page is public in this demo - there is no merchant login - so it shows only
what a storefront would: counts, amounts and product names. No buyer, no
transaction id, no purchase links (a list of links would make every open
purchase's approve button one click away for anyone). `tests/db/merchant-insights.test.ts`
serialises the whole result and asserts no transaction id or buyer appears.

Money stays `bigint` minor units end to end; the only division is for rates and
averages, which are presentation, not ledger. Percentiles are nearest-rank, so
every "p90" is a value some request actually had.

## Charts

Single-series horizontal bar lists in the brand accent - one hue, so no legend;
the value is written at every bar's tip and in its tooltip, and the list itself
is the table view. The accent was validated for lightness, chroma and contrast
against both themes' surfaces. In Windows high-contrast (`forced-colors`) mode
the bars opt out of background repainting and draw in `CanvasText`, so the
charts are never silently empty.

## Seeing it locally without spending quota

`npm run db:dev:demo` drives a set of shopper sessions through the **real**
services - decision, quote, policy, approval, hold, order, checkout, signed
webhook, retry, refund - substituting only the model (decisions are written by
the script) and the payment provider (an in-process stand-in that signs its own
webhooks). It refuses any database that is not on this machine.
