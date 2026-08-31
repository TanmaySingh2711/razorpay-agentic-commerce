import type { QuoteDto, QuoteInvalidationReason } from "@/domain/quote/rules";
import type {
  EligibilityReason,
  IneligibilityReason,
} from "@/domain/product-decision/eligibility";

/**
 * What the purchase-decision boundary returns.
 *
 * A discriminated union, because every one of these outcomes means something
 * different to a caller and several of them are refusals that must not be
 * mistaken for a quote. There is no shape here that carries a half-built quote,
 * and no field that is "usually" populated.
 *
 * The refusals matter more than the success. `QUOTE_CREATED` is one branch;
 * the other seven are the ways the server declines to put a price behind an AI
 * proposal, and each names a distinct thing the caller can act on.
 */

/** Why the server would not produce a quote from this proposal. */
export type PurchaseDecisionResult =
  | {
      readonly kind: "QUOTE_CREATED";
      readonly correlationId: string;
      readonly transactionId: string;
      readonly quote: QuoteDto;
      /** Deterministic reasons only. Never model narration. */
      readonly selectionReasons: readonly EligibilityReason[];
    }
  | {
      readonly kind: "NO_QUOTE_REQUIRED";
      readonly correlationId: string;
      /** BROWSE and RECOMMEND are legitimate requests that buy nothing. */
      readonly requestType: string;
    }
  | {
      readonly kind: "CLARIFICATION_REQUIRED";
      readonly correlationId: string;
      readonly question: string;
      readonly ambiguousFields: readonly string[];
    }
  | {
      readonly kind: "HARD_REQUIREMENT_UNVERIFIABLE";
      readonly correlationId: string;
      /** Requirements the catalog carries no structured field for. */
      readonly requirements: readonly string[];
    }
  | {
      readonly kind: "NO_VALID_CANDIDATE";
      readonly correlationId: string;
      readonly transactionId: string | null;
      readonly reasons: readonly IneligibilityReason[];
    }
  | {
      readonly kind: "AI_SELECTION_REJECTED";
      readonly correlationId: string;
      readonly transactionId: string | null;
      readonly selectedProductId: string;
      readonly reasons: readonly IneligibilityReason[];
    }
  | {
      readonly kind: "REEVALUATION_REQUIRED";
      readonly correlationId: string;
      readonly transactionId: string;
      /** What changed between the agent's read and the authoritative one. */
      readonly reasons: readonly QuoteInvalidationReason[];
    };

export type PurchaseDecisionKind = PurchaseDecisionResult["kind"];

/** What `validateQuoteForUse` answers. Objectives 7-10 branch on this. */
export type QuoteValidationResult =
  | { readonly kind: "VALID"; readonly quote: QuoteDto }
  | { readonly kind: "EXPIRED"; readonly quote: QuoteDto }
  | {
      readonly kind: "INVALIDATED";
      readonly quote: QuoteDto;
      readonly reasons: readonly QuoteInvalidationReason[];
    }
  | { readonly kind: "NOT_FOUND"; readonly quoteId: string };

/**
 * Why a quote could not be relied upon at the moment something tried to use it.
 *
 * A flat cause, separate from `QuoteValidationResult`, because a caller that
 * merely needs to decide "re-quote, or give up" should not have to reconstruct
 * that from a union whose arms carry different payloads - and because one of
 * these causes has no committed row to describe at all.
 */
export const QUOTE_UNUSABLE_CAUSES = [
  /** The validity window had elapsed. */
  "EXPIRED",
  /** The product moved underneath it: price, stock, currency or version. */
  "INVALIDATED",
  /** There is no such quote. */
  "NOT_FOUND",
  /**
   * It stopped being usable *between* validation and the write transaction.
   *
   * Its own cause because there is no committed state that describes it: the
   * transaction that observed the change rolled back, so nothing was recorded.
   * Reporting it as NOT_FOUND - which the quote plainly is not - would invite a
   * caller to abandon a purchase that only needed a fresh quote.
   */
  "CHANGED_DURING_EVALUATION",
] as const;

export type QuoteUnusableCause = (typeof QUOTE_UNUSABLE_CAUSES)[number];
