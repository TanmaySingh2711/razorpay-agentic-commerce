import type { CurrencyCode } from "@/domain/money";
import { SUPPORTED_CURRENCIES } from "@/domain/money";

/**
 * The pure rules about what may be sent to a payment provider.
 *
 * No database, no network, no clock. Everything here is a total function over
 * values, which is what makes the financial-authority tests in
 * `tests/payment-order-rules.test.ts` able to enumerate the boundary cases
 * rather than sample them.
 */

/**
 * The longest provider reference this system will accept or store.
 *
 * Matches the `VarChar(128)` columns that hold provider order and payment ids.
 * It is exported so the request boundary and the audit allow-list share one
 * number rather than choosing their own: when they disagreed, a caller could
 * post an order id the endpoint accepted but the audit schema refused, and the
 * resulting validation failure was swallowed - so a tampered order id long
 * enough to trip the mismatch went unrecorded, with the attacker choosing
 * whether the security event was written at all.
 */
export const MAX_PROVIDER_REFERENCE_LENGTH = 128;

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

/**
 * Razorpay's documented limit: "Can have a maximum length of 40 characters and
 * has to be unique." Non-ASCII characters and emoji are rejected by the API.
 */
export const MAX_RECEIPT_LENGTH = 40;

const RECEIPT_PREFIX = "rcpt_";

/** ASCII, and only characters no URL, log formatter or CSV export will mangle. */
export const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Derives the provider receipt from our own PaymentAttempt id.
 *
 * Three properties are needed at once, and deriving gets all three:
 *
 *  - **Stable across retries.** The receipt is Razorpay's idempotency identity
 *    for order creation, so a retry of the same logical operation must present
 *    the same string. It does, because it is a function of a row that the retry
 *    finds rather than re-creates.
 *  - **Unique.** The attempt id is a UUIDv7, so no two attempts collide.
 *  - **Reversible.** Given a receipt from a provider dashboard or an ambiguous
 *    lookup, the attempt it belongs to can be found without a second index.
 *
 * The hyphens come out because a 36-character UUID plus any prefix exceeds 40.
 * Stripping them keeps the identity intact at 37 characters.
 *
 * It carries no secret: a PaymentAttempt id is an internal identifier, not a
 * credential, and nothing is authorized by presenting one.
 */
export function deriveReceipt(paymentAttemptId: string): string {
  const compact = paymentAttemptId.replaceAll("-", "");
  const receipt = `${RECEIPT_PREFIX}${compact}`;
  if (!RECEIPT_PATTERN.test(receipt)) {
    // A defect, not a user condition: it means an id shape changed underneath
    // this function. Failing here beats sending the provider something it will
    // reject, or worse, silently truncate.
    throw new Error(
      `A payment receipt could not be derived: the identifier produced a value outside the provider's ${MAX_RECEIPT_LENGTH}-character ASCII limit.`,
    );
  }
  return receipt;
}

/** Recovers the PaymentAttempt id a receipt was derived from, if it was ours. */
export function paymentAttemptIdFromReceipt(receipt: string): string | null {
  if (!receipt.startsWith(RECEIPT_PREFIX)) return null;
  const compact = receipt.slice(RECEIPT_PREFIX.length);
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

// ---------------------------------------------------------------------------
// The amount
// ---------------------------------------------------------------------------

/**
 * Why an amount may not be sent to a provider.
 *
 * Enumerated rather than collapsed into a boolean because these are different
 * bugs. A non-positive amount means a quote is corrupt; an amount past the safe
 * integer range means a currency conversion went wrong somewhere upstream; an
 * amount below the provider minimum is an ordinary product-level problem.
 */
export const PAYABLE_AMOUNT_REFUSALS = [
  "NOT_POSITIVE",
  "BELOW_PROVIDER_MINIMUM",
  "NOT_SAFELY_REPRESENTABLE",
  "UNSUPPORTED_CURRENCY",
] as const;

export type PayableAmountRefusal = (typeof PAYABLE_AMOUNT_REFUSALS)[number];

/**
 * Razorpay: "The amount must be at least INR 1.00." One rupee is 100 paise, and
 * the quote is already in paise, so the floor is 100 minor units.
 */
const PROVIDER_MINIMUM_MINOR: Record<CurrencyCode, bigint> = { INR: 100n };

/**
 * The provider's `amount` is a JSON integer, so it has to survive the trip
 * through `number`. Anything past 2^53-1 would be silently rounded — a rounding
 * error in the one field that says how much to charge.
 */
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export type PayableAmount =
  | { readonly kind: "PAYABLE"; readonly amountMinor: bigint }
  | { readonly kind: "REFUSED"; readonly refusal: PayableAmountRefusal };

/**
 * Judges an amount taken from a trusted quote.
 *
 * Deliberately paranoid about a value that has already been validated
 * elsewhere. The cost of a redundant check is nothing; the cost of sending a
 * wrong number to a payment provider is a real charge against a real person,
 * and this is the last place in the system where that number can be stopped.
 */
export function assessPayableAmount(
  amountMinor: bigint,
  currency: string,
): PayableAmount {
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    return { kind: "REFUSED", refusal: "UNSUPPORTED_CURRENCY" };
  }
  if (amountMinor <= 0n) {
    return { kind: "REFUSED", refusal: "NOT_POSITIVE" };
  }
  if (amountMinor > MAX_SAFE_MINOR) {
    return { kind: "REFUSED", refusal: "NOT_SAFELY_REPRESENTABLE" };
  }
  if (amountMinor < PROVIDER_MINIMUM_MINOR[currency as CurrencyCode]) {
    return { kind: "REFUSED", refusal: "BELOW_PROVIDER_MINIMUM" };
  }
  return { kind: "PAYABLE", amountMinor };
}

/**
 * Converts a validated minor-unit amount into the integer the provider expects.
 *
 * There is no arithmetic here, and that is the point. The quote is already in
 * minor units, so the only correct transformation is a widening of the same
 * number — no multiplication by 100, no division, no floating point anywhere on
 * the path from PostgreSQL to the provider. `Number()` is called only after
 * `assessPayableAmount` has proved the value fits.
 */
export function toProviderAmount(amount: PayableAmount & { kind: "PAYABLE" }): number {
  return Number(amount.amountMinor);
}
