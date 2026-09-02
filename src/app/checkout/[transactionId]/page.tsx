import { PayButton } from "@/components/payments/pay-button";
import { describePaymentFailure } from "@/domain/payment/failure";
import { readRetryStatus } from "@/services/payment/retry-service";
import { MAX_PAYMENT_ATTEMPTS, type RetryDenial } from "@/domain/payment/retry";

/**
 * The checkout page for one transaction.
 *
 * It reads, and it never writes. That distinction is the whole design: a read
 * tells a person where their purchase stands, while every state change on this
 * page happens behind an explicit click and a POST. If rendering could start a
 * checkout session or a retry, `PAYMENT_PENDING` would also be reached by a
 * refresh, a prefetch or a link preview, and would stop meaning "somebody
 * pressed Pay".
 *
 * The retry status shown here is advisory. It is computed by the same
 * deterministic gate the retry request runs, so the page cannot offer a button
 * the server would refuse - and if it somehow did, nothing would happen,
 * because the button sends only a transaction id and the decision is made again
 * on arrival. The count of attempts is displayed, never enforced.
 */
export const dynamic = "force-dynamic";

/**
 * What a person is told when a retry is not available.
 *
 * Deliberately plain, and deliberately free of internals. Nobody outside this
 * codebase needs to know that a policy version changed or which control
 * refused; they need to know whether to wait, start again, or contact support.
 * The precise reason is in the audit trail, where it belongs.
 */
function explainDenial(denial: RetryDenial): string {
  switch (denial) {
    case "RETRY_LIMIT_REACHED":
      return `You have used all ${String(MAX_PAYMENT_ATTEMPTS)} payment attempts for this purchase. Nothing has been charged. Please start a new order.`;
    case "PAYMENT_ALREADY_CAPTURED":
      return "A payment for this purchase has already gone through, so there is nothing to retry.";
    case "ATTEMPT_IN_PROGRESS":
      return "A payment for this purchase is already in progress.";
    case "OUTCOME_UNRESOLVED":
      return "We are still confirming what happened to an earlier payment. Please check back shortly rather than paying again.";
    case "FINANCIAL_FACTS_CHANGED":
    case "NO_ACTIVE_QUOTE":
      return "The price or availability of this item has changed since you were quoted, so we will not charge the old amount. Please start a new order.";
    case "NOT_AUTHORIZED":
      return "This purchase is no longer authorized under your current spending settings. Please start a new order.";
    case "RESERVATION_NOT_HELD":
      return "This item is no longer being held for you. Please start a new order.";
    case "TRANSACTION_STATE_INVALID":
    case "TRANSACTION_NOT_FOUND":
      return "There is no failed payment to retry for this purchase.";
  }
}

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ transactionId: string }>;
}) {
  const { transactionId } = await params;
  const status = await readRetryStatus(transactionId);

  // Nothing to say about a transaction that does not exist, and nothing worth
  // leaking about whether it might: the ordinary page is rendered either way,
  // and pressing Pay gets a refusal from the server.
  const failed = status?.transactionState === "PAYMENT_FAILED";

  return (
    <main>
      <h1>{failed ? "That payment did not go through" : "Complete your payment"}</h1>

      {failed ? (
        <>
          <p>
            {status.lastFailure === null
              ? "Your payment was not completed and no money has been taken by us."
              : describePaymentFailure(status.lastFailure)}{" "}
            Nothing about this purchase has changed — the item, the price and the order
            are all still exactly as they were.
          </p>
          <p>
            Payment attempt {String(Math.min(status.attemptsUsed, status.maxAttempts))} of{" "}
            {String(status.maxAttempts)} used.
          </p>
          {status.available ? (
            <PayButton
              transactionId={transactionId}
              mode="RETRY"
              attemptsUsed={status.attemptsUsed}
              maxAttempts={status.maxAttempts}
            />
          ) : (
            <p role="status">
              {status.denial === null
                ? "This purchase cannot be paid again."
                : explainDenial(status.denial)}
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            The amount, the item and the order were all fixed by the server before you got
            here. Nothing on this page can change what you are charged.
          </p>
          <PayButton transactionId={transactionId} mode="PAY" />
        </>
      )}

      <p className="tagline">Razorpay Test Mode — no real money moves.</p>
    </main>
  );
}
