import type { MoneyDto } from "@/domain/money";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { PaymentFailureCategory } from "@/domain/payment/failure";
import type { TransactionState } from "@/domain/transaction/states";

/**
 * Retrying a failed payment, as a bounded deterministic decision.
 *
 * A failed payment is an ordinary outcome, not an emergency. What makes it
 * dangerous is the obvious response to it: try again. A system that retries
 * because a webhook said "failed", because a page reloaded, or because a model
 * suggested it, is a system that charges people twice - so every rule in this
 * file exists to make a retry something a *person* asks for and a *server*
 * grants, exactly as many times as it decided in advance.
 *
 * Three properties are load-bearing, and each one is a value here rather than a
 * convention somewhere else:
 *
 *  - **Bounded.** `MAX_PAYMENT_ATTEMPTS` is one number, counted from persisted
 *    PaymentAttempt rows. Nothing a browser, a request body or a model produces
 *    is an input to that count.
 *  - **Explained.** Every refusal is one of `RETRY_DENIALS` - a closed
 *    vocabulary, safe to return to a browser, precise enough for an operator.
 *  - **Re-derived.** Being authorized once is not being authorized now. A retry
 *    re-reads the quote, re-runs the policy and re-checks the stock hold before
 *    it is allowed to touch the provider.
 *
 * There is deliberately nothing in this file about *automatic* retry. No
 * backoff, no schedule, no queue. The only trigger is a human action.
 */

/**
 * The total number of payment attempts one transaction may ever have.
 *
 * One initial attempt plus at most two retries. Chosen rather than derived:
 * three is enough to survive the ordinary causes of a declined payment - a
 * wrong card, a failed 3-D Secure challenge, a bank timeout - and small enough
 * that a person who is genuinely unable to pay is told so instead of being left
 * to hammer a button.
 *
 * Counted from rows in `payment_attempt`, never from anything a caller sends.
 * That is what makes it impossible to raise: there is no `retryCount` field on
 * any request in this system, so there is nothing to tamper with.
 */
export const MAX_PAYMENT_ATTEMPTS = 3;

/**
 * Why a retry was refused.
 *
 * Enumerated rather than collapsed into a boolean because these are genuinely
 * different situations for the person reading them. "You have used all three
 * attempts" and "the price of this item changed" both mean *no*, but only one
 * of them is worth starting a new purchase over.
 */
export const RETRY_DENIALS = [
  /** No such transaction. */
  "TRANSACTION_NOT_FOUND",
  /** Not at PAYMENT_FAILED. There is no failed payment here to retry. */
  "TRANSACTION_STATE_INVALID",
  /** The provider already captured a payment for this purchase. */
  "PAYMENT_ALREADY_CAPTURED",
  /** Every permitted attempt has been used. */
  "RETRY_LIMIT_REACHED",
  /** A payment attempt is still live. Retrying now would be a second one. */
  "ATTEMPT_IN_PROGRESS",
  /**
   * Some attempt's provider outcome was never resolved.
   *
   * The strictest denial in the list. An unresolved attempt may correspond to a
   * real order at the provider that this database never finished recording, and
   * the one thing that must never happen to it is another order - it is
   * resolved by looking its receipt up, which is Objective 10's rule and
   * outranks any retry policy.
   */
  "OUTCOME_UNRESOLVED",
  /** No live quote, so there is no amount to charge. */
  "NO_ACTIVE_QUOTE",
  /**
   * The financial facts moved: the price, the currency, the product version or
   * the quote's own validity window. The old amount is no longer offered and
   * this system will not invent a new one behind a person's back.
   */
  "FINANCIAL_FACTS_CHANGED",
  /** Re-run against today's policy and today's approvals, this is not authorized. */
  "NOT_AUTHORIZED",
  /** No live stock hold backs this purchase any more. */
  "RESERVATION_NOT_HELD",
] as const;

export type RetryDenial = (typeof RETRY_DENIALS)[number];

/**
 * Denials after which nothing further can happen to this purchase.
 *
 * The distinction decides whether held stock is given back. `FINANCIAL_FACTS_CHANGED`
 * now covers two situations, and both end the workflow the same way: an old
 * quote that lapsed with no reservation left to save it, and - the newer case -
 * a stale quote whose replacement was attempted and itself refused, because the
 * product is no longer sold, its currency changed, or today's policy blocks it
 * outright. A retry gets exactly one chance to re-quote; when that chance is
 * refused there is nothing left to hold stock for. `RETRY_LIMIT_REACHED` and an
 * authorization that no longer holds are permanent for the same reason.
 *
 * Everything else is deliberately excluded. `ATTEMPT_IN_PROGRESS` means somebody
 * is mid-payment; `OUTCOME_UNRESOLVED` means we do not know what happened yet.
 * Releasing stock under either would be a guess, and the reservation's own
 * expiry already handles abandonment safely. Nor does reaching
 * `APPROVAL_REQUIRED` release anything - the purchase is not over, it is
 * waiting on a person, exactly as a first purchase above the ceiling does.
 */
