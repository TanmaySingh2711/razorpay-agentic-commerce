import { unmetHardRequirements } from "@/domain/buyer-agent/validation";
import type { CatalogProductDto } from "@/domain/catalog/contracts";
import type { BudgetScope, Constraint } from "@/domain/buyer-agent/intent";
import type { CurrencyCode } from "@/domain/money";

/**
 * Who is allowed to be quoted, decided by arithmetic.
 *
 * This is the layer that turns "the AI picked product X" into "the server
 * agrees product X is a legitimate thing to charge this person for". Everything
 * here is pure: no model, no database, no clock, no network. Given the same
 * candidate and the same user authority it always returns the same verdict, and
 * no prompt can argue with it.
 *
 * The ordering of the checks is not arbitrary. Currency is settled before
 * money, because comparing amounts across currencies is meaningless rather than
 * merely wrong. Availability is settled before budget, because a product nobody
 * can buy is not a cheaper option.
 */

/** The user's authority, resolved and frozen before any candidate is examined. */
export interface PurchaseAuthority {
  readonly quantity: number;
  /** Present only when the shopper actually stated a limit. */
  readonly maxAmountMinor: bigint | null;
  readonly currency: CurrencyCode | null;
  /** How that limit applies. Never inferred at comparison time. */
  readonly budgetScope: BudgetScope | null;
  readonly hardRequirements: readonly Constraint[];
  readonly category: string | null;
}

/** Why a candidate was refused. A closed vocabulary, safe to log and return. */
export const INELIGIBILITY_REASONS = [
  "WRONG_CATEGORY",
  "CURRENCY_MISMATCH",
  "NOT_PURCHASABLE",
  "INSUFFICIENT_INVENTORY",
  "OVER_BUDGET",
  "UNMET_HARD_REQUIREMENT",
] as const;

export type IneligibilityReason = (typeof INELIGIBILITY_REASONS)[number];

/** Why a candidate was accepted. Every code corresponds to a check that ran. */
export const ELIGIBILITY_REASONS = [
  "MATCHES_CATEGORY",
  "MATCHES_HARD_REQUIREMENTS",
  "WITHIN_BUDGET",
  "CURRENCY_MATCH",
  "IN_STOCK",
  "SUFFICIENT_INVENTORY",
] as const;

export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

export type Eligibility =
  | { readonly kind: "ELIGIBLE"; readonly reasons: readonly EligibilityReason[] }
  | {
      readonly kind: "INELIGIBLE";
      readonly reasons: readonly IneligibilityReason[];
    };

/**
 * The total for a line, in integer minor units.
 *
 * `bigint` throughout. The unit price arrives from a PostgreSQL `BIGINT` and the
 * multiplication happens without ever passing through a JavaScript number, so
 * there is no rounding step and no silent precision loss at the top of the
 * range - which is the entire reason money is represented this way.
 */
export function totalAmountMinor(unitAmountMinor: bigint, quantity: number): bigint {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new RangeError(
      `quantity must be a positive integer, received ${String(quantity)}`,
    );
  }
  return unitAmountMinor * BigInt(quantity);
}

/**
 * Whether a line respects the shopper's stated limit.
 *
 * The scope decides *what* is compared, and it is required rather than assumed:
 * "under ₹3000 each" for two keyboards permits ₹6000 of spending and "₹3000
 * total" permits ₹3000, and nothing about the number distinguishes them. A
 * missing scope with quantity above one is refused upstream, so by the time
 * this runs the question has already been answered by the shopper.
 */
export function respectsBudget(
  unitAmountMinor: bigint,
  quantity: number,
  authority: PurchaseAuthority,
): boolean {
  if (authority.maxAmountMinor === null) return true;

  // A quantity of one makes the two scopes identical, so it needs no decision.
  const scope: BudgetScope =
    authority.budgetScope ?? (quantity === 1 ? "PER_UNIT" : "TOTAL");

  const compared =
    scope === "PER_UNIT" ? unitAmountMinor : totalAmountMinor(unitAmountMinor, quantity);
  return compared <= authority.maxAmountMinor;
}

/**
 * Judges one candidate against the whole of the user's authority.
 *
 * Collects every failing reason rather than stopping at the first, so a shopper
 * can be told the product is both out of stock *and* over budget instead of
 * discovering the second problem after fixing the first.
 */
