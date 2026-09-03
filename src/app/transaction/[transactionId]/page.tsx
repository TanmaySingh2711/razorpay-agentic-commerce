import Link from "next/link";
import { notFound } from "next/navigation";
import { approvePurchase, rejectPurchase, reserveStock } from "@/app/actions/purchase";
import { DecisionForm } from "@/components/transaction/decision-form";
import { PayButton } from "@/components/payments/pay-button";
import { describePaymentFailure } from "@/domain/payment/failure";
import {
  awaitsProvider,
  buildJourney,
  describeState,
  formatDateTime,
  formatMoney,
  formatTime,
} from "@/domain/ui/journey";
import { loadTransactionOverview } from "@/services/transaction/overview-service";
import type { TransactionOverview } from "@/services/transaction/overview-service";

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
    return (
      <section className="card action" aria-labelledby="hold-heading">
        <h2 id="hold-heading">Hold the item</h2>
        <p>Set this item aside so it cannot be sold to someone else while you pay.</p>
        <DecisionForm
          action={reserveStock}
          transactionId={overview.transactionId}
          label="Hold it for me"
          busyLabel="Holding…"
        />
      </section>
    );
  }

  if (state === "INVENTORY_RESERVED" || state === "PAYMENT_ORDER_CREATED") {
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
    <main className="wide">
      <p className="breadcrumb">
        <Link href="/">← Start another purchase</Link>
      </p>

      <header className="page-head">
        <h1>{narrative.label}</h1>
        <p className="lead">{narrative.meaning}</p>
        {awaitsProvider(overview.state) ? (
          <p className="notice neutral" role="status">
            Waiting for the payment provider to confirm. This page does not update by
            itself — <a href="">refresh</a> in a moment to see the latest.
          </p>
        ) : null}
      </header>

      <Journey overview={overview} />
      <ActionCard overview={overview} />
      <QuoteCard overview={overview} />
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
          authentic. <code>PAYMENT_CAPTURED</code> means the provider confirmed the money.
          They are different facts and this system never treats one as the other.
        </p>
      </details>
    </main>
  );
}
