import type { MoneyDto } from "@/domain/money";
import type { ProviderFailureCategory } from "@/domain/payment/provider";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { TransactionState } from "@/domain/transaction/states";

/**
 * What the payment-order boundary answers.
 *
 * Five arms, and the shape of the union is the design. A caller cannot write
 * `if (ok) { … } else { retry() }`, because "retry" is wrong for three of the
 * four non-success outcomes and catastrophic for one of them.
 */

/** Why no provider call was made. Every one of these is checked before Razorpay. */
export const PAYMENT_ORDER_REFUSALS = [
  /** No such transaction. */
  "TRANSACTION_NOT_FOUND",
  /** The transaction is not holding reserved stock awaiting a payment order. */
  "TRANSACTION_STATE_INVALID",
  /** No live quote, so there is no amount to charge. */
  "NO_ACTIVE_QUOTE",
  /** The quote lapsed or the product moved. Re-quote before charging. */
  "QUOTE_NOT_USABLE",
  /** No ACTIVE inventory reservation backs this purchase. */
  "NO_ACTIVE_RESERVATION",
  /** The reservation names a different quote, product or quantity. */
  "RESERVATION_MISMATCH",
  /** The stock hold elapsed. Paying now could oversell. */
  "RESERVATION_EXPIRED",
  /** The pre-payment policy recheck refused. The exact cause is in `detail`. */
  "NOT_AUTHORIZED",
  /** The trusted amount cannot be charged: non-positive, too large, below the floor. */
  "AMOUNT_NOT_PAYABLE",
] as const;

export type PaymentOrderRefusal = (typeof PAYMENT_ORDER_REFUSALS)[number];

/** A created provider order, as it is safe to hand back. Never a secret. */
export interface PaymentOrderDto {
  /** Internal. The primary key remains ours. */
  readonly paymentAttemptId: string;
  /** External. A reference, never used as a key on anything we own. */
  readonly providerOrderId: string;
  readonly receipt: string;
  readonly provider: "RAZORPAY";
  readonly amount: MoneyDto;
  readonly providerStatus: string;
}

export type PaymentOrderResult =
  | {
      readonly kind: "ORDER_CREATED";
      readonly transactionId: string;
      readonly quoteId: string;
      readonly order: PaymentOrderDto;
      readonly transactionState: TransactionState;
      /** True when this call converged on an order an earlier one had created. */
      readonly replayed: boolean;
    }
  | {
      readonly kind: "REFUSED";
      readonly transactionId: string;
      readonly refusal: PaymentOrderRefusal;
      /** Structured, safe context. Never SQL, never a provider message. */
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
      readonly reasons: readonly QuoteInvalidationReason[];
    }
  | {
      /**
       * The provider definitely did not create an order.
       *
       * "Definitely" is load-bearing: this arm is only reached when the failure
       * was a refusal the provider is known to have made before acting, or when
       * a receipt lookup proved no order exists.
       */
      readonly kind: "PROVIDER_FAILED";
      readonly transactionId: string;
      readonly paymentAttemptId: string;
      readonly category: ProviderFailureCategory;
      /** A mapped, safe code. Never the provider's prose. */
      readonly failureCode: string;
      /** Whether calling again could not possibly duplicate an order. */
      readonly retryable: boolean;
    }
  | {
      /**
       * Nobody knows whether an order exists.
       *
       * The reservation is deliberately left in place and the transaction is
       * deliberately not moved. The only correct next step is to look the
       * receipt up at the provider - never to ask for another order.
       */
      readonly kind: "RECONCILIATION_REQUIRED";
      readonly transactionId: string;
      readonly paymentAttemptId: string;
      readonly receipt: string;
      readonly reason: string;
    }
  | {
      /**
       * Another request owns provider creation for this transaction and has
       * not finished. Returned rather than queued: waiting on a lock would tie
       * up a request thread, and creating a second order would be worse.
       */
      readonly kind: "CREATION_IN_PROGRESS";
      readonly transactionId: string;
      readonly paymentAttemptId: string;
    };
