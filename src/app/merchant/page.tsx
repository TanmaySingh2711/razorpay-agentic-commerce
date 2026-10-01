import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { describeState, formatDateTime, formatMoney } from "@/domain/ui/journey";
import { rate } from "@/domain/insights/metrics";
import { loadMerchantInsights } from "@/services/insights/merchant-insights-service";
import type { MerchantInsights } from "@/services/insights/merchant-insights-service";

/**
 * The merchant's side of agentic commerce.
 *
 * The shopper's page answers "was this purchase safe?". This one answers the
 * merchant's questions: how many people asked the assistant for something,
 * how many of them paid, what they wanted that this shop does not sell, and
 * what the safety controls cost or saved.
 *
 * Read-only and aggregate. It shows counts, amounts and product names - never
 * a buyer, a transaction id or anything a shopper typed - because this demo
 * has no merchant login and the page is public. Every figure comes from
 * `loadMerchantInsights`, which reads persisted facts only.
 *
 * Dynamic: a cached dashboard is a picture of a moment that has passed.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Merchant insights — Razorpay Agentic Commerce",
  description:
    "What shoppers asked the AI assistant for, what converted, and what the merchant could stock or price differently.",
};

const inr = (amountMinor: bigint): string =>
  formatMoney({ amountMinor: amountMinor.toString(), currency: "INR" });

const seconds = (ms: number | null): string =>
  ms === null ? "–" : `${(ms / 1000).toFixed(1)}s`;

const percent = (value: number | null): string =>
  value === null ? "–" : `${String(value)}%`;

/** "3 follow-up answers ...; 2 of them became purchases." with the grammar right. */
function followUpSentence(followUps: number, converted: number): string {
  const answers = followUps === 1 ? "follow-up answer" : "follow-up answers";
  const became = converted === 1 ? "became a purchase" : "became purchases";
  return `${String(followUps)} ${answers} to a clarifying question; ${String(converted)} of them ${became}.`;
}

function StatTile({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | undefined;
}) {
  return (
    <div className="stat-tile">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {note === undefined ? null : <p className="hint">{note}</p>}
    </div>
  );
}

interface Bar {
  readonly label: string;
  readonly value: number;
  /** What the tip of the bar says; defaults to the value. */
  readonly display?: string;
}

/**
 * A single-series horizontal bar list.
 *
 * One hue (the accent), so no legend: the section heading names what is
 * plotted. Every bar carries its value at the tip and in its tooltip, and the
 * list itself is the table view - label and number are real text, readable
 * without the bars at all. Bars never shrink to nothing: a zero is drawn as a
 * hairline so "none" still reads as a measured value.
 */
