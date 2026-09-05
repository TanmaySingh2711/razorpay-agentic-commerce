import { assertServerOnly } from "@/lib/server-only";
import { createLogger } from "@/lib/logger";
import { systemClock, type Clock } from "@/lib/clock";
import { getPrismaClient } from "@/integrations/persistence/client";
import { createTransaction } from "@/services/transaction/creation-service";
import { applyTransactionEventWithin } from "@/services/transaction/transition-service";
import {
  createServiceCatalogReader,
  type CatalogReader,
} from "@/services/buyer-agent/catalog-reader";
import { createTrustedQuote } from "@/services/quote/quote-service";
import {
  assessCandidate,
  eligibleCandidates,
  ineligibilityReasons,
  nextBestAlternative,
  refusedOnlyForAvailability,
  unverifiableRequirements,
  type PurchaseAuthority,
} from "@/domain/product-decision/eligibility";
import { toQuoteDto } from "@/domain/quote/rules";
import { QuoteProductChangedError } from "@/domain/quote/errors";
import { getQuoteConfig } from "@/config/env";
import { recordAuditEvent } from "@/services/audit/audit-service";
import type { PurchaseDecisionResult } from "@/domain/quote/contracts";
import type { BuyerAgentDecision } from "@/domain/buyer-agent/decision";
import type { CatalogProductDto } from "@/domain/catalog/contracts";
import type { CurrencyCode } from "@/domain/money";
import type { EligibilityReason } from "@/domain/product-decision/eligibility";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The boundary between "the AI picked something" and "the server will put a
 * price behind it".
 *
 * Objective 5 ends with a proposal. This service decides whether that proposal
 * survives contact with the database, and the order it does that in is the
 * whole design:
 *
 *   1. purchase intent only        - browsing buys nothing
 *   2. open the transaction        - through the Objective 3 boundary, idempotently
 *   3. retrieve candidates OURSELVES - from the catalog, not from the model
 *   4. filter deterministically    - arithmetic the model cannot argue with
 *   5. check the proposed id belongs to that set
 *   6. move to PRODUCT_SELECTED
 *   7. re-read the product and quote it, atomically
 *
 * Step 3 is easy to skip and load-bearing. The agent already searched the
 * catalog, so re-querying looks redundant - but the agent's list came back
 * through a model's context, and a set the server did not build is a set the
 * server cannot vouch for. Step 5 then means something: membership of *our*
 * candidates, not of a list the model handed us.
 *
 * No Gemini call happens here. Objective 5's validated output is consumed as
 * data; asking a model to re-do work the database can settle would spend quota
 * to make a decision less trustworthy.
 */
assertServerOnly("src/services/product-decision/product-decision-service.ts");

const log = createLogger({ category: "agent" });

/** How many catalog rows the server considers. Bounded, like every other read. */
const MAX_CANDIDATES = 50;

export interface ProductDecisionDeps {
  readonly prisma: PrismaClient;
  readonly catalog: CatalogReader;
  readonly clock: Clock;
  readonly quoteTtlSeconds: number;
}

export function defaultProductDecisionDeps(): ProductDecisionDeps {
  return {
    prisma: getPrismaClient(),
    catalog: createServiceCatalogReader(),
    clock: systemClock,
    quoteTtlSeconds: getQuoteConfig().QUOTE_TTL_SECONDS,
  };
}

/**
 * Turns the agent's normalized constraints into the server's frozen authority.
 *
 * Amounts become `bigint` here and stay that way. The agent's DTO carries them
 * as strings precisely so no JSON number ever holds money.
 */
function toAuthority(decision: BuyerAgentDecision): PurchaseAuthority {
  const { constraints } = decision;
  const budget = constraints.maxBudget;
  return {
    quantity: constraints.quantity,
    maxAmountMinor: budget === null ? null : BigInt(budget.amountMinor),
    currency: budget === null ? null : (budget.currency as CurrencyCode),
    budgetScope: constraints.budgetScope,
    hardRequirements: constraints.hardRequirements,
    // The shopper's stated category, enforced by `assessCandidate` as the hard
    // constraint it is. This was `null` - not because category did not matter,
    // but because `NormalizedUserConstraints` had nowhere to carry it, so the
    // `WRONG_CATEGORY` check could never fire here however clearly somebody
    // asked for a mouse. Null still means "no category stated", which leaves
    // the search open rather than narrowing it to a guess.
    //
    // Coerced rather than passed through: a decision reaching this boundary may
    // have been deserialised, and an *absent* category must mean "none stated",
    // never `undefined` leaking into a comparison that only guards against
    // null. Failing open into a crash is not a safe way to discover that.
    category: constraints.category ?? null,
  };
}

