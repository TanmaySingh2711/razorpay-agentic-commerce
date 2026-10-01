# 31 — Conversation, prefetch and the agent trace

Three changes to the Buyer Agent ([19](./19-buyer-agent.md)). Each one makes the
agent more useful, and each one keeps every guarantee the agent already had.

**Code:** [`src/services/buyer-agent/buyer-agent-service.ts`](../src/services/buyer-agent/buyer-agent-service.ts),
[`src/app/actions/purchase.ts`](../src/app/actions/purchase.ts),
[`src/components/buyer/buyer-console.tsx`](../src/components/buyer/buyer-console.tsx).
**Tests:** `tests/unit/buyer-agent-conversation.test.ts`,
`tests/unit/buyer-agent-server-action-timeout.test.ts`.

## 1. Answering a clarifying question

Before, a clarifying question ("what is the most you would like to spend?") was
a dead end: the shopper had to retype the whole request with the answer in it.
Now the answer continues the conversation.

The server returns the exchange so far with the question; the page keeps it in a
hidden field and sends it back with the next message. At most three earlier
turns, each bounded, re-validated on every request (`validatePriorTurns`).

**The two halves of a turn are trusted differently, and that is the point.**

- The **shopper's words** are the human's own statement of intent. A budget
  stated in an earlier turn is exactly as binding as one stated now, so every
  shopper turn joins the text the budget is verified against
  (`verifyBudgetClaim`, [19](./19-buyer-agent.md)).
- The **assistant's question** came back from the browser, so it is context and
  nothing more. The model sees it - which is what makes a bare "3000" mean "a
  ₹3000 ceiling" - but the budget check never reads it. A forged question can
  make the model misunderstand; it cannot create a spending limit the shopper
  never typed. Asserted in `refuses a budget that appears only in the
assistant's question`.

## 2. The server-side catalog prefetch

A request used to cost three model round trips: extract the intent, ask for a
catalog search, choose from the results. The middle one is almost always the
same search - the shopper's category under their verified budget.

With `prefetch` on (the production default), the server runs that search itself
through the same tool executor and argument schema a model's call would use, and
hands the results to the model with the selection prompt. The common path is now
**two round trips instead of three**. The model still has its tools and still
calls one when the prefetch is not enough.

Nothing about provenance changes. The search arguments come from the **locked**
authority, never from the model. Every prefetched product is recorded as
observed exactly like a tool result, because the model was shown it - and a
product the prefetch did not return is still refused if the model proposes it
(`still refuses a product the prefetch never showed`). A budget that covers the
whole order is not divided into a per-unit filter here; that would be the server
inventing a number the shopper never stated.

Prefetch is off when a test builds its own dependencies, so every existing test
that scripts the tool loop turn by turn still exercises exactly that loop. The
prefetch path has its own tests.

## 3. The trace

Every decision now carries `trace`: model calls (retries included), tool calls,
products observed, whether the prefetch ran, duration, and which turn of a
conversation it was. It is counted by the orchestrator - the provider is wrapped
so no call site can forget - never reported by the model, and every field is a
number or a flag, so there is nowhere in it for model text. The decision-shape
test was extended to assert exactly that.

The trace is written into the `product_selected` audit record with the
alternatives the decision engine considered ([33](./33-merchant-insights.md)),
and it is what the transaction page's **How the assistant chose** card and the
merchant dashboard's latency figures are built from.

## 4. Browsing gets an answer

"Show me a keyboard under ₹3000" used to end in "that reads as browsing". The
agent had already chosen a product and the deterministic gate had already
accepted it - the answer was simply thrown away. Now a browse or advice request
returns a **recommendation**: the product, the catalog's current price, the
agent's one-line summary, and a **Buy this** button.

Nothing is opened by recommending. **Buy this** only fills the request box with
a purchase sentence - "Buy the Aurora TKL Mechanical Keyboard under ₹3,000.00" -
which the shopper sends themselves, and which the server then prices, checks
and quotes from scratch like any other request. The sentence restates the
shopper's own verified ceiling in exactly the form the budget check reads back,
so following the recommendation keeps the limit they set (asserted in
`tests/unit/buyer-agent-server-action-timeout.test.ts`).

## What the shopper sees

- A thread of the conversation when the assistant asks something, with an
  **Answer** button and a **Start over** link.
- A progress panel while the request runs, naming what usually happens by then
  and counting seconds - honest about being time-based, because a server action
  returns once.
- On the purchase page, **How the assistant chose**: products looked at, how many
  met every rule, model calls, time taken, and the other eligible products with
  their price difference.
