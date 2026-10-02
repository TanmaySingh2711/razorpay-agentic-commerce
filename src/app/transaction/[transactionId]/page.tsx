import Link from "next/link";
import { notFound } from "next/navigation";
import {
  approvePurchase,
  checkRefundStatus,
  refundPurchase,
  rejectPurchase,
  reserveStock,
} from "@/app/actions";
import { SiteHeader } from "@/components/site-header";
import { describeRefundStatus } from "@/domain/refund";
import { AwaitingProvider } from "@/components/awaiting-provider";
import { DecisionForm } from "@/components/decision-form";
import { PayButton } from "@/components/pay-button";
import { SafetyPassport } from "@/components/safety-passport";
import { describePaymentFailure } from "@/domain/payment/failure";
import {
  awaitsProvider,
  buildJourney,
  describeState,
  formatDateTime,
  formatMoney,
  formatTime,
} from "@/domain/journey";
import { loadTransactionOverview } from "@/services/transaction-overview-service";
import type { TransactionOverview } from "@/services/transaction-overview-service";

/**
 * One purchase, from the sentence that started it to the money that settled it.
 *
 * A server component, so every number on it is read fresh from the database at
 * render time. Nothing financial is held in the browser: there is no client
 * copy of the amount, the policy result or the retry budget to go stale or be
 * edited, and the only interactive parts are buttons that send a transaction id
 * to a server action.
 *
 * Dynamic on purpose. A cached render of a payment page is a picture of a
 * moment that has passed, and the whole value of this page is that it is true
 * right now.
 */
export const dynamic = "force-dynamic";

