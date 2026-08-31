import { InfrastructureError, NotFoundError, ValidationError } from "@/domain/errors";
import type { JsonObject } from "@/lib/json";

/**
 * Catalog failures, as stable machine-readable codes.
 *
 * Each extends the project-wide taxonomy, so it carries an operator-facing
 * message and a deliberately dull public one, and its HTTP status comes from
 * its category rather than from a hand-written number at a call site.
 *
 * A software client is expected to branch on `code`, never on message text.
 * The messages may be reworded; the codes are the contract.
 */

/** The query string did not parse: a bad value, a bad bound, an unknown parameter. */
export class InvalidCatalogQueryError extends ValidationError {
  constructor(reason: string, details: JsonObject = {}) {
    super({
      code: "INVALID_QUERY",
      message: `Catalog query rejected: ${reason}`,
      publicMessage: `The catalog query was not valid: ${reason}`,
      details,
    });
  }
}

/**
 * An attribute filter was malformed.
 *
 * Distinct from `INVALID_QUERY` because the fix is different: the parameter was
 * recognised as an attribute filter, but its key or value is outside the
 * bounded contract.
 */
export class InvalidCatalogFilterError extends ValidationError {
  constructor(reason: string, details: JsonObject = {}) {
    super({
      code: "INVALID_FILTER",
      message: `Catalog attribute filter rejected: ${reason}`,
      publicMessage: `The attribute filter was not valid: ${reason}`,
      details,
    });
  }
}

/**
 * A budget was expressed in a currency this catalog does not quote.
 *
 * Its own code because silently comparing amounts across currencies is the
 * failure this class exists to make impossible. There is no conversion.
 */
export class UnsupportedCurrencyError extends ValidationError {
  constructor(requested: string, supported: readonly string[]) {
    super({
      code: "UNSUPPORTED_CURRENCY",
      message: `Currency ${requested} is not quoted by this catalog.`,
      publicMessage: `This catalog quotes only ${supported.join(", ")}.`,
      details: { supported: [...supported] },
    });
  }
}

/** The product id was not even a well-formed identifier; nothing was queried. */
export class InvalidProductIdError extends ValidationError {
  constructor() {
    super({
      code: "INVALID_PRODUCT_ID",
      message: "The product id is not a well-formed identifier.",
      publicMessage: "That product identifier is not valid.",
    });
  }
}

/**
 * No publicly visible product has that id.
 *
 * Deliberately indistinguishable from "exists but is not published". Telling a
 * caller that a discontinued product exists leaks the catalog's private state
 * and serves no client purpose - it cannot be bought either way.
 */
export class CatalogProductNotFoundError extends NotFoundError {
  constructor(productId: string) {
    super({
      code: "PRODUCT_NOT_FOUND",
      message: `No publicly visible product exists with id ${productId}.`,
      publicMessage: "That product could not be found.",
      details: { productId },
    });
  }
}

/** The configured catalog merchant is missing or not active. */
export class CatalogMerchantNotFoundError extends NotFoundError {
  constructor(slug: string) {
    super({
      code: "MERCHANT_NOT_FOUND",
      message: `No active merchant exists with slug ${slug}.`,
      publicMessage: "This catalog is not currently available.",
      details: { slug },
    });
  }
}

/**
 * The catalog could not be read.
 *
 * Wraps whatever the database threw so a Prisma error, a SQL fragment or a
 * connection string can never reach the network boundary. The cause is kept for
 * operators; `toPublicPayload()` shows none of it.
 */
export class CatalogReadFailureError extends InfrastructureError {
  constructor(operation: string, cause: unknown) {
    super({
      code: "INTERNAL_CATALOG_ERROR",
      message: `Reading the catalog failed during ${operation}.`,
      publicMessage: "The catalog is temporarily unavailable.",
      details: { operation },
      cause,
    });
  }
}
