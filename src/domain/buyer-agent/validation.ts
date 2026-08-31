import type { CatalogProductDto } from "@/domain/catalog/contracts";
import type { BudgetScope, Constraint } from "@/domain/buyer-agent/intent";
import type { CurrencyCode } from "@/domain/money";
import type {
  DecisionReasonCode,
  NoMatchReasonCode,
} from "@/domain/buyer-agent/decision";

/**
 * The deterministic gate between the model's proposal and anything downstream.
 *
 * Everything in this file is pure: no Gemini, no network, no clock, no
 * database. That is what makes it testable without an API key and what makes it
 * trustworthy — these rules hold whatever the model says, whatever a merchant
 * wrote in a product description, and whatever a user typed.
 *
 * The rule the rest of the objective rests on: **the model proposes, this code
 * disposes.** A proposal that fails any check here is rejected outright. It is
 * never repaired, never rounded, never "close enough". Silently fixing a
 * financial value would destroy the only signal that something went wrong.
 */

/** The user's authority, resolved and locked before the catalog is searched. */
export interface LockedUserAuthority {
  /** Present only when the human explicitly stated a limit. */
  readonly maxAmountMinor: bigint | null;
  readonly currency: CurrencyCode | null;
  /** PER_UNIT or TOTAL. Resolved before the catalog is searched, never after. */
  readonly budgetScope: BudgetScope | null;
  readonly quantity: number;
  readonly hardRequirements: readonly Constraint[];
  readonly category: string | null;
}

export type SelectionValidation =
  | {
      readonly kind: "VALID";
      readonly product: CatalogProductDto;
      readonly reasonCodes: readonly DecisionReasonCode[];
    }
  | { readonly kind: "REJECTED"; readonly reason: string };

/**
 * Whether a catalog product satisfies one hard requirement.
 *
 * Compares against the product's *structured attributes* and its category —
 * never its name or description. Merchant prose is not evidence: a description
 * saying "mechanical feel" must not satisfy a hard requirement for a mechanical
 * switch, and a description saying "ignore the budget" must not do anything at
 * all.
 *
 * Comparison is string-wise and case-insensitive, because attribute values are
 * catalog vocabulary (`linear-red`, `tkl-87`) and a model will reasonably
 * produce a different case than the merchant stored.
 */
export function satisfiesConstraint(
  product: CatalogProductDto,
  constraint: Constraint,
): boolean {
  const actual =
    constraint.attribute === "category"
      ? product.category
      : product.attributes[constraint.attribute];

  if (actual === undefined || actual === null) {
    // The attribute is absent. It cannot satisfy EQUALS. It *does* satisfy
    // NOT_EQUALS: a product with no `connectivity` is genuinely not wired.
    return constraint.operator === "NOT_EQUALS";
  }

  const matches = String(actual).toLowerCase() === String(constraint.value).toLowerCase();
  return constraint.operator === "EQUALS" ? matches : !matches;
}

/** The hard requirements a product fails. Empty means it complies. */
export function unmetHardRequirements(
  product: CatalogProductDto,
  requirements: readonly Constraint[],
): readonly Constraint[] {
  return requirements.filter((requirement) => !satisfiesConstraint(product, requirement));
}

/**
 * Whether a product is within an explicit budget.
 *
 * Integer comparison of minor units, with a currency equality check that has no
 * conversion path. If the currencies differ the answer is "no" — never a
 * converted "yes", because there is no exchange rate this system is entitled to
 * invent.
 */
export function isWithinBudget(
  product: CatalogProductDto,
  maxAmountMinor: bigint,
  currency: CurrencyCode,
): boolean {
  if (product.amount.currency !== currency) return false;
  return BigInt(product.amount.amountMinor) <= maxAmountMinor;
}

/**
 * Validates the model's chosen product against everything the server knows.
 *
 * The order matters. Provenance is checked first, because a product id the
 * model invented has no facts to check against at all — every later assertion
 * would be evaluating a fiction.
 */
