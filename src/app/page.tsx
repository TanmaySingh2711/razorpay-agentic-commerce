import Link from "next/link";
import { BuyerConsole } from "@/components/buyer/buyer-console";

/**
 * The demo itself.
 *
 * Until Objective 16 this page was an implementation-status document. That was
 * the right thing to ship while there was nothing to use, and the wrong thing
 * to keep once there was: a reviewer arriving at a commerce demo should be able
 * to *buy something* before reading about the architecture. The status page is
 * still here, at /about, and is linked from the footer.
 *
 * The page itself is a server component holding no state. The one interactive
 * element is the console, which sends a sentence to a server action and renders
 * what comes back.
 *
 * `maxDuration` bounds that server action (`submitRequest`, in
 * `src/app/actions/purchase.ts`), which is where it invokes the Buyer Agent.
 * Next.js reads a Server Action's execution limit from the route segment that
 * invokes it, not from the action's own file, so it is declared here.
 *
 * 60 is a deliberate application-level cap, not a hosting platform ceiling -
 * the current hosting tier supports materially longer executions than this.
 * It exists so this file states, verifiably, the longest this action is ever
 * meant to run, and the agent's own worst case is kept under it - see
 * `OVERALL_REQUEST_BUDGET_MS` in `buyer-agent-service.ts` - so that cap is
 * never the thing a slow request actually meets.
 */
export const maxDuration = 60;

export const metadata = {
  title: "Razorpay Agentic Commerce — buy something",
  description:
    "Ask for what you want in plain words. The assistant proposes; the server prices, checks the rules and takes payment.",
};

const STEPS = [
  {
    title: "You ask",
    body: "Describe what you want in ordinary words, with a budget if you have one.",
  },
  {
    title: "The assistant proposes",
    body: "It reads the merchant's catalog and suggests one product. That is the limit of what it can do.",
  },
  {
    title: "The server decides",
    body: "It re-reads the real price, freezes it, applies your spending rules and asks you if approval is needed.",
  },
  {
    title: "You pay",
    body: "Razorpay Test Mode opens only after every check has passed, and only when you press Pay.",
  },
];

export default function HomePage() {
  return (
    <main className="wide">
      <header className="page-head">
        <h1>Shop by describing what you want</h1>
        <p className="lead">
          An AI assistant that can read a catalog and suggest a product — and a server
          that decides every single thing about the money.
        </p>
        <p className="eyebrow">
          Razorpay AI Buildathon 2026 · Track 01 — AI Growth &amp; Agentic Commerce ·
          <strong> Test Mode, no real money moves</strong>
        </p>
      </header>

      <BuyerConsole />

      <section className="how" aria-labelledby="how-heading">
        <h2 id="how-heading">How it works</h2>
        <ol className="steps">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="step-number" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="rule">
        <strong>No AI output can directly cause a payment.</strong>
        The assistant proposes a product and nothing else. It cannot set a price, approve
        a purchase, retry a payment, or move a transaction forward.
      </div>

      <footer className="site-footer">
        <p>
          <Link href="/about">How this is built, and where it stops</Link>
        </p>
        <p className="tagline">Razorpay Test Mode — no real money moves.</p>
      </footer>
    </main>
  );
}