export function assessCandidate(
  product: CatalogProductDto,
  authority: PurchaseAuthority,
): Eligibility {
  const failures: IneligibilityReason[] = [];
  const reasons: EligibilityReason[] = [];

  if (
    authority.category !== null &&
    product.category.toLowerCase() !== authority.category.toLowerCase()
  ) {
    failures.push("WRONG_CATEGORY");
  } else if (authority.category !== null) {
    reasons.push("MATCHES_CATEGORY");
  }

  // Currency first: an amount in the wrong currency is not comparable, so a
  // budget verdict about it would be meaningless rather than merely wrong.
  if (authority.currency !== null && product.amount.currency !== authority.currency) {
    failures.push("CURRENCY_MISMATCH");
  } else if (authority.currency !== null) {
    reasons.push("CURRENCY_MATCH");
  }

  if (!product.availability.purchasable) {
    failures.push("NOT_PURCHASABLE");
  } else {
    reasons.push("IN_STOCK");
    if (product.availability.quantity < authority.quantity) {
      failures.push("INSUFFICIENT_INVENTORY");
    } else if (authority.quantity > 1) {
      reasons.push("SUFFICIENT_INVENTORY");
    }
  }

  // Only meaningful once the currency matched; otherwise it is already refused.
  if (!failures.includes("CURRENCY_MISMATCH")) {
    if (
      !respectsBudget(BigInt(product.amount.amountMinor), authority.quantity, authority)
    ) {
      failures.push("OVER_BUDGET");
    } else if (authority.maxAmountMinor !== null) {
      reasons.push("WITHIN_BUDGET");
    }
  }

  // Structured attributes only. A description that claims a property is
  // marketing copy, and merchant copy has never been evidence here.
  if (unmetHardRequirements(product, authority.hardRequirements).length > 0) {
    failures.push("UNMET_HARD_REQUIREMENT");
  } else if (authority.hardRequirements.length > 0) {
    reasons.push("MATCHES_HARD_REQUIREMENTS");
  }

  return failures.length > 0
    ? { kind: "INELIGIBLE", reasons: failures }
    : { kind: "ELIGIBLE", reasons };
}

/**
 * Why this candidate is refused, or an empty list if it is not.
 *
 * A narrowing helper: the union's  field is one of two different
 * vocabularies, and a caller that only wants the refusals should not have to
 * cast to find out which it got.
 */
export function ineligibilityReasons(
  product: CatalogProductDto,
  authority: PurchaseAuthority,
): readonly IneligibilityReason[] {
  const assessment = assessCandidate(product, authority);
  return assessment.kind === "INELIGIBLE" ? assessment.reasons : [];
}

/** The subset of candidates the server is willing to quote. */
export function eligibleCandidates(
  products: readonly CatalogProductDto[],
  authority: PurchaseAuthority,
): readonly CatalogProductDto[] {
  return products.filter(
    (product) => assessCandidate(product, authority).kind === "ELIGIBLE",
  );
}

/**
 * The refusals that mean "this product is fine, there just is not any of it".
 *
 * Kept apart from the rest because only these justify offering a different
 * product. Every other refusal says the shopper would not have wanted this one
 * anyway - it costs too much, it is the wrong category, it fails a stated
 * requirement - and quietly reaching for a substitute in those cases would be
 * answering a question nobody asked.
 */
const AVAILABILITY_REFUSALS: readonly IneligibilityReason[] = [
  "NOT_PURCHASABLE",
  "INSUFFICIENT_INVENTORY",
];

/**
 * Whether stock, and *only* stock, is what stood in this product's way.
 *
 * Deliberately requires every reason to be an availability reason rather than
 * merely one of them. A product that is both out of stock and over budget must
 * not be substituted: offering an alternative would imply the shopper could
 * have had this one, which is untrue, and would hide the refusal that actually
 * matters to them.
 */
export function refusedOnlyForAvailability(
  reasons: readonly IneligibilityReason[],
): boolean {
  return reasons.length > 0 && reasons.every((r) => AVAILABILITY_REFUSALS.includes(r));
}

/**
 * The server's own next-best choice, excluding one product.
 *
 * "Next best" is the first eligible candidate in the order the catalog already
 * returned - the caller searches `amount_asc`, so this is the cheapest product
 * that satisfies the shopper's entire authority. Deterministic by construction:
 * the same catalog and the same authority always yield the same substitute, and
 * nothing a model said is an input.
 */
export function nextBestAlternative(
  products: readonly CatalogProductDto[],
  authority: PurchaseAuthority,
  excludeProductId: string,
): CatalogProductDto | null {
  return (
    eligibleCandidates(products, authority).find(
      (product) => product.id !== excludeProductId,
    ) ?? null
  );
}

/**
 * Hard requirements the server cannot check for itself.
 *
 * A requirement is machine-checkable when it names the product's category or an
 * attribute the catalog actually carries. Anything else - "must be good for
 * gaming", "must be quiet" - cannot be settled from structured data, and the
 * model's opinion that a product satisfies it is not evidence.
 *
 * Rather than quietly ignoring such a requirement (which would produce a quote
 * the shopper did not ask for) or trusting the model (which would make a hard
 * constraint AI-decided), the caller asks the shopper. This function reports
 * which requirements forced that.
 */
export function unverifiableRequirements(
  products: readonly CatalogProductDto[],
  requirements: readonly Constraint[],
): readonly Constraint[] {
  const knownAttributes = new Set<string>(["category"]);
  for (const product of products) {
    for (const key of Object.keys(product.attributes)) knownAttributes.add(key);
  }
  return requirements.filter(
    (requirement) => !knownAttributes.has(requirement.attribute),
  );
}