const WORKFLOW_ENDING_DENIALS: readonly RetryDenial[] = [
  "RETRY_LIMIT_REACHED",
  "FINANCIAL_FACTS_CHANGED",
  "NOT_AUTHORIZED",
  "NO_ACTIVE_QUOTE",
];

export function endsWorkflow(denial: RetryDenial): boolean {
  return WORKFLOW_ENDING_DENIALS.includes(denial);
}

/**
 * How many attempts remain, given how many rows exist.
 *
 * Clamped at zero rather than allowed to go negative: a transaction that
 * somehow holds more attempts than the limit is a defect, and reporting "-1
 * remaining" would invite a caller to do arithmetic on it. The eligibility gate
 * refuses in that case anyway.
 */
export function remainingAttempts(attemptsUsed: number): number {
  return Math.max(0, MAX_PAYMENT_ATTEMPTS - attemptsUsed);
}

/** True when the persisted attempt count still permits one more. */
export function withinAttemptLimit(attemptsUsed: number): boolean {
  return attemptsUsed < MAX_PAYMENT_ATTEMPTS;
}

// ---------------------------------------------------------------------------
// The provider order rule
// ---------------------------------------------------------------------------

/**
 * Whether a retry may present the provider order the failed attempt used.
 *
 * **It may not.** Every retry creates a new provider order, and this constant
 * exists so that rule is a value the tests can assert rather than a sentence in
 * a comment somebody later disagrees with.
 *
 * Razorpay's own documentation permits the other choice: an order moves from
 * `created` to `attempted` when a payment is first tried on it, several
 * payments may be attempted against one order id, and it only reaches `paid`
 * once a payment is captured - so reusing an order after a decline is, on the
 * provider's side, legal. Two facts about *this* system make it wrong anyway.
 *
 * **Correlation would stop being decidable.** Both inbound channels - the
 * checkout callback and the webhook - find the internal PaymentAttempt from the
 * provider order id we stored. That works because the mapping is one to one,
 * and `@@unique([provider, providerOrderId])` on `payment_attempt` makes the
 * database enforce it. Share one order between two attempts and a late
 * `payment.captured` for the first attempt becomes indistinguishable from one
 * for the second - which is precisely the confusion that lets a payment be
 * credited to the wrong attempt.
 *
 * **The receipt is derived from the attempt.** It is Razorpay's idempotency key
 * for order creation and it is a function of the PaymentAttempt id, so a new
 * attempt necessarily carries a new receipt. Reuse would mean either abandoning
 * that derivation or creating an attempt that cannot claim its own order.
 *
 * The cost is one extra order object per retry, bounded by
 * `MAX_PAYMENT_ATTEMPTS`. Razorpay does not charge for orders, and an
 * un-attempted order simply stays `created`.
 */
export const RETRY_REUSES_PROVIDER_ORDER = false;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * What the deterministic gate concluded, before anything external happened.
 *
 * The ELIGIBLE arm carries every fact the payment path will need, all of them
 * re-read during the check itself. Nothing downstream re-derives an amount or
 * re-reads a policy from a different moment in time.
 *
 * The REQUOTE_ELIGIBLE arm is deliberately thinner: an amount, a policy
 * version and an approval binding cannot be named yet, because the one thing
 * this gate has established is that the *old* ones no longer apply. What it
 * has confirmed is that a retry is otherwise permitted and that the original
 * stock hold is still `ACTIVE` and unexpired for this exact product and
 * quantity - which is what makes re-quoting *this* transaction, rather than
 * refusing it outright, the honest answer.
 */