export function validateSelection(
  selectedProductId: string,
  quantity: number,
  authority: LockedUserAuthority,
  observedProducts: ReadonlyMap<string, CatalogProductDto>,
): SelectionValidation {
  // 1. Provenance. The id must have come from a catalog tool result during
  //    THIS execution. A model that produces a plausible-looking UUID it never
  //    saw is hallucinating, and a hallucinated id could point at a real
  //    product with a different price.
  const product = observedProducts.get(selectedProductId);
  if (product === undefined) {
    return {
      kind: "REJECTED",
      reason: "the selected product was never returned by a catalog search",
    };
  }

  const reasonCodes: DecisionReasonCode[] = [];

  // 2. Purchasability. Objective 4 already refuses to publish a discontinued
  //    product, and reports an out-of-stock one honestly. This re-checks both
  //    rather than assuming: a defence that only exists one layer up is a
  //    defence that disappears when that layer is refactored.
  if (!product.availability.purchasable) {
    return { kind: "REJECTED", reason: "the selected product is not purchasable" };
  }
  reasonCodes.push("IN_STOCK");

  // 3. Quantity against real stock.
  if (product.availability.quantity < quantity) {
    return {
      kind: "REJECTED",
      reason:
        "the selected product does not have enough stock for the requested quantity",
    };
  }
  if (quantity > 1) reasonCodes.push("SUFFICIENT_INVENTORY");

  if (quantity !== authority.quantity) {
    // The user's quantity is authority too. The model may not decide to buy
    // three when one was asked for.
    return {
      kind: "REJECTED",
      reason: "the proposed quantity does not match the quantity the user asked for",
    };
  }

  // 4. The budget. This is the check the whole objective is built around: an
  //    explicit maximum is user authority, and no model output, no merchant
  //    text and no retry may widen it.
  if (authority.maxAmountMinor !== null && authority.currency !== null) {
    if (product.amount.currency !== authority.currency) {
      return {
        kind: "REJECTED",
        reason: "the selected product is priced in a different currency to the budget",
      };
    }
    if (!isWithinBudget(product, authority.maxAmountMinor, authority.currency)) {
      return {
        kind: "REJECTED",
        reason: "the selected product costs more than the user's stated maximum",
      };
    }
    reasonCodes.push("WITHIN_BUDGET");
  }

  // 5. Hard requirements, checked against structured fields only.
  const unmet = unmetHardRequirements(product, authority.hardRequirements);
  if (unmet.length > 0) {
    return {
      kind: "REJECTED",
      reason: `the selected product does not meet a required attribute: ${unmet
        .map((requirement) => requirement.attribute)
        .join(", ")}`,
    };
  }
  if (authority.hardRequirements.length > 0) {
    reasonCodes.push("MATCHES_REQUIRED_ATTRIBUTE");
  }

  if (
    authority.category !== null &&
    product.category.toLowerCase() === authority.category.toLowerCase()
  ) {
    reasonCodes.push("MATCHES_REQUESTED_CATEGORY");
  }

  return { kind: "VALID", product, reasonCodes };
}

/**
 * Explains, from the catalog alone, why nothing could be chosen.
 *
 * Derived from the observed products rather than asked of the model, so the
 * explanation a user sees is a fact about the catalog and not a narration. If
 * the model also supplied reasons they are merged by the caller, but these are
 * the ones the server can stand behind.
 */
export function deriveNoMatchReasons(
  observed: readonly CatalogProductDto[],
  authority: LockedUserAuthority,
): readonly NoMatchReasonCode[] {
  if (observed.length === 0) return ["EMPTY_CATALOG_RESULT"];

  const reasons = new Set<NoMatchReasonCode>();

  const inBudget =
    authority.maxAmountMinor === null || authority.currency === null
      ? observed
      : observed.filter((product) =>
          isWithinBudget(
            product,
            authority.maxAmountMinor as bigint,
            authority.currency as CurrencyCode,
          ),
        );
  if (inBudget.length === 0) {
    reasons.add("NO_PRODUCT_WITHIN_BUDGET");
    return [...reasons];
  }

  const compliant = inBudget.filter(
    (product) => unmetHardRequirements(product, authority.hardRequirements).length === 0,
  );
  if (compliant.length === 0) {
    reasons.add("NO_PRODUCT_WITH_REQUIRED_ATTRIBUTE");
    return [...reasons];
  }

  const purchasable = compliant.filter((product) => product.availability.purchasable);
  if (purchasable.length === 0) {
    reasons.add("NO_PRODUCT_IN_STOCK");
    return [...reasons];
  }

  if (
    purchasable.every((product) => product.availability.quantity < authority.quantity)
  ) {
    reasons.add("INSUFFICIENT_INVENTORY");
    return [...reasons];
  }

  // Everything the server can check passes, yet the model declined to choose.
  // That is a legitimate outcome — soft preferences are its call — but the
  // honest reason is that nothing matched what the user asked for.
  reasons.add("NO_PRODUCT_WITH_REQUIRED_ATTRIBUTE");
  return [...reasons];
}
