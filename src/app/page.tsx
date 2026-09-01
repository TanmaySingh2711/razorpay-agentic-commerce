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
          <strong>Transaction lifecycle through PAYMENT_VERIFIED</strong> — every state
          change goes through one state machine, with an immutable history of how the
          transaction got there
        </li>
      </ul>

      <h2>Where this stops, deliberately</h2>
      <p>
        A verified signature proves the payment confirmation is genuine and belongs to
        this order. It is <strong>not</strong> proof that funds were captured, and it is
        not fulfilment. So the lifecycle ends at <code>PAYMENT_VERIFIED</code>: stock
        stays reserved rather than sold, and no transaction is marked complete.
      </p>
      <p>
        Confirming capture is the payment provider&apos;s job to assert, not the
        browser&apos;s. Webhook verification, payment reconciliation, inventory commit and
        final completion are later objectives and are not implemented here.
      </p>

      <footer>
        Razorpay Test Mode — no real money moves. Architecture documentation lives in{" "}
        <code>docs/</code>. Liveness endpoint: <code>/api/health</code>.
      </footer>
    </main>
  );
}