export type RetryEligibility =
  | {
      readonly kind: "ELIGIBLE";
      readonly transactionId: string;
      /** Read while the gate loaded the transaction, so callers need no second query. */
      readonly correlationId: string | null;
      readonly quoteId: string;
      readonly reservationId: string;
      /** The number the new PaymentAttempt will carry. Always `attemptsUsed + 1`. */
      readonly nextAttemptNumber: number;
      readonly attemptsUsed: number;
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly policyVersion: number | null;
      readonly policyDecision: string;
      /** Set when a scoped human approval supplied the authority. */
      readonly approvalId: string | null;
    }
  | {
      readonly kind: "REQUOTE_ELIGIBLE";
      readonly transactionId: string;
      readonly correlationId: string | null;
      readonly attemptsUsed: number;
      readonly nextAttemptNumber: number;
      /** The still-held reservation's own facts - the only ones left to trust. */
      readonly reservationId: string;
      readonly productId: string;
      readonly quantity: number;
    }
  | {
      readonly kind: "DENIED";
      readonly transactionId: string;
      readonly correlationId: string | null;
      readonly denial: RetryDenial;
      readonly attemptsUsed: number;
      /** Structured, safe context. Never SQL, never a provider message. */
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
      /** Present when a quote stopped being usable, naming exactly why. */
      readonly reasons: readonly QuoteInvalidationReason[];
      /** True when held stock should be, or has been, given back. */
      readonly workflowEnded: boolean;
    };

/**
 * What a retry request answers with.
 *
 * `RETRY_STARTED` deliberately does not say "paid" or even "paying". It says a
 * new attempt exists and a person may now open checkout against it - the same
 * distinction the rest of this system draws between authorizing a payment and
 * observing one.
 */
export type PaymentRetryResult =
  | {
      readonly kind: "RETRY_STARTED";
      readonly transactionId: string;
      readonly paymentAttemptId: string;
      readonly attemptNumber: number;
      readonly attemptsUsed: number;
      readonly maxAttempts: number;
      readonly amount: MoneyDto;
      readonly transactionState: TransactionState;
      /** True when this request converged on a retry another request had started. */
      readonly replayed: boolean;
    }
  | {
      readonly kind: "DENIED";
      readonly transactionId: string;
      readonly denial: RetryDenial;
      readonly attemptsUsed: number;
      readonly maxAttempts: number;
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
      readonly reasons: readonly QuoteInvalidationReason[];
      /** True when held stock was released because nothing further can happen. */
      readonly reservationReleased: boolean;
    }
  | {
      /**
       * The stale quote was replaced and re-run through policy, and the fresh
       * facts now require a person's approval before this retry may proceed.
       *
       * Not a denial: the purchase is not over, and held stock is left exactly
       * where it was. It is also not `RETRY_STARTED`: no PaymentAttempt exists
       * yet, and none will until a fresh, exactly-scoped approval is granted -
       * the same rule Objective 8 applies to a first purchase, applied here to
       * a retry that discovered the price had moved.
       */
      readonly kind: "APPROVAL_REQUIRED";
      readonly transactionId: string;
      readonly attemptsUsed: number;
      readonly maxAttempts: number;
      /** The fresh amount a person is now being asked to approve. */
      readonly amount: MoneyDto;
    }
  | {
      /**
       * The gate passed but the provider path did not finish cleanly.
       *
       * Passed straight through from the payment-order boundary so its careful
       * distinctions survive: a definite provider failure, an unresolved
       * outcome that must be reconciled rather than retried, and a claim
       * another request already owns are three different things, and a retry
       * caller must not flatten them into "try again".
       */
      readonly kind: "ORDER_NOT_READY";
      readonly transactionId: string;
      readonly attemptsUsed: number;
      readonly maxAttempts: number;
      /** The payment-order outcome's own discriminator. */
      readonly reason:
        | "PROVIDER_FAILED"
        | "RECONCILIATION_REQUIRED"
        | "CREATION_IN_PROGRESS"
        | "REFUSED";
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    };

/**
 * What the checkout page is told about retrying, before anyone clicks anything.
 *
 * Everything here is computed server-side from persisted rows. The browser
 * renders it; it never enforces it. A page that lied about `available` would
 * only cause the server to refuse a moment later, which is the correct way
 * round for a control that decides whether money can move.
 */
export interface RetryStatusDto {
  readonly transactionId: string;
  readonly transactionState: TransactionState;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly remaining: number;
  /** True only when a retry request made right now would be granted. */
  readonly available: boolean;
  /** Why not, when it is not. Safe to show a person. */
  readonly denial: RetryDenial | null;
  /**
   * How the most recent attempt failed, as a safe closed category.
   *
   * Present so the page can say *why* the payment did not go through rather
   * than only that it did not - "the bank declined this" and "the payment
   * service could not be reached" call for different actions from the buyer.
   * Null when nothing has failed yet, or when the failure predates
   * classification.
   */
  readonly lastFailure: PaymentFailureCategory | null;
}
