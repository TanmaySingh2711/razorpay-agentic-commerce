import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { TransactionState } from "@/domain/transaction/states";

/** Why stock could not be claimed. Each names a distinct thing a caller can act on. */
export const RESERVATION_REFUSALS = [
  /** The transaction is not AUTHORIZED. Nothing may hold stock before authority exists. */
  "NOT_AUTHORIZED",
  /** No live quote, so there is no product or quantity to reserve. */
  "NO_ACTIVE_QUOTE",
  /** The quote lapsed or the product moved. Re-quote before claiming stock. */
  "QUOTE_NOT_USABLE",
  /** Somebody else has the last unit. The ordinary, expected refusal. */
  "INSUFFICIENT_STOCK",
] as const;

export type ReservationRefusal = (typeof RESERVATION_REFUSALS)[number];

/** Why a reservation could not be committed into a permanent sale. */
export const COMMIT_REFUSALS = [
  /** No such reservation. */
  "NOT_FOUND",
  /** Already released, expired or committed. A settled claim is settled. */
  "NOT_ACTIVE",
  /** The transaction has no proven captured payment. The only thing that may sell stock. */
  "PAYMENT_NOT_CAPTURED",
] as const;

export type CommitRefusal = (typeof COMMIT_REFUSALS)[number];

export interface ReservationDto {
  readonly id: string;
  readonly transactionId: string;
  readonly quoteId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type ReservationResult =
  | {
      readonly kind: "RESERVED";
      readonly reservation: ReservationDto;
      readonly transactionState: TransactionState;
      /** True when this call found the claim its own retry already made. */
      readonly replayed: boolean;
    }
  | {
      readonly kind: "REFUSED";
      readonly transactionId: string;
      readonly refusal: ReservationRefusal;
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
      readonly reasons: readonly QuoteInvalidationReason[];
    };

/**
 * Releasing is idempotent, so "nothing to do" is a success, not a failure.
 *
 * A release runs on cancellation, payment failure and expiry - paths that are
 * retried, raced and replayed. If a second release were an error, every caller
 * would need to know whether it was the first, which is exactly the bookkeeping
 * a release exists to avoid.
 */
export type ReleaseResult =
  | {
      readonly kind: "RELEASED";
      readonly reservationId: string;
      readonly quantity: number;
    }
  | {
      readonly kind: "ALREADY_SETTLED";
      readonly reservationId: string;
      readonly status: string;
    }
  | { readonly kind: "NOT_FOUND"; readonly reservationId: string };

export type CommitResult =
  | {
      readonly kind: "COMMITTED";
      readonly reservationId: string;
      readonly quantity: number;
      /** On-hand stock after the permanent decrement. */
      readonly remainingInventory: number;
    }
  | {
      readonly kind: "REFUSED";
      readonly reservationId: string;
      readonly refusal: CommitRefusal;
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    };