function Badge({
  tone,
  children,
}: {
  readonly tone: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <span className={`badge ${tone.toLowerCase()}`}>{children}</span>;
}

/** The progress rail. Labels are human; the exact state lives further down. */
function Journey({ overview }: { readonly overview: TransactionOverview }) {
  const steps = buildJourney(overview.state);
  return (
    <ol className="journey" aria-label="Purchase progress">
      {steps.map((step) => (
        <li key={step.step} className={`step ${step.status.toLowerCase()}`}>
          <span className="dot" aria-hidden="true" />
          <span className="step-label">{step.label}</span>
          <span className="visually-hidden">
            {step.status === "DONE"
              ? " — done"
              : step.status === "CURRENT"
                ? " — in progress"
                : step.status === "STOPPED"
                  ? " — stopped here"
                  : " — not started"}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The trusted quote, presented as the server's number rather than the
 * assistant's.
 *
 * The distinction is the point of the card, and it is stated in words: the
 * assistant suggested a product, the server decided the price. A reviewer
 * should be able to see which of those two things is authoritative without
 * reading any code.
 */
function QuoteCard({ overview }: { readonly overview: TransactionOverview }) {
  const { quote, product } = overview;
  if (quote === null || product === null) return null;

  return (
    <section className="card quote" aria-labelledby="quote-heading">
      <div className="card-head">
        <h2 id="quote-heading">Verified price</h2>
        <Badge tone={overview.quoteUsable ? "positive" : "negative"}>
          {overview.quoteUsable ? "Valid" : "No longer valid"}
        </Badge>
      </div>

      <p className="product-name">{product.name}</p>

      <dl className="facts">
        <div>
          <dt>Quantity</dt>
          <dd>{product.quantity}</dd>
        </div>
        <div>
          <dt>Unit price</dt>
          <dd>{formatMoney(product.unitAmount)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd className="total">{formatMoney(quote.totalAmount)}</dd>
        </div>
        <div>
          <dt>Price held until</dt>
          <dd>
            <time dateTime={quote.expiresAt}>{formatDateTime(quote.expiresAt)}</time>
          </dd>
        </div>
      </dl>

      {Object.keys(product.attributes).length === 0 ? null : (
        <ul className="attributes">
          {Object.entries(product.attributes).map(([key, value]) => (
            <li key={key}>
              <span className="attr-key">{key}</span>
              <span className="attr-value">{value}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="hint">
        The assistant suggested this product. This price was read from the merchant&apos;s
        own records by the server and frozen — it is the only amount that can be charged.
      </p>
    </section>
  );
}

/** Plain words for the eligibility codes the decision engine records. */
const REASON_WORDS: Readonly<Record<string, string>> = {
  MATCHES_CATEGORY: "the category you asked for",
  MATCHES_HARD_REQUIREMENTS: "every requirement you stated",
  WITHIN_BUDGET: "your budget",
  CURRENCY_MATCH: "your currency",
  IN_STOCK: "being in stock",
  SUFFICIENT_INVENTORY: "enough stock for your quantity",
};

/**
 * How the assistant chose - from the server's record, not the model's story.
 *
 * The comparison is the point: a buyer can see what else met every rule and
 * what it cost, so "why this one?" has an answer they can check. Every figure
 * is one the server counted or read from the catalog when it decided.
 */
function SelectionCard({ overview }: { readonly overview: TransactionOverview }) {
  const { selection, product } = overview;
  if (selection === null || product === null) return null;

  const checked = selection.reasons
    .map((reason) => REASON_WORDS[reason])
    .filter((words): words is string => words !== undefined);
  const chosen = BigInt(product.unitAmount.amountMinor);

  return (
    <section className="card" aria-labelledby="chose-heading">
      <div className="card-head">
        <h2 id="chose-heading">How the assistant chose</h2>
        {selection.substituted ? <Badge tone="warning">substituted</Badge> : null}
      </div>

      {selection.agent === null ? null : (
        <dl className="facts agent-facts">
          <div>
            <dt>Products looked at</dt>
            <dd>{selection.agent.productsObserved}</dd>
          </div>
          <div>
            <dt>Met every rule</dt>
            <dd>{selection.eligibleCount ?? "–"}</dd>
          </div>
          <div>
            <dt>Model calls</dt>
            <dd>{selection.agent.modelCalls}</dd>
          </div>
          <div>
            <dt>Time to decide</dt>
            <dd>{(selection.agent.durationMs / 1000).toFixed(1)}s</dd>
          </div>
        </dl>
      )}

      {checked.length === 0 ? null : (
        <p>
          The server checked this product against {checked.join(", ")} before pricing it.
        </p>
      )}
      {selection.substituted ? (
        <p className="hint">
          The product the assistant proposed was out of stock, so the server chose the
          closest in-stock product that meets the same rules.
        </p>
      ) : null}

      {selection.alternatives.length === 0 ? (
        <p className="hint">
          No other product met every rule, so this was the only option.
        </p>
      ) : (
        <>
          <h3 className="subhead">Also met every rule</h3>
          <ul className="alternatives">
            {selection.alternatives.map((alternative, index) => {
              const difference = BigInt(alternative.unitAmount.amountMinor) - chosen;
              const magnitude = formatMoney({
                amountMinor: (difference < 0n ? -difference : difference).toString(),
                currency: alternative.unitAmount.currency,
              });
              return (
                <li key={`${String(index)}-${alternative.name}`}>
                  <span className="alt-name">{alternative.name}</span>
                  <span className="alt-price">{formatMoney(alternative.unitAmount)}</span>
                  <span className="hint">
                    {difference === 0n
                      ? "same price"
                      : `${magnitude} ${difference > 0n ? "more" : "less"}`}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="hint">
            Prices as the catalog stated them when the choice was made. The assistant
            weighed your preferences between these; the server only allowed candidates
            that passed every rule.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Money going back. Offered only once the purchase completed, and only ever
 * as a transaction id sent to a server action - the amount is the captured
 * one, decided by the refund service.
 */
function RefundCard({ overview }: { readonly overview: TransactionOverview }) {
  if (overview.state !== "COMPLETED") return null;
  const { refund } = overview;

  if (refund === null || refund.status === "FAILED") {
    return (
      <section className="card action" aria-labelledby="refund-heading">
        <h2 id="refund-heading">Changed your mind?</h2>
        {refund?.status === "FAILED" ? (
          <p className="field-error">{describeRefundStatus("FAILED")}</p>
        ) : null}
        <p>
          You can refund this purchase in full to the original payment method. The amount
          is the one that was captured - it cannot be changed here.
        </p>
        <DecisionForm
          action={refundPurchase}
          transactionId={overview.transactionId}
          label="Refund this purchase"
          busyLabel="Requesting refund…"
          variant="secondary"
        />
      </section>
    );
  }

  const open = refund.status !== "PROCESSED";
  return (
    <section className="card" aria-labelledby="refund-heading">
      <div className="card-head">
        <h2 id="refund-heading">Refund</h2>
        <Badge tone={refund.status === "PROCESSED" ? "positive" : "warning"}>
          {refund.status.replace(/_/g, " ").toLowerCase()}
        </Badge>
      </div>
      <p>{describeRefundStatus(refund.status)}</p>
      <dl className="facts">
        <div>
          <dt>Amount</dt>
          <dd className="total">{formatMoney(refund.amount)}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>
            <time dateTime={refund.requestedAt}>
              {formatDateTime(refund.requestedAt)}
            </time>
          </dd>
        </div>
      </dl>
      {open ? (
        <DecisionForm
          action={checkRefundStatus}
          transactionId={overview.transactionId}
          label="Check refund status"
          busyLabel="Checking…"
          variant="secondary"
        />
      ) : null}
    </section>
  );
}

/** Policy, in the three shapes it can take. */
function PolicyCard({ overview }: { readonly overview: TransactionOverview }) {
  const { policy } = overview;
  if (policy === null) return null;

  const tone =
    policy.decision === "ALLOWED"
      ? "positive"
      : policy.decision === "APPROVAL_REQUIRED"
        ? "warning"
        : "negative";

  const sentence =
    policy.decision === "ALLOWED"
      ? "Your spending rules allow this purchase without asking you first."
      : policy.decision === "APPROVAL_REQUIRED"
        ? "This purchase is above the amount that can be spent without asking, so it needs your approval."
        : "Your spending rules do not permit this purchase. Nothing has been charged.";

  return (
    <section className="card" aria-labelledby="policy-heading">
      <div className="card-head">
        <h2 id="policy-heading">Spending rules</h2>
        <Badge tone={tone}>{policy.decision.replace(/_/g, " ").toLowerCase()}</Badge>
      </div>
      <p>{sentence}</p>
      {policy.autoApproveLimit === null ||
      policy.autoApproveLimit.amountMinor === "0" ? null : (
        <p className="hint">
          Purchases up to {formatMoney(policy.autoApproveLimit)} do not need approval.
        </p>
      )}
    </section>
  );
}

/** Whatever the item's hold currently is, said plainly. */
function InventoryCard({ overview }: { readonly overview: TransactionOverview }) {
  if (overview.reservationStatus === null) return null;

  const sentences: Readonly<Record<string, string>> = {
    ACTIVE: "This item is held for you while you pay.",
    RELEASED: "The hold on this item has been released.",
    COMMITTED: "This item has been taken out of stock for you.",
    EXPIRED: "The hold on this item ran out before payment completed.",
  };

  return (
    <section className="card" aria-labelledby="stock-heading">
      <div className="card-head">
        <h2 id="stock-heading">Availability</h2>
        <Badge tone={overview.reservationStatus === "ACTIVE" ? "positive" : "neutral"}>
          {overview.reservationStatus.toLowerCase()}
        </Badge>
      </div>
      <p>
        {sentences[overview.reservationStatus] ?? "The hold on this item has changed."}
      </p>
      {overview.reservationStatus === "ACTIVE" &&
      overview.reservationExpiresAt !== null ? (
        <p className="hint">
          Held until{" "}
          <time dateTime={overview.reservationExpiresAt}>
            {formatDateTime(overview.reservationExpiresAt)}
          </time>
          .
        </p>
      ) : null}
    </section>
  );
}

/**
 * The one card that offers an action.
 *
 * Which action appears is decided entirely by state the server computed. In
 * particular the retry button is shown only when `retry.available` is true —
 * a value read from persisted attempts — and the page never works out for
 * itself whether a retry is allowed.
 */
function ActionCard({ overview }: { readonly overview: TransactionOverview }) {
  const { state, retry } = overview;

  if (state === "APPROVAL_REQUIRED") {
    return (
      <section className="card action" aria-labelledby="decide-heading">
        <h2 id="decide-heading">Your decision</h2>
        <p>
          Approving authorizes this exact amount for this purchase only. Rejecting ends it
          and charges nothing.
        </p>
        <div className="button-row">
          <DecisionForm
            action={approvePurchase}
            transactionId={overview.transactionId}
            label="Approve this purchase"
            busyLabel="Approving…"
          />
          <DecisionForm
            action={rejectPurchase}
            transactionId={overview.transactionId}
            label="Reject"
            busyLabel="Rejecting…"
            variant="secondary"
          />
        </div>
      </section>
    );
  }

  if (state === "AUTHORIZED") {
    // Ordinarily AUTHORIZED means nothing is held yet. The exception is a
    // controlled retry whose stale quote was just replaced and re-approved:
    // it lands back here with its *original* hold still ACTIVE, only rebound
    // to the fresh price - `reserveStock` would try to claim a second one, so
    // the card must not offer it in that case.
    if (overview.reservationHeld) {
      return (
        <section className="card action" aria-labelledby="pay-heading">
          <h2 id="pay-heading">Payment</h2>
          <p>The new price for this purchase was approved. Press Pay to continue.</p>
          <PayButton transactionId={overview.transactionId} mode="RETRY" />
        </section>
      );
    }
    return (
      <section className="card action" aria-labelledby="hold-heading">
        <h2 id="hold-heading">Hold the item</h2>
        <p>Set this item aside so it cannot be sold to someone else while you pay.</p>
        <DecisionForm
          action={reserveStock}
          transactionId={overview.transactionId}
          label="Hold it for me"
          busyLabel="Holding…"
          recoveryHref="/"
          recoveryLabel="Start a new purchase"
        />
      </section>
    );
  }

  if (state === "INVENTORY_RESERVED" || state === "PAYMENT_ORDER_CREATED") {
    // Pressing Pay from INVENTORY_RESERVED now prepares the Razorpay order
    // itself before starting checkout (see PayButton), so that step is legal
    // exactly when the stock hold is still genuinely active -
    // `overview.reservationHeld`, computed server-side against the same clock
    // `createPaymentOrder` and `startCheckout` will judge it by, rather than by
    // this page reading its own. The quote only still needs to be valid before
    // an order is created; once one exists, its amount is already fixed and
    // the quote's later fate no longer decides whether checkout may start.
    const paymentPreparable =
      overview.reservationHeld &&
      (state === "PAYMENT_ORDER_CREATED" || overview.quoteUsable);

    if (!paymentPreparable) {
      return (
        <section className="card action" aria-labelledby="pay-heading">
          <h2 id="pay-heading">Payment</h2>
          <p role="status" className="field-error">
            This item is no longer held for you, or its price is no longer valid. Start a
            new purchase to try again.
          </p>
        </section>
      );
    }

    return (
      <section className="card action" aria-labelledby="pay-heading">
        <h2 id="pay-heading">Payment</h2>
        <p>
          Razorpay Test Mode. No real money moves, and nothing is charged until you
          complete the payment yourself.
        </p>
        <PayButton transactionId={overview.transactionId} mode="PAY" />
      </section>
    );
  }

  if (state === "PAYMENT_FAILED" && retry !== null) {
    return (
      <section className="card action" aria-labelledby="retry-heading">
        <h2 id="retry-heading">Try again</h2>
        <p>
          {retry.lastFailure === null
            ? "The payment did not complete and nothing was charged."
            : describePaymentFailure(retry.lastFailure)}
        </p>
        <p className="hint">
          Payment attempt {Math.min(retry.attemptsUsed, retry.maxAttempts)} of{" "}
          {retry.maxAttempts} used.
        </p>
        {retry.available ? (
          <PayButton
            transactionId={overview.transactionId}
            mode="RETRY"
            attemptsUsed={retry.attemptsUsed}
            maxAttempts={retry.maxAttempts}
          />
        ) : (
          <p role="status" className="field-error">
            {retry.remaining === 0
              ? "You have used every payment attempt for this purchase. Start a new purchase to try again."
              : "This purchase cannot be paid again right now."}
          </p>
        )}
      </section>
    );
  }

  return null;
}

/** The factual history, from the audit trail and the state machine. */
function Timeline({ overview }: { readonly overview: TransactionOverview }) {
  if (overview.timeline.length === 0) return null;
  return (
    <section className="card" aria-labelledby="history-heading">
      <h2 id="history-heading">What happened</h2>
      <ol className="timeline">
        {overview.timeline.map((entry, index) => (
          <li key={`${entry.source}-${String(index)}`}>
            <time dateTime={new Date(entry.occurredAt).toISOString()}>
              {formatTime(entry.occurredAt)}
            </time>
            <div>
              <p className="event">{entry.conciseExplanation}</p>
              <p className="hint">
                {entry.source === "STATE_TRANSITION" ? "Lifecycle" : "Decision"} ·{" "}
                {entry.reasonCode}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default async function TransactionPage({
  params,
}: {
  params: Promise<{ transactionId: string }>;
}) {
  const { transactionId } = await params;
  const overview = await loadTransactionOverview(transactionId);
  if (overview === null) notFound();

  const narrative = describeState(overview.state);

  return (
    <>
      <SiteHeader current={null} />
      <main className="wide">
        <p className="breadcrumb">
          <Link href="/" className="secondary">
            ← Start another purchase
          </Link>
        </p>

        <header className="page-head">
          <h1>{narrative.label}</h1>
          <p className="lead">{narrative.meaning}</p>
          {awaitsProvider(overview.state) ? <AwaitingProvider /> : null}
        </header>

        <Journey overview={overview} />
        <ActionCard overview={overview} />
        <RefundCard overview={overview} />
        <QuoteCard overview={overview} />
        <SelectionCard overview={overview} />
        {/* Right after the facts it vouches for: the thirty-second answer to
          "why was this allowed?", ahead of the detail cards below it. */}
        <SafetyPassport passport={overview.passport} />
        <PolicyCard overview={overview} />
        <InventoryCard overview={overview} />
        <Timeline overview={overview} />

        <details className="technical">
          <summary>Technical detail</summary>
          <dl className="facts">
            <div>
              <dt>Transaction state</dt>
              <dd>
                <code>{overview.state}</code>
              </dd>
            </div>
            <div>
              <dt>Transaction id</dt>
              <dd>
                <code>{overview.transactionId}</code>
              </dd>
            </div>
            {overview.policy === null ? null : (
              <div>
                <dt>Policy reason code</dt>
                <dd>
                  <code>{overview.policy.reasonCode}</code>
                </dd>
              </div>
            )}
          </dl>
          <p className="hint">
            <code>PAYMENT_VERIFIED</code> means the browser&apos;s confirmation was
            authentic. <code>PAYMENT_CAPTURED</code> means the provider confirmed the
            money. They are different facts and this system never treats one as the other.
          </p>
        </details>
      </main>
    </>
  );
}
