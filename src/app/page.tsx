import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-header";

/**
 * The overview: what this is, in one screen, and the one idea behind it.
 *
 * Everything deeper - the flowcharts, the safety rules, the work behind the
 * project - lives on /how-it-works, so this page stays short enough to read
 * before trying the shop.
 */
export const metadata = {
  title: "Razorpay Agentic Commerce",
  description:
    "An AI assistant that picks a product from a sentence, and a server that decides everything about the money.",
};

const PIPELINE = [
  {
    title: "You describe",
    who: "You",
    body: "Describe what you want in plain words, including a budget if you have one.",
  },
  {
    title: "AI proposes",
    who: "AI",
    body: "The Buyer Agent reads the merchant catalog and proposes a valid product.",
  },
  {
    title: "Server verifies",
    who: "Server",
    body: "The server re-reads trusted price, currency and availability and creates the PurchaseQuote.",
  },
  {
    title: "Policy / Approval",
    who: "Server and you",
    body: "Deterministic spending rules authorize the purchase or ask the human for approval.",
  },
  {
    title: "Razorpay payment",
    who: "Razorpay",
    body: "Razorpay Test Mode opens only after authorization and an explicit human Pay action.",
  },
] as const;

export default function OverviewPage() {
  return (
    <>
      <SiteHeader current="overview" />
      <main className="full">
        <section className="hero" aria-labelledby="hero-heading">
          <p className="eyebrow">Overview</p>
          <h1 id="hero-heading" className="hero-title">
            <span>An AI that shops for you.</span>
            <span className="hero-accent">Never trusted with the money.</span>
          </h1>
          <p className="hero-lead">
            Type what you want in plain words. An AI assistant reads the shop&apos;s
            catalog and suggests one product. From there, ordinary server code takes over:
            it looks up the real price, checks your spending rules, holds the item and
            takes the payment through Razorpay.
          </p>
          <div className="hero-actions">
            <Link href="/shop" className="primary">
              Open the shop
            </Link>
            <Link href="/how-it-works" className="secondary">
              See how it works
            </Link>
          </div>
        </section>

        <section className="section" aria-labelledby="pipeline-heading">
          <p className="eyebrow">The idea</p>
          <h2 id="pipeline-heading" className="section-title">
            Five steps. The AI owns one of them.
          </h2>
          <ol className="pipeline">
            {PIPELINE.map((step) => (
              <li
                key={step.title}
                className="pipeline-step"
                data-ai={step.who === "AI" ? "true" : undefined}
              >
                <span className="pipeline-who">{step.who}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
          <div className="rule">
            <strong>No AI output can directly cause a payment.</strong>
            The assistant proposes a product and nothing else. It cannot set the
            authoritative price, approve a purchase, retry a payment, advance transaction
            state, or declare a payment successful.
          </div>
        </section>

        <SiteFooter />
      </main>
    </>
  );
}
