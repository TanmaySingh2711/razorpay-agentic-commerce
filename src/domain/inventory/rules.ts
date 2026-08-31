/**
 * What "in stock" means when several buyers are mid-checkout.
 *
 * Pure arithmetic, no database and no clock beyond what is passed in, so the
 * rule can be stated once and tested exhaustively. The rule itself:
 *
 *     reservable = on-hand inventory - stock held by ACTIVE reservations
 *
 * The distinction the whole objective turns on is that a reservation is a
 * **claim, not a sale**. On-hand inventory does not move when stock is
 * reserved - the unit is still in the warehouse, and if the buyer walks away it
 * was never sold. Only a proven captured payment converts a claim into a
 * permanent decrement.
 *
 * Collapsing the two - decrementing inventory at reservation time - looks
 * simpler and quietly destroys the ability to answer "how many do we actually
 * have?", because an abandoned checkout is then indistinguishable from a sale.
 */

/** Stock a new reservation may draw on. Never negative. */
export function reservableQuantity(inventory: number, reservedQuantity: number): number {
  return Math.max(0, inventory - reservedQuantity);
}

/**
 * Whether a claim of this size can be met right now.
 *
 * Purchasability is part of the question, not a separate one: a discontinued or
 * out-of-stock product with units still on a shelf is not stock anyone may
 * claim.
 */
export function canReserve(
  inventory: number,
  reservedQuantity: number,
  quantity: number,
  purchasable: boolean,
): boolean {
  if (!purchasable) return false;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return false;
  return reservableQuantity(inventory, reservedQuantity) >= quantity;
}

/**
 * Whether a reservation's hold has lapsed, at a given instant.
 *
 * `now >= expiresAt`, the same boundary a quote uses. Deliberately identical:
 * two expiry rules in one codebase that differ by a millisecond is a bug
 * nobody finds until it is a disputed charge, and a reservation outliving the
 * quote it holds stock for would hold that stock for a price that has lapsed.
 */
export function isReservationExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}
