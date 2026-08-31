import type { CurrencyCode, MoneyDto } from "@/domain/money";

/**
 * What makes a quote usable, decided without touching a database or a clock.
 *
 * A PurchaseQuote is a promise about a moment: *these* product facts, at *this*
 * price, valid until *then*. Everything in this file answers one question -
 * whether that promise still holds - from values the caller supplies, so the
 * rules can be tested exhaustively without a database and without waiting for
 * real time to pass.
 *
 * Two things a quote deliberately is **not**:
 *
 *  - **Not an authorization.** A valid quote says the server confirms these
 *    facts. It says nothing about whether this shopper is permitted to spend
 *    that much; that is Objective 7's policy decision. A quote well above any
 *    future spending limit is still a perfectly valid quote.
 *  - **Not an inventory reservation.** Quoting reads stock; it does not hold
 *    it. Between quoting and paying, someone else may buy the last unit. That
 *    is why `validateQuoteForUse` re-checks inventory rather than trusting the
 *    snapshot, and why Objective 8 exists.
 */

/** Why a quote can no longer be used. Closed, structured, safe to return. */
export const QUOTE_INVALIDATION_REASONS = [
  "PRICE_CHANGED",
  "CURRENCY_CHANGED",
  "INSUFFICIENT_STOCK",
  "PRODUCT_UNAVAILABLE",
  "PRODUCT_VERSION_CHANGED",
  "SUPERSEDED_BY_NEWER_QUOTE",
] as const;

export type QuoteInvalidationReason = (typeof QUOTE_INVALIDATION_REASONS)[number];

/** The frozen financial facts of a quote. Immutable once written. */
export interface QuoteSnapshot {
  readonly quoteId: string;
  readonly transactionId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitAmountMinor: bigint;
  readonly totalAmountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly productVersion: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** The product as it is right now, read fresh from PostgreSQL. */
export interface CurrentProductFacts {
  readonly unitAmountMinor: bigint;
  readonly currency: string;
  readonly availableQuantity: number;
  readonly purchasable: boolean;
  readonly version: number;
}

export type QuoteUsability =
  | { readonly kind: "VALID"; readonly snapshot: QuoteSnapshot }
  | { readonly kind: "EXPIRED"; readonly expiredAt: Date }
  | {
      readonly kind: "INVALIDATED";
      readonly reasons: readonly QuoteInvalidationReason[];
    };

/**
 * Whether a quote has expired, at a given instant.
 *
 * The boundary is `now >= expiresAt`: at the exact millisecond stamped on the
 * quote, it is **already expired**. An inclusive boundary would leave a
 * one-millisecond window whose behaviour depends on clock resolution, and a
 * financial rule that is ambiguous for one millisecond is a financial rule
 * someone will eventually land on. Documented here and asserted by test.
 */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/**
 * Compares a quote against the product as it is now.
 *
 * Expiry is evaluated from the clock rather than from the stored status column.
 * A status column is only as current as whatever last wrote it, and a payment
 * flow that trusted a stale `ACTIVE` would charge against a price that had
 * lapsed. There is deliberately no background job keeping statuses fresh; the
 * check is made at the moment of use, which is the only moment that matters.
 *
 * The product version is checked as well as the individual facts. Version is
 * the merchant's own statement that the product changed, and a change we cannot
 * see in the fields we compare is still a change we did not quote for - so the
 * conservative reading wins, and a bumped version invalidates the quote.
 */
export function assessQuote(
  snapshot: QuoteSnapshot,
  product: CurrentProductFacts,
  now: Date,
): QuoteUsability {
  // A quote already retired by the database is not resurrected by fresh facts.
  if (snapshot.status === "SUPERSEDED") {
    return { kind: "INVALIDATED", reasons: ["SUPERSEDED_BY_NEWER_QUOTE"] };
  }
  if (snapshot.status === "EXPIRED") {
    return { kind: "EXPIRED", expiredAt: snapshot.expiresAt };
  }

  if (isExpired(snapshot.expiresAt, now)) {
    return { kind: "EXPIRED", expiredAt: snapshot.expiresAt };
  }

  const reasons: QuoteInvalidationReason[] = [];

  if (product.currency !== snapshot.currency) {
    // No conversion, ever. A rate this system invented would be a number nobody
    // agreed to.
    reasons.push("CURRENCY_CHANGED");
  }
  if (product.unitAmountMinor !== snapshot.unitAmountMinor) {
    // Cheaper counts too: the quote froze a specific amount, and re-pricing it
    // silently - in either direction - would make the snapshot a lie.
    reasons.push("PRICE_CHANGED");
  }
  if (!product.purchasable) {
    reasons.push("PRODUCT_UNAVAILABLE");
  } else if (product.availableQuantity < snapshot.quantity) {
    reasons.push("INSUFFICIENT_STOCK");
  }
  if (product.version !== snapshot.productVersion) {
    // Catches every change the comparisons above cannot see - a required
    // attribute among them.
    reasons.push("PRODUCT_VERSION_CHANGED");
  }

  if (reasons.length > 0) {
    return { kind: "INVALIDATED", reasons };
  }
  return { kind: "VALID", snapshot };
}

/** The wire shape of a quote. `bigint` never crosses the boundary raw. */
export interface QuoteDto {
  readonly id: string;
  readonly transactionId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitAmount: MoneyDto;
  readonly totalAmount: MoneyDto;
  readonly currency: CurrencyCode;
  readonly productVersion: number;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export function toQuoteDto(snapshot: QuoteSnapshot): QuoteDto {
  return {
    id: snapshot.quoteId,
    transactionId: snapshot.transactionId,
    productId: snapshot.productId,
    quantity: snapshot.quantity,
    // Amounts as decimal strings of minor units: `JSON.stringify` throws on a
    // bigint, and a JSON number would lose precision at the top of the range.
    unitAmount: {
      amountMinor: snapshot.unitAmountMinor.toString(),
      currency: snapshot.currency,
    },
    totalAmount: {
      amountMinor: snapshot.totalAmountMinor.toString(),
      currency: snapshot.currency,
    },
    currency: snapshot.currency,
    productVersion: snapshot.productVersion,
    status: snapshot.status,
    createdAt: snapshot.createdAt.toISOString(),
    expiresAt: snapshot.expiresAt.toISOString(),
  };
}
