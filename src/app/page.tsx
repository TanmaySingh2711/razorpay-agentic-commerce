import Link from "next/link";
import { CountUp } from "@/components/count-up";
import { SiteFooter, SiteHeader } from "@/components/site-header";
import { readProjectStats, type ProjectStats } from "@/lib/project-stats";

/**
 * Page 01 - what this is, how the AI in it is built, and what it took.
 *
 * Prerendered at build time (`force-static`): the "work behind it" figures are
 * counted from the repository by `readProjectStats`, once, while the source is
 * on disk. Nothing on this page is typed in by hand that could be measured
 * instead, and anything that cannot be measured is left out.
 */
export const dynamic = "force-static";

export const metadata = {
  title: "Razorpay Agentic Commerce — overview",
  description:
    "An AI assistant that picks a product from a sentence, and a server that decides everything about the money.",
};

const REPOSITORY = "https://github.com/TanmaySingh2711/razorpay-agentic-commerce";

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
    who: "Server + you",
    body: "Deterministic spending rules authorize the purchase or ask the human for approval.",
  },
  {
    title: "Razorpay payment",
    who: "Razorpay",
    body: "Razorpay Test Mode opens only after authorization and an explicit human Pay action.",
  },
] as const;

const PAGES = [
  {
    number: "02",
    href: "/shop",
    title: "Shop",
    body: "Type what you want. The assistant finds it, the server prices it, and you decide whether to pay.",
  },
  {
    number: "03",
    href: "/how-it-works",
    title: "How it works",
    body: "Four flowcharts: how the AI is built, how a purchase moves, what each page does, and how to use it.",
  },
  {
    number: "04",
    href: "/history",
    title: "History",
    body: "Every purchase you open is saved in this browser, with its current status. Clear it whenever you like.",
  },
  {
    number: "05",
    href: "/merchant",
    title: "Merchant",
    body: "The seller's side: revenue, conversion, and what shoppers asked for that the shop does not sell.",
  },
] as const;

const AI_PARTS = [
  {
    label: "Model",
    title: "Google Gemini",
    body: "Called from the server through the @google/genai SDK. The default model is gemini-3.5-flash-lite with the thinking level set to minimal; both are settings, not code.",
  },
  {
    label: "Pass 1",
    title: "Intent",
    body: "Your sentence becomes a structured intent: what you want, how many, and your budget. The server then finds the budget in your own words and re-reads it itself.",
  },
  {
    label: "Pass 2",
    title: "Selection",
    body: "The server runs the most likely catalog search first and hands the results over. The model picks one product, asks you a question, or says nothing matched.",
  },
  {
    label: "Tools",
    title: "Three, all read-only",
    body: "search_catalog, get_product_by_id and get_merchant_info. None of them can write, reserve, price or pay.",
  },
  {
    label: "Output",
    title: "A product id, never a price",
    body: "The answer format has a product id, a quantity, reason codes and one sentence. There is no field in it for an amount.",
  },
  {
    label: "Check",
    title: "Validated by code",
    body: "The product must be one the model was shown, in the right category, in stock and within budget. Otherwise it is refused, whatever the model said.",
  },
] as const;

const STACK = [
  "Next.js 16",
  "React 19",
  "TypeScript (strict)",
  "PostgreSQL 17",
  "Prisma 7",
  "Google Gemini",
  "Razorpay Test Mode",
  "Zod",
  "Vitest",
  "GitHub Actions",
] as const;

const CI_CHECKS = [
  "Lint (eslint + prettier)",
  "Type check (tsc)",
  "Tests on Ubuntu",
  "Tests on macOS",
  "Tests on Windows",
  "One-click setup on Ubuntu",
  "One-click setup on macOS",
  "One-click setup on Windows",
] as const;

