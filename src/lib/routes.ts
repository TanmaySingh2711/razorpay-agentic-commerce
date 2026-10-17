/**
 * Where a purchase lives, in one place.
 *
 * A purchase is part of the shop: it opens under /shop the moment a request
 * becomes one, so the shopper never leaves the Shop section while paying.
 * Paying, and paying again after a failure, happen on that same page. The
 * older /transaction/:id, /checkout/:id and /shop/:id/checkout addresses
 * redirect here (see next.config.ts), so links already shared keep working.
 */

/** The page that shows one purchase: price, rules, approval, hold, payment. */
export function purchasePath(transactionId: string): string {
  return `/shop/${transactionId}`;
}
