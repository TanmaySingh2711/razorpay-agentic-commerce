import Link from "next/link";
import { BuyerConsole } from "@/components/buyer-console";
import { SiteFooter, SiteHeader } from "@/components/site-header";

/**
 * Page 02 - the shop: one input, and everything after it is the server's.
 *
 * The page is a server component holding no state. The one interactive
 * element is the console, which sends a sentence to a server action and
 * renders what comes back.
 *
 * `maxDuration` bounds that server action (`submitRequest`, in
 * `src/app/actions.ts`), which is where it invokes the Buyer Agent.
 * Next.js reads a Server Action's execution limit from the route segment that
 * invokes it, not from the action's own file, so it is declared here - on the
 * page the console lives on.
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
  title: "Shop — Razorpay Agentic Commerce",
  description:
    "Describe what you want in plain words. The assistant proposes; the server prices, checks the rules and takes payment.",
};

const NEXT_STEPS = [
  { title: "The assistant suggests one product", who: "AI" },
  { title: "The server reads the real price and freezes it", who: "Server" },
  { title: "Your spending rules run; above ₹3,000 you approve", who: "Server + you" },
  { title: "You hold the item and press Pay", who: "You" },
  { title: "Razorpay confirms the money", who: "Razorpay" },
] as const;

export default function ShopPage() {
  return (
    <>
      <SiteHeader current="shop" />
      <main className="full">
        <header className="page-intro">
          <p className="eyebrow">02 — Shop</p>
          <h1>Say what you want. The server does the rest.</h1>
          <p className="lead">
            An AI assistant that can read a catalog and suggest a product — and a server
            that decides every single thing about the money.
          </p>
        </header>

        <div className="shop-layout">
          <BuyerConsole />

          <aside className="shop-aside" aria-labelledby="after-heading">
            <h2 id="after-heading">After you press Find</h2>
            <ol className="after-list">
              {NEXT_STEPS.map((step) => (
                <li key={step.title} data-ai={step.who === "AI" ? "true" : undefined}>
                  <span className="after-who">{step.who}</span>
                  {step.title}
                </li>
              ))}
            </ol>
            <p className="hint">
              Searching never charges anything. Nothing is paid until you press Pay in the
              Razorpay window yourself.
            </p>
            <Link href="/how-it-works" className="secondary">
              See the full flow
            </Link>
          </aside>
        </div>

        <SiteFooter />
      </main>
    </>
  );
}