function BarList({
  bars,
  label,
}: {
  readonly bars: readonly Bar[];
  readonly label: string;
}) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <ul className="bar-list" aria-label={label}>
      {bars.map((bar) => {
        const display = bar.display ?? String(bar.value);
        return (
          <li key={bar.label} title={`${bar.label}: ${display}`}>
            <span className="bar-label">{bar.label}</span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: `${String(Math.max(0.5, (bar.value / max) * 100))}%` }}
              />
            </span>
            <span className="bar-value">{display}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Funnel({ insights }: { readonly insights: MerchantInsights }) {
  return (
    <section className="card" aria-labelledby="funnel-heading">
      <h2 id="funnel-heading">From a sentence to settled money</h2>
      <BarList
        label="Purchase funnel"
        bars={insights.funnel.map((stage) => ({
          label: stage.label,
          value: stage.count,
          display:
            stage.ofTotal === null
              ? String(stage.count)
              : `${String(stage.count)} · ${String(stage.ofTotal)}%`,
        }))}
      />
      <p className="hint">
        Each stage as a share of everyone who asked. &ldquo;Got a verified price&rdquo;
        means the server re-read the price and stock and froze a quote - the assistant
        alone never gets a request this far.
      </p>
    </section>
  );
}

const OUTCOME_LABELS: Readonly<Record<keyof MerchantInsights["outcomes"], string>> = {
  PURCHASE_OPENED: "Became a purchase",
  CLARIFICATION: "Needed one more detail",
  NO_MATCH: "Nothing matched",
  NOT_A_PURCHASE: "Just browsing",
  REFUSED: "Refused by the server",
  ERROR: "Could not complete",
  RATE_LIMITED: "Turned away by rate limits",
};

function UnmetDemandCard({ insights }: { readonly insights: MerchantInsights }) {
  return (
    <section className="card" aria-labelledby="demand-heading">
      <h2 id="demand-heading">Demand you did not capture</h2>
      {insights.unmet.length === 0 ? (
        <p className="hint">
          No unmatched requests yet. When shoppers ask for something this catalog cannot
          sell, it appears here - grouped by what they asked for, never by who.
        </p>
      ) : (
        <ul className="insight-list">
          {insights.unmet.map((demand) => (
            <li key={demand.category}>
              <p className="insight-head">
                <strong>{demand.category}</strong>
                <span className="badge neutral">
                  {demand.requests} {demand.requests === 1 ? "request" : "requests"}
                </span>
              </p>
              <p className="hint">
                {!demand.soldHere
                  ? "Not in your catalog. Shoppers asked for it and left with nothing."
                  : demand.belowCheapest > 0 && demand.cheapestMinor !== null
                    ? `${String(demand.belowCheapest)} wanted to spend less than your cheapest (${inr(demand.cheapestMinor)})${
                        demand.medianBudgetMinor === null
                          ? "."
                          : `; the typical budget was ${inr(demand.medianBudgetMinor)}.`
                      }`
                    : "Sold here, but nothing in stock met every stated requirement."}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PolicyCard({ insights }: { readonly insights: MerchantInsights }) {
  const { policy } = insights;
  return (
    <section className="card" aria-labelledby="rules-heading">
      <h2 id="rules-heading">What the spending rules did</h2>
      <BarList
        label="Spending rule outcomes"
        bars={[
          { label: "Allowed automatically", value: policy.autoApproved },
          { label: "Asked the buyer first", value: policy.approvalRequired },
          { label: "Buyer approved", value: policy.approved },
          { label: "Buyer rejected", value: policy.rejected },
          { label: "Blocked by a rule", value: policy.blocked },
        ]}
      />
      <p className="hint">
        Deterministic rules decided every one of these. No purchase above the buyer&apos;s
        automatic limit reached payment without a person saying yes.
      </p>
    </section>
  );
}

function RecoveryCard({ insights }: { readonly insights: MerchantInsights }) {
  const { recovery } = insights;
  return (
    <section className="card" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Payments recovered by retry</h2>
      <div className="stat-row">
        <StatTile
          label="Purchases with a failed payment"
          value={String(recovery.withFailure)}
        />
        <StatTile
          label="Paid on a later attempt"
          value={String(recovery.recovered)}
          note={
            recovery.withFailure === 0
              ? undefined
              : `${percent(rate(recovery.recovered, recovery.withFailure))} recovered`
          }
        />
        <StatTile label="Revenue recovered" value={inr(recovery.recoveredMinor)} />
      </div>
      <p className="hint">
        A declined payment is not a lost sale: the buyer may retry, up to three attempts,
        against the same verified price - never automatically, never silently.
      </p>
    </section>
  );
}

function TopProducts({ insights }: { readonly insights: MerchantInsights }) {
  if (insights.topProducts.length === 0) return null;
  return (
    <section className="card" aria-labelledby="top-heading">
      <h2 id="top-heading">Best sellers through the assistant</h2>
      <BarList
        label="Revenue by product"
        bars={insights.topProducts.map((product) => ({
          label: product.name,
          value: Number(product.revenueMinor),
          display: `${inr(product.revenueMinor)} · ${String(product.orders)} ${
            product.orders === 1 ? "order" : "orders"
          }`,
        }))}
      />
    </section>
  );
}

function RecentOrders({ insights }: { readonly insights: MerchantInsights }) {
  if (insights.recent.length === 0) return null;
  return (
    <section className="card" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent purchases</h2>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col" className="numeric">
                Amount
              </th>
              <th scope="col">Status</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {insights.recent.map((order) => (
              <tr key={`${order.createdAt}-${order.productName}`}>
                <td>{order.productName}</td>
                <td className="numeric">
                  {order.amountMinor === null ? "–" : inr(order.amountMinor)}
                </td>
                <td>
                  {order.refund === "PROCESSED"
                    ? "Refunded"
                    : describeState(order.state).label}
                </td>
                <td>
                  <time dateTime={order.createdAt}>
                    {formatDateTime(order.createdAt)}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Shown without buyer details or purchase links: this demo has no merchant login, so
        the page shows only what a storefront would.
      </p>
    </section>
  );
}

export default async function MerchantPage() {
  const insights = await loadMerchantInsights();

  return (
    <>
      <SiteHeader current="merchant" />
      <main className="wide">
        <header className="page-head">
          <h1>Merchant insights</h1>
          <p className="lead">
            What shoppers asked the AI assistant for, what turned into paid orders, and
            what you could stock or price differently to sell more.
          </p>
        </header>

        {insights === null ? (
          <div className="notice neutral" role="status">
            <strong>No merchant yet</strong>
            <p>The catalog has not been seeded. Run the setup and come back.</p>
          </div>
        ) : (
          <>
            <p className="hint">
              {insights.merchantName} · last {insights.windowDays} days · updated{" "}
              <time dateTime={insights.generatedAt}>
                {formatDateTime(insights.generatedAt)}
              </time>
            </p>

            <div className="stat-row hero-row">
              <StatTile
                label="Net revenue"
                value={inr(insights.revenue.netMinor)}
                note={
                  insights.revenue.refundedMinor > 0n
                    ? `${inr(insights.revenue.capturedMinor)} captured, ${inr(insights.revenue.refundedMinor)} refunded`
                    : "Captured payments, less refunds"
                }
              />
              <StatTile
                label="Paid orders"
                value={String(insights.revenue.paidOrders)}
                note={
                  insights.revenue.averageOrderMinor === null
                    ? undefined
                    : `${inr(insights.revenue.averageOrderMinor)} average`
                }
              />
              <StatTile
                label="Asked → paid"
                value={percent(insights.funnel.at(-1)?.ofTotal ?? null)}
                note={`${String(insights.agent.requests)} assistant requests`}
              />
              <StatTile
                label="Time to a verified price"
                value={seconds(insights.agent.medianMs)}
                note={`median · p90 ${seconds(insights.agent.p90Ms)}${
                  insights.agent.averageModelCalls === null
                    ? ""
                    : ` · ${String(insights.agent.averageModelCalls)} model calls`
                }`}
              />
            </div>

            <Funnel insights={insights} />
            <UnmetDemandCard insights={insights} />

            <section className="card" aria-labelledby="outcomes-heading">
              <h2 id="outcomes-heading">How assistant requests ended</h2>
              <BarList
                label="Assistant request outcomes"
                bars={Object.entries(insights.outcomes).map(([outcome, count]) => ({
                  label: OUTCOME_LABELS[outcome as keyof MerchantInsights["outcomes"]],
                  value: count,
                }))}
              />
              <p className="hint">
                {insights.agent.followUps === 0
                  ? "When the assistant needs one more detail, the shopper answers in the same conversation - those follow-ups are counted here."
                  : followUpSentence(
                      insights.agent.followUps,
                      insights.agent.followUpsConverted,
                    )}
              </p>
            </section>

            <PolicyCard insights={insights} />
            <RecoveryCard insights={insights} />
            <TopProducts insights={insights} />
            <RecentOrders insights={insights} />
          </>
        )}

        <p className="cta-row">
          <Link href="/" className="secondary">
            Back to the shop
          </Link>
        </p>
      </main>
    </>
  );
}
