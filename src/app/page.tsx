import Link from "next/link";
import { BuyerConsole } from "@/components/buyer/buyer-console";

/**
 * The demo itself.
 *
 * Until Objective 16 this page was an implementation-status document. That was
 * the right thing to ship while there was nothing to use, and the wrong thing
 * to keep once there was: a reviewer arriving at a commerce demo should be able
 * to *buy something* before reading about the architecture. The status page is
 * still here, at /about, now titled "Architecture & Safety", and is reached
 * through a clearly visible secondary link rather than the homepage itself.
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
    "Describe what you want in plain words. The assistant proposes; the server prices, checks the rules and takes payment.",
};

const STEPS = [
  {
    title: "You describe",
    body: "Describe what you want in plain words, including a budget if you have one.",
  },
  {
    title: "AI proposes",
    body: "The Buyer Agent reads the merchant catalog and proposes a valid product.",
  },
  {
    title: "Server verifies",
    body: "The server re-reads trusted price, currency and availability and creates the PurchaseQuote.",
  },
  {
    title: "Policy / Approval",
    body: "Deterministic spending rules authorize the purchase or ask the human for approval.",
  },
  {
    title: "Razorpay payment",
    body: "Razorpay Test Mode opens only after authorization and an explicit human Pay action.",
  },
];

/**
 * The slim bar every page opens with.
 *
 * Not a navigation system - there is nowhere else in this demo to navigate to
 * from here - just enough identity and status that the page reads as a
 * product rather than a submission. `TEST MODE · NO REAL MONEY` is the one
 * fact that must survive no matter how the rest of the copy changes, so it is
 * a fixed badge rather than prose that could later be edited away.
 */
function ProductBar() {
  return (
    <header className="product-bar">
      <div className="product-bar-inner">
        <span className="brand">Razorpay Agentic Commerce</span>
        <span className="badge test-mode">
          <span className="dot" aria-hidden="true" />
          Test Mode · No real money
        </span>
      </div>
    </header>
  );
}

export default function HomePage() {
  return (
    <>
      <ProductBar />
      <main className="wide">
        <header className="page-head">
          <h1>Shop by describing what you want</h1>
          <p className="lead">
            An AI assistant that can read a catalog and suggest a product — and a server
            that decides every single thing about the money.
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
          The assistant proposes a product and nothing else. It cannot set the
          authoritative price, approve a purchase, retry a payment, advance transaction
          state, or declare a payment successful.
        </div>

        <p className="cta-row">
          <Link href="/about" className="secondary">
            View Architecture &amp; Safety
          </Link>
        </p>

        <footer className="site-footer">
          <p className="tagline">Razorpay Test Mode — no real money moves.</p>
        </footer>
      </main>
    </>
  );
}