/**
 * Opens the transaction, or finds the one this request already opened.
 *
 * The correlation id carries idempotency. A unique index on it means the second
 * of two simultaneous retries is rejected by PostgreSQL rather than by a
 * check-then-insert race, and both callers converge on the same transaction.
 */
async function openTransaction(
  decision: BuyerAgentDecision,
  deps: ProductDecisionDeps,
): Promise<string> {
  const existing = await deps.prisma.transaction.findUnique({
    where: { correlationId: decision.correlationId },
    select: { id: true },
  });
  if (existing !== null) return existing.id;

  const buyer = await deps.prisma.buyerProfile.findFirst({ select: { id: true } });
  const merchantId = await resolveMerchantId(decision, deps);
  if (buyer === null || merchantId === null) {
    throw new Error("a buyer profile and merchant are required to open a transaction");
  }

  try {
    const created = await createTransaction(
      {
        buyerProfileId: buyer.id,
        merchantId,
        correlationId: decision.correlationId,
      },
      { prisma: deps.prisma },
    );
    return created.id;
  } catch (error) {
    // Lost the race: another attempt inserted first. Its row is the answer.
    const raced = await deps.prisma.transaction.findUnique({
      where: { correlationId: decision.correlationId },
      select: { id: true },
    });
    if (raced !== null) return raced.id;
    throw error;
  }
}

async function resolveMerchantId(
  decision: BuyerAgentDecision,
  deps: ProductDecisionDeps,
): Promise<string | null> {
  if (decision.kind === "PRODUCT_SELECTED") {
    const product = await deps.prisma.product.findUnique({
      where: { id: decision.selectedProductId },
      select: { merchantId: true },
    });
    if (product !== null) return product.merchantId;
  }
  const merchant = await deps.catalog.getMerchant();
  return merchant.id;
}

/** Fetches the server's own candidate set from the authoritative catalog. */
async function retrieveCandidates(
  decision: BuyerAgentDecision,
  authority: PurchaseAuthority,
  deps: ProductDecisionDeps,
): Promise<readonly CatalogProductDto[]> {
  const page = await deps.catalog.searchProducts({
    ...(authority.maxAmountMinor === null || authority.currency === null
      ? {}
      : { maxAmountMinor: authority.maxAmountMinor, currency: authority.currency }),
    attributes: [],
    sort: "amount_asc",
    limit: MAX_CANDIDATES,
    offset: 0,
  });

  // The proposed product must be considered even if paging or a filter would
  // have hidden it - otherwise "not in the candidate set" could mean "not on
  // page one", which is a different and much less meaningful rejection.
  if (decision.kind !== "PRODUCT_SELECTED") return page.products;
  if (page.products.some((p) => p.id === decision.selectedProductId))
    return page.products;

  const proposed = await deps.catalog
    .getProduct(decision.selectedProductId)
    .catch(() => null);
  return proposed === null ? page.products : [...page.products, proposed];
}

/**
 * Runs the purchase decision for a validated buyer-agent result.
 *
 * Returns a discriminated result. It throws only for genuine infrastructure
 * failures; every business refusal is a branch a caller can read.
 */
