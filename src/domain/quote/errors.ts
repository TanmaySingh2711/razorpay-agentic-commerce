import { DomainRuleError, InfrastructureError, ValidationError } from "@/domain/errors";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";

/**
 * Failures of the trusted-quote boundary.
 *
 * The distinction that runs through these: a product that *changed* is not a
 * fault. Prices move and stock sells out, and a server that refuses to quote
 * because the world moved is behaving correctly. That case is a domain rule,
 * carries structured reasons, and invites a re-evaluation. Only a genuine
 * inability to commit is infrastructure.
 */

/**
 * The authoritative row no longer supports the quote that was about to be made.
 *
 * Thrown from inside the write transaction, so the partially written quote is
 * rolled back with it. The caller turns it into `REEVALUATION_REQUIRED`; it is
 * never repaired by adjusting an amount, because the amount is not the thing
 * that was wrong.
 */
export class QuoteProductChangedError extends DomainRuleError {
  readonly reasons: readonly QuoteInvalidationReason[];

  constructor(reasons: readonly QuoteInvalidationReason[]) {
    super({
      code: "QUOTE_PRODUCT_CHANGED",
      message: `The product changed before the quote could be created: ${reasons.join(", ")}`,
      publicMessage: "This product changed while we were preparing your order.",
      details: { reasons: [...reasons] },
      retryable: true,
    });
    this.reasons = reasons;
  }
}

/** The quote and its lifecycle transition could not be committed together. */
export class QuoteCreationFailureError extends InfrastructureError {
  constructor(reason: string, cause?: unknown) {
    super({
      code: "QUOTE_CREATION_FAILED",
      message: `Creating the purchase quote failed: ${reason}`,
      publicMessage: "We could not prepare your order. Please try again.",
      details: { reason },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/**
 * The agent proposed a product the server will not quote.
 *
 * Its own type because it is the hallucination guard firing, not an ordinary
 * validation slip: the id either never appeared in the server's own candidate
 * set, or the product it names fails a check the model was told about.
 */
export class SelectionNotEligibleError extends ValidationError {
  constructor(productId: string, reasons: readonly string[]) {
    super({
      code: "AI_SELECTION_NOT_ELIGIBLE",
      message: `The proposed product ${productId} is not an eligible candidate: ${reasons.join(", ")}`,
      publicMessage: "That product cannot be purchased under your requirements.",
      details: { productId, reasons: [...reasons] },
    });
  }
}
