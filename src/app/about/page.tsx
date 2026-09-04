import Link from "next/link";

/**
 * Architecture & Safety — what this system is, and where it deliberately stops.
 *
 * This was the landing page until Objective 16, and then a long wall of prose
 * once the demo moved to `/`. Neither shape suited a reviewer well: the first
 * asked someone to read before they could try anything, and the second asked
 * them to read a great deal once they got here. This is the same claims,
 * organised as the seven decisions that actually keep money safe, each stated
 * in a sentence or two - the detail behind every one of them lives in `docs/`
 * rather than being duplicated here.
 *
 * Deliberately static. It reads no database, holds no identifiers, and exposes
 * no configuration - there is nothing here for a visitor to learn about the
 * deployment.
 */
export default function AboutPage() {
  return (
    <main>
      <p className="breadcrumb">
        <Link href="/">← Back to the demo</Link>
      </p>

      <header className="page-head">
        <h1>Architecture &amp; Safety</h1>
        <p className="lead">Razorpay Agentic Commerce</p>
        <p className="eyebrow">
          Razorpay AI Buildathon 2026 · Track 01 — AI Growth &amp; Agentic Commerce
        </p>
      </header>

      <p>
        A merchant that an AI buyer agent can transact with end to end, where every
        financial action is explainable, bounded, gated and auditable.
      </p>

      <div className="rule">
        <strong>No LLM output can directly cause a payment.</strong>
        AI proposes → deterministic systems validate → authorization gates → payment
        infrastructure executes.
      </div>

      <h2>What keeps this safe</h2>
      <div className="safety-grid">
        <section className="card" aria-labelledby="ai-boundary-heading">
          <h3 id="ai-boundary-heading">AI Boundary</h3>
          <p>
            Gemini can understand the request and propose a catalog product, but it cannot
            control price, authorization, payment, retries, or transaction state.
          </p>
        </section>

        <section className="card" aria-labelledby="quote-heading">
          <h3 id="quote-heading">Trusted PurchaseQuote</h3>
          <p>
            The server re-reads trusted price, currency and stock from PostgreSQL and
            freezes those financial facts in a short-lived <code>PurchaseQuote</code> —
            the only amount that can ever be charged.
          </p>
        </section>

        <section className="card" aria-labelledby="policy-heading">
          <h3 id="policy-heading">Policy &amp; Human Approval</h3>
          <p>
            A deterministic rule set returns <code>ALLOWED</code>,{" "}
            <code>APPROVAL_REQUIRED</code> or <code>BLOCKED</code>. Higher-value purchases
            need an exact, one-time human approval before anything can move.
          </p>
        </section>

        <section className="card" aria-labelledby="inventory-heading">
          <h3 id="inventory-heading">Inventory Reservation</h3>
          <p>
            Stock is held atomically before payment, so two competing buyers cannot be
            sold the same last unit. A capture commits that hold exactly once.
          </p>
        </section>

        <section className="card" aria-labelledby="verification-heading">
          <h3 id="verification-heading">Razorpay Verification</h3>
          <p>
            Orders are created server-side from the trusted quote. The browser&apos;s
            callback signature and Razorpay&apos;s own captured-webhook confirmation are
            checked separately, and only the second one is proof that money moved.
          </p>
        </section>

        <section className="card" aria-labelledby="retry-heading">
          <h3 id="retry-heading">Failure &amp; Retry</h3>
          <p>
            A failed payment can be retried a bounded number of times, only by a person.
            If the quote expires while the stock hold survives, the server re-quotes
            today&apos;s price, reruns policy, and reuses the same reservation — never a
            second one.
          </p>
        </section>

        <section className="card" aria-labelledby="audit-heading">
          <h3 id="audit-heading">Audit &amp; State Machine</h3>
          <p>
            Every financial decision and state transition is recorded in a structured,
            append-only audit trail, and a single authoritative state machine — never the
            browser, never the model — decides what happens next.
          </p>
        </section>
      </div>

      <h2>Two facts that are never treated as one</h2>
      <div className="card">
        <p>
          <code>PAYMENT_VERIFIED</code> means this browser&apos;s payment confirmation
          carried an authentic signature. <code>PAYMENT_CAPTURED</code> means Razorpay
          itself confirmed the money, through a webhook this server independently
          authenticates. The first can be forged by nothing more than a genuine browser
          callback; only the second is proof that funds moved, and only the second
          triggers the inventory commit and the move to <code>COMPLETED</code>.
        </p>
      </div>

      <p className="hint">
        This has run end to end against Razorpay Test Mode, including a genuine bank
        decline, a retry, and a duplicate webhook redelivery that changed nothing.
      </p>

      <footer>
        Razorpay Test Mode — no real money moves. Full implementation detail lives in{" "}
        <code>docs/</code> rather than here. Liveness endpoint: <code>/api/health</code>.
      </footer>
    </main>
  );
}
