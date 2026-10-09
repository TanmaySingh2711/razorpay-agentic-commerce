import Link from "next/link";
import { Flowchart, FlowLegend, type FlowItem } from "@/components/flowchart";
import { ProjectEffort } from "@/components/project-effort";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { readProjectStats } from "@/lib/project-stats";
import { AI_FLOW, DASHBOARD_MAP, PURCHASE_FLOW, USER_FLOW } from "./flows";

/**
 * How it works: four flowcharts, the rules that hold them up, and the work
 * that went into the project.
 *
 * This absorbed the old /about page ("Architecture & Safety"), which now
 * redirects here: the seven safety decisions are the last section, after the
 * diagrams that show where each one applies.
 *
 * Prerendered at build time (`force-static`). It reads no database, holds no
 * identifiers, and exposes no configuration. The one thing it reads is the
 * repository itself, while it is being built, to count the work behind it
 * (`readProjectStats`).
 */
export const dynamic = "force-static";

export const metadata = {
  title: "How it works | Razorpay Agentic Commerce",
  description:
    "How the AI is built, how a purchase moves, what each page does, and how to use it, as flowcharts.",
};

const CHARTS: readonly {
  readonly id: string;
  readonly title: string;
  readonly lead: string;
  readonly items: readonly FlowItem[];
}[] = [
  {
    id: "ai",
    title: "How the AI is built",
    lead: "Two short passes of Gemini, with the server checking before, between and after them. The dashed boxes are the only steps the AI performs.",
    items: AI_FLOW,
  },
  {
    id: "purchase",
    title: "How a purchase works",
    lead: "From the moment a product is chosen, no AI is involved. Every step below is ordinary server code, a person, or Razorpay.",
    items: PURCHASE_FLOW,
  },
  {
    id: "pages",
    title: "What is in this dashboard",
    lead: "Every page, and how they connect. The tag on each box is the page's address.",
    items: DASHBOARD_MAP,
  },
  {
    id: "you",
    title: "How you use it",
    lead: "The path a shopper takes, including the three ways a request can go after you press Find.",
    items: USER_FLOW,
  },
];

const SAFETY = [
  {
    id: "ai-boundary",
    title: "AI Boundary",
    body: "Gemini can understand the request and propose a catalog product, but it cannot control price, authorization, payment, retries, or transaction state.",
  },
  {
    id: "quote",
    title: "Trusted PurchaseQuote",
    body: "The server re-reads trusted price, currency and stock from PostgreSQL and freezes those financial facts in a short-lived PurchaseQuote: the only amount that can ever be charged.",
  },
  {
    id: "policy",
    title: "Policy & Human Approval",
    body: "A deterministic rule set returns ALLOWED, APPROVAL_REQUIRED or BLOCKED. Higher-value purchases need an exact, one-time human approval before anything can move.",
  },
  {
    id: "inventory",
    title: "Inventory Reservation",
    body: "Stock is held atomically before payment, so two competing buyers cannot be sold the same last unit. A capture commits that hold exactly once.",
  },
  {
    id: "verification",
    title: "Razorpay Verification",
    body: "Orders are created server-side from the trusted quote. The browser's callback signature and Razorpay's own captured-webhook confirmation are checked separately, and only the second one is proof that money moved.",
  },
  {
    id: "retry",
    title: "Failure & Retry",
    body: "A failed payment can be retried a bounded number of times, only by a person. If the quote expires while the stock hold survives, the server re-quotes today's price, reruns policy, and reuses the same reservation, never a second one.",
  },
  {
    id: "audit",
    title: "Audit & State Machine",
    body: "Every financial decision and state transition is recorded in a structured, append-only audit trail, and a single authoritative state machine decides what happens next. Never the browser, and never the model.",
  },
] as const;

export default function HowItWorksPage() {
  const stats = readProjectStats();

  return (
    <>
      <SiteHeader current="how" />
      <main className="full">
        <header className="page-intro">
          <p className="eyebrow">How it works</p>
          <h1>Four diagrams. One rule running through all of them.</h1>
          <p className="lead">
            The AI suggests. The server decides. Razorpay moves the money. Follow a
            request from the sentence you type to the money arriving, and see exactly
            where each of those three hands over to the next.
          </p>
          <nav className="jump-nav" aria-label="On this page">
            {CHARTS.map((chart) => (
              <a key={chart.id} href={`#${chart.id}`}>
                {chart.title}
              </a>
            ))}
            <a href="#safety">Architecture &amp; Safety</a>
            <a href="#work">The work behind it</a>
          </nav>
        </header>

        <FlowLegend />

        {CHARTS.map((chart) => (
          <section
            key={chart.id}
            id={chart.id}
            className="chart-section"
            aria-labelledby={`${chart.id}-heading`}
          >
            <div className="chart-head">
              <div>
                <h2 id={`${chart.id}-heading`} className="section-title">
                  {chart.title}
                </h2>
                <p className="section-lead">{chart.lead}</p>
              </div>
            </div>
            <Flowchart label={chart.title} items={chart.items} />
          </section>
        ))}

        <section id="safety" className="chart-section" aria-labelledby="safety-heading">
          <div className="chart-head">
            <div>
              <h2 id="safety-heading" className="section-title">
                Architecture &amp; Safety
              </h2>
              <p className="section-lead">
                The seven decisions that keep the money safe, whatever the model says.
              </p>
            </div>
          </div>

          <div className="rule">
            <strong>No LLM output can directly cause a payment.</strong>
            The AI proposes, deterministic code validates, the authorization gates decide,
            and only then does the payment provider execute.
          </div>

          <ol className="safety-grid">
            {SAFETY.map((item) => (
              <li key={item.id} className="card" aria-labelledby={`${item.id}-heading`}>
                <h3 id={`${item.id}-heading`}>{item.title}</h3>
                <p>{item.body}</p>
              </li>
            ))}
          </ol>

          <div className="card two-facts">
            <h3>Two facts that are never treated as one</h3>
            <p>
              <code>PAYMENT_VERIFIED</code> means this browser&apos;s payment confirmation
              carried an authentic signature. <code>PAYMENT_CAPTURED</code> means Razorpay
              itself confirmed the money, through a webhook this server independently
              authenticates. The first can be forged by nothing more than a genuine
              browser callback; only the second is proof that funds moved, and only the
              second triggers the inventory commit and the move to <code>COMPLETED</code>.
            </p>
          </div>
        </section>

        {stats === null ? null : <ProjectEffort stats={stats} />}

        <div className="closing">
          <div className="hero-actions">
            <Link href="/shop" className="primary">
              Open the shop
            </Link>
            <Link href="/" className="secondary">
              Back to the overview
            </Link>
          </div>
        </div>

        <SiteFooter />
      </main>
    </>
  );
}
