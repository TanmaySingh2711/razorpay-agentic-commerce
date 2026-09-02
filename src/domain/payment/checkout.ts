import type { MoneyDto } from "@/domain/money";
import type { TransactionState } from "@/domain/transaction/states";

/**
 * Checkout: the one place a person, not a program, decides to spend money.
 *
 * Everything upstream of here was the system deciding what *may* happen. This
 * is where a human presses a button, and the contract is shaped around two
 * facts that follow from that.
 *
 * **The browser is an untrusted participant.** It receives only what a payment
 * form needs to render, and everything it later sends back is treated as a
 * claim until the server proves otherwise. There is no field in either
 * direction through which a client could name its own price.
 *
 * **A verified signature is not a captured payment.** The distinction runs
 * through every name in this file, because collapsing it is how a system ends
 * up shipping goods for money that never arrived.
 */

// ---------------------------------------------------------------------------
// What the browser is given
// ---------------------------------------------------------------------------

/**
 * The complete set of values the checkout form may see.
 *
 * Every field is either a public identifier or a number the server derived from
 * its own records. What is deliberately absent is the entire reason this type
 * is written out by hand rather than assembled ad hoc at a route: there is no
 * key secret, no webhook secret, no signature material, no buyer identity, no
 * policy detail, and no internal quote or reservation state.
 *
 * `amountMinor` is a number rather than a string because the provider's
 * checkout script requires an integer in the smallest currency unit — the same
 * integer already stored on the payment attempt. It is a rendering input, not
 * an authority: nothing the browser does with it can change what is charged,
 * because the amount that will actually be collected was fixed when the order
 * was created at the provider.
 */
export interface CheckoutSessionDto {
  /** Ours. The browser echoes it back so the server can find this attempt. */
  readonly transactionId: string;
  readonly paymentAttemptId: string;
  /** The provider's order, created server-side. The browser may not choose it. */
  readonly providerOrderId: string;
  readonly provider: "RAZORPAY";
  /**
   * The provider's *public* key id.
   *
   * Designed to be in the browser: it identifies the merchant and authorizes
   * nothing on its own. Its secret counterpart never leaves the server.
   */
  readonly providerKeyId: string;
  readonly amount: MoneyDto;
  /** The same amount as an integer, for the provider's checkout script. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantName: string;
  readonly productName: string;
}

/** Why no checkout session was issued. Each is a refusal to send someone to pay. */
export const CHECKOUT_START_REFUSALS = [
  "TRANSACTION_NOT_FOUND",
  /** Not at PAYMENT_ORDER_CREATED, so there is nothing legitimate to pay for. */
  "TRANSACTION_STATE_INVALID",
  /** No payment attempt carries a provider order. Objective 10 has not run. */
  "NO_PAYMENT_ORDER",
  /** The stock hold lapsed. Sending a person to pay for it would oversell. */
  "RESERVATION_NOT_HELD",
] as const;

export type CheckoutStartRefusal = (typeof CHECKOUT_START_REFUSALS)[number];

export type CheckoutStartResult =
  | {
      readonly kind: "CHECKOUT_READY";
      readonly session: CheckoutSessionDto;
      readonly transactionState: TransactionState;
      /** True when checkout had already been started for this attempt. */
      readonly replayed: boolean;
    }
  | {
      readonly kind: "REFUSED";
      readonly transactionId: string;
      readonly refusal: CheckoutStartRefusal;
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    };

// ---------------------------------------------------------------------------
// What the browser sends back
// ---------------------------------------------------------------------------

/**
 * A checkout callback, exactly as received: entirely untrusted.
 *
 * The type is named for what it is — a claim — because the single most
 * dangerous thing a developer can do with this data is forget where it came
 * from. Anyone can POST this shape.
 *
 * `presentedOrderId` is accepted but has **no authority whatsoever**. The
 * provider's own documentation says not to verify against the order id returned
 * to the browser, and this server does not: it loads its own copy and signs
 * with that. The client's value is kept only so a mismatch can be detected and
 * recorded rather than silently ignored — a tampered order id is a security
 * event worth seeing, not merely a field to discard.
 */
export interface CheckoutCallbackClaim {
  readonly transactionId: string;
  /** Optional. When present it must name an attempt on this transaction. */
  readonly paymentAttemptId?: string;
  readonly providerPaymentId: string;
  readonly signature: string;
  readonly presentedOrderId?: string;
}

/**
 * Why a callback was refused.
 *
 * Every one of these leaves the transaction exactly as it was. None of them
 * records a payment, and none reveals anything about the expected signature.
 */
export const CALLBACK_REJECTIONS = [
  "TRANSACTION_NOT_FOUND",
  /** Not awaiting a payment result. Includes callbacks after a terminal state. */
  "TRANSACTION_STATE_INVALID",
  /** No payment attempt with a provider order to verify against. */
  "NO_PAYMENT_ORDER",
  /** The named attempt belongs to another transaction, or does not exist. */
  "ATTEMPT_MISMATCH",
  /**
   * The transaction has several payment attempts and the callback named none
   * of them.
   *
   * Only reachable once a transaction can be retried. Before that there was at
   * most one attempt carrying a provider order, so "the attempt of this
   * transaction" was unambiguous; with retries it is a guess, and guessing
   * which attempt a payment belongs to is not something a financial record may
   * do. The caller resolves it by sending the attempt id or the order id it
   * was given.
   */
  "ATTEMPT_AMBIGUOUS",
  /** The client presented an order id that is not the one we stored. */
  "ORDER_ID_MISMATCH",
  /** The payment id is not a shape this provider issues. */
  "MALFORMED_PAYMENT_ID",
  /** The HMAC did not match. The callback is not authentic. */
  "INVALID_SIGNATURE",
  /** This payment id is already bound to a different attempt. */
  "PAYMENT_ID_ALREADY_USED",
  /** A second, different payment id arrived for an already-verified attempt. */
  "CONFLICTING_PAYMENT",
] as const;

export type CallbackRejection = (typeof CALLBACK_REJECTIONS)[number];

export type CheckoutCallbackResult =
  | {
      /**
       * The callback is authentic and belongs to this exact order.
       *
       * Emphatically **not** a statement that money has been captured. It says
       * the provider really did produce this confirmation for this order, and
       * nothing more. Capture is confirmed by the provider itself, later.
       */
      readonly kind: "PAYMENT_VERIFIED";
      readonly transactionId: string;
      readonly paymentAttemptId: string;
      readonly providerOrderId: string;
      readonly providerPaymentId: string;
      readonly amount: MoneyDto;
      readonly transactionState: TransactionState;
      /** True when this callback had already been verified. */
      readonly replayed: boolean;
    }
  | {
      readonly kind: "REJECTED";
      readonly transactionId: string;
      readonly rejection: CallbackRejection;
      /** Structured and safe. Never a signature, expected or received. */
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    };

/**
 * The buyer closed the payment window.
 *
 * A distinct outcome from both success and failure, and the reason it has its
 * own type is that it is neither. Nobody paid, and nobody was told a payment
 * failed — the provider has said nothing at all. The transaction keeps its
 * state and its stock hold, which expires on its own clock if the person never
 * comes back.
 */
export type CheckoutDismissalResult =
  | {
      readonly kind: "DISMISSAL_RECORDED";
      readonly transactionId: string;
      readonly transactionState: TransactionState;
    }
  | {
      readonly kind: "IGNORED";
      readonly transactionId: string;
      readonly reason: string;
    };