/** Whole days from the first commit to the last, counting both. */
function daysBetween(first: string, last: string): number {
  const ms = Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Stat({
  value,
  label,
  note,
}: {
  readonly value: number;
  readonly label: string;
  readonly note: string;
}): React.JSX.Element {
  return (
    <li className="effort-stat">
      <span className="effort-value">
        <CountUp value={value} />
      </span>
      <span className="effort-label">{label}</span>
      <span className="effort-note">{note}</span>
    </li>
  );
}

function Effort({ stats }: { readonly stats: ProjectStats }): React.JSX.Element {
  const { git } = stats;
  return (
    <section className="section" aria-labelledby="effort-heading">
      <p className="eyebrow">The work behind it</p>
      <h2 id="effort-heading" className="section-title">
        Counted from the code, not written by hand
      </h2>
      <p className="section-lead">
        Every number here is measured from the repository when the site is built. If a
        test is added tomorrow, the next build says so.
      </p>

      <ul className="effort-grid">
        <Stat
          value={stats.sourceLines}
          label="Lines of application code"
          note={`${String(stats.sourceFiles)} files, blank lines not counted`}
        />
        <Stat
          value={stats.testCases}
          label="Test cases written"
          note={`${String(stats.testFiles)} test files: unit tests, and tests against a real PostgreSQL`}
        />
        <Stat
          value={stats.testLines}
          label="Lines of tests"
          note={`${String(Math.round((stats.testLines / Math.max(1, stats.sourceLines)) * 100))} lines of test for every 100 lines of code`}
        />
        <Stat
          value={stats.documents.length}
          label="Design documents"
          note={`${stats.documentWords.toLocaleString("en-IN")} words explaining each decision`}
        />
        <Stat
          value={stats.migrations}
          label="Database migrations"
          note="Every schema change kept as reviewable history"
        />
        <Stat
          value={stats.apiEndpoints}
          label="API endpoints"
          note={`and ${String(stats.pages)} pages`}
        />
        {git === null ? null : (
          <>
            <Stat
              value={git.commits}
              label="Commits"
              note={`${formatDay(git.firstCommit)} to ${formatDay(git.lastCommit)}`}
            />
            <Stat
              value={daysBetween(git.firstCommit, git.lastCommit)}
              label="Days of work"
              note="From the first commit to the latest"
            />
          </>
        )}
      </ul>

      <div className="effort-columns">
        <div>
          <h3 className="mini-title">Checked on every push</h3>
          <ul className="check-list">
            {CI_CHECKS.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          <h3 className="mini-title">Built with</h3>
          <ul className="tag-list">
            {STACK.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mini-title">Every decision, written down</h3>
          <ol className="doc-index">
            {stats.documents.map((doc) => (
              <li key={doc.file}>
                <a href={`${REPOSITORY}/blob/main/docs/${doc.file}`}>
                  <span className="doc-number">{doc.file.slice(0, 2)}</span>
                  {doc.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

export default function OverviewPage() {
  const stats = readProjectStats();

  return (
    <>
      <SiteHeader current="overview" />
      <main className="full">
        <section className="hero" aria-labelledby="hero-heading">
          <p className="eyebrow">01 — Overview</p>
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
            {PIPELINE.map((step, index) => (
              <li
                key={step.title}
                className="pipeline-step"
                data-ai={step.who === "AI" ? "true" : undefined}
              >
                <span className="pipeline-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
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

        <section className="section" aria-labelledby="pages-heading">
          <p className="eyebrow">This dashboard</p>
          <h2 id="pages-heading" className="section-title">
            Four more pages, in the order you need them
          </h2>
          <ul className="page-cards">
            {PAGES.map((page) => (
              <li key={page.href}>
                <Link href={page.href} className="secondary">
                  <span className="page-card-number">{page.number}</span>
                  <span className="page-card-title">{page.title}</span>
                  <span className="page-card-body">{page.body}</span>
                  <span className="page-card-go" aria-hidden="true">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="section" aria-labelledby="ai-heading">
          <p className="eyebrow">How the AI is built</p>
          <h2 id="ai-heading" className="section-title">
            A small, boxed-in job, checked every time
          </h2>
          <p className="section-lead">
            The assistant is given exactly enough to choose a product, and nothing it
            could use to spend money. The instructions it gets are not the safety
            boundary: every rule in them is checked again by code after it answers.
          </p>
          <ol className="ai-grid">
            {AI_PARTS.map((part) => (
              <li key={part.label} className="ai-part">
                <span className="ai-label">{part.label}</span>
                <h3>{part.title}</h3>
                <p>{part.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {stats === null ? null : <Effort stats={stats} />}

        <section className="closing">
          <h2 className="section-title">Try it with a sentence.</h2>
          <p className="section-lead">
            Everything runs in Razorpay Test Mode. Nothing you do here can move real
            money.
          </p>
          <Link href="/shop" className="primary">
            Open the shop
          </Link>
        </section>

        <SiteFooter />
      </main>
    </>
  );
}
