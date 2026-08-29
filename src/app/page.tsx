/**
 * Foundation landing page.
 *
 * Objective 1 ships no product UI. This page exists to prove the application
 * boots and to state the architectural rule the rest of the build is held to.
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

      <h2>Objective 1 — foundation, in place</h2>
      <ul>
        <li>Next.js App Router application on strict TypeScript</li>
        <li>Money as integer minor units with an explicit currency</li>
        <li>Typed transaction state machine with per-actor transition rules</li>
        <li>Typed, validated configuration boundary — no secret required to boot</li>
        <li>Error, logging, explainability and audit contracts</li>
      </ul>

      <h2>Not yet built, by design</h2>
      <ul>
        <li>Buyer agent, LLM integration, catalog and product decisions</li>
        <li>Policy execution, approval gate, Razorpay payments and webhooks</li>
      </ul>

      <footer>
        Architecture documentation lives in <code>docs/</code>. Liveness endpoint:{" "}
        <code>/api/health</code>.
      </footer>
    </main>
  );
}