export async function decidePurchase(
  decision: BuyerAgentDecision,
  deps: ProductDecisionDeps = defaultProductDecisionDeps(),
): Promise<PurchaseDecisionResult> {
  const correlationId = decision.correlationId;

  // --- 1. Only a purchase buys anything. ---
  if (decision.kind === "NEEDS_CLARIFICATION") {
    return {
      kind: "CLARIFICATION_REQUIRED",
      correlationId,
      question: decision.clarificationQuestion,
      ambiguousFields: [...decision.ambiguousFields],
    };
  }
  if (decision.kind === "NO_MATCH") {
    return {
      kind: "NO_VALID_CANDIDATE",
      correlationId,
      transactionId: null,
      reasons: [],
    };
  }
  if (decision.constraints.requestType !== "PURCHASE") {
    // Browsing and asking for advice are legitimate requests that open nothing.
    return {
      kind: "NO_QUOTE_REQUIRED",
      correlationId,
      requestType: decision.constraints.requestType,
    };
  }

  const authority = toAuthority(decision);

  // A budget whose scope is unresolved above quantity 1 is two different
  // amounts of money. The agent should already have asked; this is the backstop.
  if (
    authority.maxAmountMinor !== null &&
    authority.quantity > 1 &&
    authority.budgetScope === null
  ) {
    return {
      kind: "CLARIFICATION_REQUIRED",
      correlationId,
      question:
        "Is that budget per item, or the total for all of them? I need to know before I can price this.",
      ambiguousFields: ["budget"],
    };
  }

  log.info("purchase decision started", {
    correlationId,
    quantity: authority.quantity,
    hasBudget: authority.maxAmountMinor !== null,
  });

  // --- 2. Open the transaction through the Objective 3 boundary. ---
  const transactionId = await openTransaction(decision, deps);

  // The agent is the *actor* here, never the authority: this records what was
  // asked for, not what anything costs.
  await recordAuditEvent(deps.prisma, {
    transactionId,
    action: "intent_interpreted",
    actor: "buyer_agent",
    result: "SUCCESS",
    reasonCode: decision.constraints.requestType,
    trustedInputs: {
      requestType: decision.constraints.requestType,
      quantity: authority.quantity,
      maxBudgetMinor:
        authority.maxAmountMinor === null ? null : authority.maxAmountMinor.toString(),
      currency: authority.currency,
      budgetScope: authority.budgetScope,
    },
    correlationId,
    operationKey: `intent:${correlationId}`,
  });

  // --- 3. The server's own candidate set. ---
  const candidates = await retrieveCandidates(decision, authority, deps);

  // A hard requirement the catalog carries no field for cannot be checked, and
  // the model's belief that a product satisfies it is not evidence. Ask.
  const unverifiable = unverifiableRequirements(candidates, authority.hardRequirements);
  if (unverifiable.length > 0) {
    return {
      kind: "HARD_REQUIREMENT_UNVERIFIABLE",
      correlationId,
      requirements: unverifiable.map((requirement) => requirement.attribute),
    };
  }

  // --- 4. Deterministic filtering. ---
  const eligible = eligibleCandidates(candidates, authority);
  if (eligible.length === 0) {
    const reasons = [
      ...new Set(
        candidates.flatMap((product) => ineligibilityReasons(product, authority)),
      ),
    ];
    await recordAuditEvent(deps.prisma, {
      transactionId,
      action: "no_candidate_matched",
      actor: "product_decision_engine",
      result: "FAILURE",
      reasonCode: "NO_ELIGIBLE_CANDIDATE",
      trustedInputs: {
        candidatesConsidered: candidates.length,
        quantity: authority.quantity,
        reasons,
      },
      correlationId,
      operationKey: `no-candidate:${correlationId}`,
    });
    return {
      kind: "NO_VALID_CANDIDATE",
      correlationId,
      transactionId,
      // Every distinct reason across the rejected candidates, so the shopper
      // learns what actually stood in the way rather than one product's story.
      reasons,
    };
  }

  // --- 5. The proposed id must belong to the server's set. ---
  //
  // When it does not, the proposal is rejected and audited no matter what -
  // that guard is the trust model and nothing below softens it. What follows
  // the rejection is the only thing that changed: if the *sole* thing wrong
  // with the proposal was that the item is out of stock, the server may pick a
  // replacement from its own eligible set rather than leaving the shopper at a
  // dead end. The replacement is the server's choice, from the server's
  // catalog, checked by the same arithmetic as everything else; the model gets
  // no second say in it.
  const proposedSelection = eligible.find((p) => p.id === decision.selectedProductId);
  let selected = proposedSelection;
  let substitutedFor: string | null = null;

  if (proposedSelection === undefined) {
    const proposed = candidates.find((p) => p.id === decision.selectedProductId);
    const reasons =
      proposed === undefined ? [] : ineligibilityReasons(proposed, authority);

    log.warn("rejected an ineligible ai selection", {
      correlationId,
      selectedProductId: decision.selectedProductId,
    });
    // The hallucination guard firing is exactly the kind of event a reader of
    // this trail is looking for.
    await recordAuditEvent(deps.prisma, {
      transactionId,
      action: "product_selection_rejected",
      actor: "product_decision_engine",
      result: "BLOCKED",
      reasonCode: "AI_SELECTION_NOT_ELIGIBLE",
      trustedInputs: {
        productId: decision.selectedProductId,
        quantity: authority.quantity,
        candidatesConsidered: candidates.length,
        reasons,
      },
      correlationId,
      operationKey: `selection-rejected:${correlationId}`,
    });

    const alternative = refusedOnlyForAvailability(reasons)
      ? nextBestAlternative(candidates, authority, decision.selectedProductId)
      : null;

    if (alternative === null) {
      return {
        kind: "AI_SELECTION_REJECTED",
        correlationId,
        transactionId,
        selectedProductId: decision.selectedProductId,
        reasons,
      };
    }

    log.info("substituted an in-stock alternative for an unavailable proposal", {
      correlationId,
      substitutedForProductId: decision.selectedProductId,
    });
    selected = alternative;
    substitutedFor = decision.selectedProductId;
  }

  if (selected === undefined) {
    return {
      kind: "AI_SELECTION_REJECTED",
      correlationId,
      transactionId,
      selectedProductId: decision.selectedProductId,
      reasons: [],
    };
  }

  // Narrowed rather than cast: `eligibleCandidates` already established this
  // product passes, so the assessment is known to be the eligible arm.
  const assessment = assessCandidate(selected, authority);
  const selectionReasons: readonly EligibilityReason[] =
    assessment.kind === "ELIGIBLE" ? assessment.reasons : [];

  // --- 6. The lifecycle, through the state machine. ---
  //
  // Each step records the decision and then moves the lifecycle, inside one
  // database transaction. Both halves of that matter: the audit entry must
  // commit with the transition it explains rather than beside it, and it must
  // be written *first*, so the timeline reads in the order things actually
  // happened - a selection, and then the state change it caused.
  const selectionOutcome = await deps.prisma.$transaction(async (tx) => {
    await recordAuditEvent(tx, {
      transactionId,
      action: "product_selected",
      actor: "product_decision_engine",
      result: "SUCCESS",
      reasonCode:
        substitutedFor === null ? "PRODUCT_SELECTED" : "PRODUCT_SUBSTITUTED_UNAVAILABLE",
      trustedInputs: {
        productId: selected.id,
        quantity: authority.quantity,
        candidatesConsidered: candidates.length,
        reasons: [...selectionReasons],
        ...(substitutedFor === null ? {} : { substitutedForProductId: substitutedFor }),
      },
      correlationId,
      operationKey: `product-selected:${correlationId}`,
    });
    return applyTransactionEventWithin(tx, {
      transactionId,
      event: "PRODUCT_SELECTION_CONFIRMED",
      actor: "product_decision_engine",
      idempotencyKey: `${correlationId}:product-selected`,
      details: { productId: selected.id, quantity: authority.quantity },
    });
  });
  if (selectionOutcome.kind === "LATE_EVENT_HELD") {
    return { kind: "REEVALUATION_REQUIRED", correlationId, transactionId, reasons: [] };
  }

  const verificationOutcome = await deps.prisma.$transaction(async (tx) => {
    // The authoritative catalog facts, as the server read them. Not the agent's
    // claim about the price - that claim is never an audited fact.
    await recordAuditEvent(tx, {
      transactionId,
      action: "product_verified",
      actor: "merchant_service",
      result: "SUCCESS",
      reasonCode: "PRODUCT_VERIFIED",
      trustedInputs: {
        productId: selected.id,
        unitAmountMinor: selected.amount.amountMinor,
        currency: selected.amount.currency,
        availableQuantity: selected.availability.quantity,
        productVersion: selected.version,
      },
      correlationId,
      operationKey: `product-verified:${correlationId}`,
    });
    return applyTransactionEventWithin(tx, {
      transactionId,
      event: "PRODUCT_VERIFICATION_SUCCEEDED",
      actor: "merchant_service",
      idempotencyKey: `${correlationId}:product-verified`,
      details: { productId: selected.id },
    });
  });
  if (verificationOutcome.kind === "LATE_EVENT_HELD") {
    return { kind: "REEVALUATION_REQUIRED", correlationId, transactionId, reasons: [] };
  }

  // --- 7. Fresh read, quote and QUOTE_CREATED, atomically. ---
  try {
    const created = await createTrustedQuote(
      {
        transactionId,
        productId: selected.id,
        quantity: authority.quantity,
        authority,
        idempotencyKey: `${correlationId}:quote-issued`,
      },
      { prisma: deps.prisma, clock: deps.clock, ttlSeconds: deps.quoteTtlSeconds },
    );

    log.info("purchase decision finished", {
      correlationId,
      result: "QUOTE_CREATED",
      quoteId: created.snapshot.quoteId,
      reused: created.alreadyExisted,
    });

    return {
      kind: "QUOTE_CREATED",
      correlationId,
      transactionId,
      quote: toQuoteDto(created.snapshot),
      selectionReasons,
    };
  } catch (error) {
    if (error instanceof QuoteProductChangedError) {
      // The product moved between the candidate read and the write. The stale
      // facts have no authority, and the shopper's budget does not stretch to
      // cover the difference - so nothing is quoted.
      log.warn("purchase decision requires re-evaluation", {
        correlationId,
        transactionId,
        reasons: [...error.reasons],
      });
      return {
        kind: "REEVALUATION_REQUIRED",
        correlationId,
        transactionId,
        reasons: error.reasons,
      };
    }
    throw error;
  }
}
