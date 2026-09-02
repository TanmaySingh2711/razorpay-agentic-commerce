/**
 * The public landing page.
 *
 * It states the rule the whole system is built to enforce, and then says
 * plainly what is implemented and where the implementation stops. The second
 * half matters as much as the first: a payments demo that overstates how far it
 * goes is worse than one that is narrow and honest about it.
 *
 * Deliberately static. It reads no database, holds no identifiers, and exposes
 * no configuration - there is nothing here for a visitor to learn about the
 * deployment.
 */
export default function HomePage() {
  return (
    <main>
      <h1>Razorpay Agentic Commerce</h1>
      <p className="tagline">
        Razorpay AI Buildathon 2026 · Track 01 — AI Growth &amp; Agentic Commerce
      </p>

      <p>
        A merchant that an AI buyer agent can transact with end to end, where every
        financial action is explainable, bounded, gated and auditable.
      </p>

      <div className="rule">
        <strong>No LLM output can directly cause a payment.</strong>
        AI proposes → deterministic systems validate → authorization gates → payment
        infrastructure executes.
      </div>

      <h2>What is built</h2>
      <ul>
        <li>
          <strong>Agent-readable merchant catalog</strong> — structured product facts an
          agent can reason over, served from the merchant&apos;s own source of truth
        </li>
        <li>
          <strong>Gemini-powered buyer agent</strong> — interprets what a shopper wants
          and proposes a product; it may propose and nothing more
        </li>
        <li>
          <strong>Trusted PurchaseQuote</strong> — the server re-reads price, currency and
          stock and freezes them, so the amount is never taken from a model or a browser
        </li>
        <li>
          <strong>Deterministic policy engine</strong> — a pure, versioned rule set that
          answers allowed, approval required, or blocked, and denies by default
        </li>
        <li>
          <strong>Human approval gate</strong> — a single-use, timing-safe token bound to
          one exact transaction, quote, amount and currency
        </li>
        <li>
          <strong>Inventory reservation</strong> — stock is held atomically before money
          moves, so two buyers cannot be sold the same last unit
        </li>
        <li>
          <strong>Structured explainability and audit</strong> — an append-only trail
          where every decision records the values it turned on, in plain sentences
        </li>
        <li>
          <strong>Razorpay Test Mode order creation</strong> — server-side only, with the
          amount read from the persisted quote and duplicate orders prevented by the
          database
        </li>
        <li>
          <strong>Standard Checkout</strong> — opened only by an explicit human action;
          card details are collected by Razorpay and never touch this application
        </li>
        <li>
          <strong>Server-side signature verification</strong> — the payment confirmation
          is checked with a timing-safe HMAC against the order id this server stored,
          never the one the browser sent back
        </li>
        <li>
          <strong>Verified provider webhooks</strong> — capture is confirmed by Razorpay,
          not by the browser: the raw body is authenticated with a timing-safe HMAC before
          it is even parsed, and the delivery id is claimed in the same database
          transaction as its effects, so a redelivery changes nothing and a failure can
          still be retried
        </li>
        <li>
          <strong>Payment reconciliation</strong> — the amount the provider reports is
          checked against the persisted quote before anything moves, and events are
          handled in any order: a capture that arrives before the browser returns is
          reconciled, and a late failure can never undo one
        </li>
        <li>
          <strong>Bounded, human-triggered payment retry</strong> — a failed payment can
          be retried at most three times in total, counted from payment attempts stored in
          the database rather than from anything a browser sends. Each retry re-reads the
          price, re-runs the spending policy and re-checks the stock hold before it may
          touch the provider, and creates a new payment attempt rather than editing the
          failed one. Nothing automatic starts a retry — not a webhook, not a page reload,
          and not the agent
        </li>
        <li>
          <strong>Transaction lifecycle through PAYMENT_CAPTURED</strong> — every state
          change goes through one state machine, with an immutable history of how the
          transaction got there
        </li>
      </ul>

      <h2>Where this stops, deliberately</h2>
      <p>
        A verified signature proves a payment confirmation is genuine and belongs to this
        order. It is <strong>not</strong> proof that funds were captured — only the
        provider can assert that, and only through a webhook this server authenticates
        itself. So <code>PAYMENT_VERIFIED</code> and <code>PAYMENT_CAPTURED</code> stay
        separate states, reached by different evidence.
      </p>
      <p>
        Captured is still not finished. The lifecycle ends at{" "}
        <code>PAYMENT_CAPTURED</code>: stock stays reserved rather than sold, and no
        transaction is marked complete. Inventory commit and final completion are later
        objectives and are not implemented here.
      </p>

      <footer>
        Razorpay Test Mode — no real money moves. Architecture documentation lives in{" "}
        <code>docs/</code>. Liveness endpoint: <code>/api/health</code>.
      </footer>
    </main>
  );
}
