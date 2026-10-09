/**
 * Where a purchase lives, in one place.
 *
 * A purchase is part of the shop: it opens under /shop the moment a request
 * becomes one, so the shopper never leaves the Shop section while paying.
 * The older /transaction/:id and /checkout/:id addresses redirect here
 * (see next.config.ts), so links already shared keep working.
 */

/** The page that shows one purchase: price, rules, approval, hold, payment. */
export function purchasePath(transactionId: string): string {
  return `/shop/${transactionId}`;
}

/** The page that offers paying again after a failed attempt. */
export function purchaseCheckoutPath(transactionId: string): string {
  return `/shop/${transactionId}/checkout`;
}
