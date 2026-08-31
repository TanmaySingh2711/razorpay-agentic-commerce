import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@/domain/money";
import {
  InvalidCatalogFilterError,
  InvalidCatalogQueryError,
  InvalidProductIdError,
  UnsupportedCurrencyError,
} from "@/domain/catalog/errors";

/**
 * The catalog query contract.
 *
 * Everything a caller may ask for is declared here, and anything else is
 * refused. That is the whole design: this is a *bounded* query language, not a
 * pass-through to the database. A client cannot express a filter that was not
 * anticipated, so there is nothing for a malicious or confused caller to smuggle
 * through - no SQL fragment, no Prisma `where`, no expression to evaluate.
 *
 * Two decisions here are load-bearing:
 *
 *  1. **Unknown parameters are rejected, not ignored.** A typo like
 *     `maxAmount=300000` instead of `maxAmountMinor=300000` would otherwise be
 *     silently dropped and the caller would receive products over their budget
 *     while believing the filter applied. For a component whose entire job is
 *     to bound spending, failing loudly is the only safe behaviour.
 *
 *  2. **No caller-supplied product facts.** There is no parameter for a price,
 *     a stock level, or a status, and there never may be. A caller states a
 *     budget - what *they* are willing to spend. What a product costs is read
 *     from PostgreSQL and is not open to negotiation.
 */

/** Sort orders a caller may request. A closed set, never a free-form field. */
export const CATALOG_SORT_ORDERS = [
  "updated_desc",
  "amount_asc",
  "amount_desc",
  "name_asc",
] as const;

export type CatalogSortOrder = (typeof CATALOG_SORT_ORDERS)[number];

export const DEFAULT_CATALOG_SORT: CatalogSortOrder = "updated_desc";

export const DEFAULT_CATALOG_LIMIT = 50;
export const MAX_CATALOG_LIMIT = 100;
export const MAX_CATALOG_OFFSET = 100_000;

/** How many attribute filters one request may carry. */
export const MAX_ATTRIBUTE_FILTERS = 8;

const ATTRIBUTE_PREFIX = "attribute.";

/**
 * Recognised parameters. Anything else is an error, so this set *is* the
 * public query surface.
 */
const KNOWN_PARAMETERS = new Set([
  "category",
  "maxAmountMinor",
  "currency",
  "sort",
  "limit",
  "offset",
]);

/**
 * Categories are ASCII slugs, matching how the catalog stores them. Rejecting
 * everything else keeps confusable Unicode out of a filter that decides what a
 * buyer sees.
 */
const CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * A budget: digits only. No sign, no decimal point, no exponent, and a length
 * bound well inside the safe integer range. `-1`, `1.5`, `1e6` and a
 * thousand-digit number are all rejected here rather than coerced.
 */
const MINOR_UNITS_PATTERN = /^\d{1,15}$/;

const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_ATTRIBUTE_VALUE_LENGTH = 100;

/** UUID, any version. Product ids are UUIDv7, issued by the server. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attribute values are scalars. There is no nested or array matching. */
export type AttributeFilterValue = string | number | boolean;

export interface AttributeFilter {
  readonly key: string;
  readonly value: AttributeFilterValue;
}

export interface CatalogQuery {
  readonly category?: string;
  /** Inclusive upper bound in integer minor units, compared against the database. */
  readonly maxAmountMinor?: bigint;
  readonly currency?: CurrencyCode;
  readonly attributes: readonly AttributeFilter[];
  readonly sort: CatalogSortOrder;
  readonly limit: number;
  readonly offset: number;
}

function requireBoundedInteger(
  raw: string,
  name: string,
  min: number,
  max: number,
): number {
  if (!/^\d{1,7}$/.test(raw)) {
    throw new InvalidCatalogQueryError(`${name} must be a non-negative integer.`, {
      parameter: name,
    });
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new InvalidCatalogQueryError(
      `${name} must be between ${String(min)} and ${String(max)}.`,
      { parameter: name },
    );
  }
  return value;
}

/**
 * Interprets an attribute filter value.
 *
 * A query string carries only text, but the attributes column holds real JSON,
 * so `hotSwappable=true` has to become the boolean `true` to match a stored
 * boolean. The rules are fixed and total, in this order:
 *
 *   `true` / `false`            -> boolean
 *   an integer or decimal       -> number
 *   anything else               -> string
 *
 * The consequence is documented rather than hidden: a product whose attribute
 * is literally the *string* `"true"` cannot be matched by `=true`. Making the
 * rule order-dependent and written down beats guessing per request.
 *
 * Note this concerns product attributes only. Money never travels this path -
 * amounts are integer minor units and are compared as such.
 */
function interpretAttributeValue(raw: string): AttributeFilterValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d{1,15}$/.test(raw) || /^-?\d{1,15}\.\d{1,6}$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function parseAttributeFilters(params: URLSearchParams): readonly AttributeFilter[] {
  const filters: AttributeFilter[] = [];
  const seen = new Set<string>();

  for (const [name, raw] of params.entries()) {
    if (!name.startsWith(ATTRIBUTE_PREFIX)) continue;

    const key = name.slice(ATTRIBUTE_PREFIX.length);
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
      throw new InvalidCatalogFilterError(
        "an attribute name must be 1-40 letters, digits or underscores and start with a letter.",
      );
    }
    if (seen.has(key)) {
      // Two conflicting values for one attribute has no defensible meaning:
      // AND yields nothing, OR silently widens the filter. Refuse instead.
      throw new InvalidCatalogFilterError(
        `attribute "${key}" was filtered more than once.`,
        { attribute: key },
      );
    }
    if (raw.length === 0 || raw.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      throw new InvalidCatalogFilterError(
        `attribute "${key}" needs a value of 1-${String(MAX_ATTRIBUTE_VALUE_LENGTH)} characters.`,
        { attribute: key },
      );
    }

    seen.add(key);
    filters.push({ key, value: interpretAttributeValue(raw) });
  }

  if (filters.length > MAX_ATTRIBUTE_FILTERS) {
    throw new InvalidCatalogFilterError(
      `at most ${String(MAX_ATTRIBUTE_FILTERS)} attribute filters are allowed.`,
    );
  }
  return filters;
}

function parseCurrency(raw: string): CurrencyCode {
  const candidate = raw.toUpperCase();
  const supported = SUPPORTED_CURRENCIES.find((code) => code === candidate);
  if (supported === undefined) {
    throw new UnsupportedCurrencyError(raw.slice(0, 16), SUPPORTED_CURRENCIES);
  }
  return supported;
}

/**
 * Parses and validates a catalog query, or throws a typed error.
 *
 * Returns a fully-resolved query: sort, limit and offset always have values, so
 * downstream code never re-applies a default and the two cannot disagree.
 */
export function parseCatalogQuery(params: URLSearchParams): CatalogQuery {
  for (const name of params.keys()) {
    if (KNOWN_PARAMETERS.has(name) || name.startsWith(ATTRIBUTE_PREFIX)) continue;
    throw new InvalidCatalogQueryError(
      `unknown parameter "${name.slice(0, 40)}". A mistyped filter must not be silently ignored.`,
    );
  }

  const category = params.get("category");
  if (category !== null && !CATEGORY_PATTERN.test(category)) {
    throw new InvalidCatalogQueryError(
      "category must be 1-64 characters of letters, digits, spaces, dot, underscore or hyphen.",
      { parameter: "category" },
    );
  }

  const rawMax = params.get("maxAmountMinor");
  const rawCurrency = params.get("currency");

  if (rawMax !== null && !MINOR_UNITS_PATTERN.test(rawMax)) {
    throw new InvalidCatalogQueryError(
      "maxAmountMinor must be a whole number of minor units (paise), with no sign, decimal point or separators, and at most 15 digits.",
      { parameter: "maxAmountMinor" },
    );
  }
  if (rawMax !== null && rawCurrency === null) {
    // An amount without a currency is not a budget, it is an ambiguity. There
    // is no default here on purpose: guessing is how cross-currency
    // comparisons happen.
    throw new InvalidCatalogQueryError("maxAmountMinor requires an explicit currency.", {
      parameter: "currency",
    });
  }

  const currency = rawCurrency === null ? undefined : parseCurrency(rawCurrency);

  const sortRaw = params.get("sort");
  const sort =
    sortRaw === null
      ? DEFAULT_CATALOG_SORT
      : (CATALOG_SORT_ORDERS.find((order) => order === sortRaw) ??
        (() => {
          throw new InvalidCatalogQueryError(
            `sort must be one of ${CATALOG_SORT_ORDERS.join(", ")}.`,
            { parameter: "sort" },
          );
        })());

  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");

  return {
    ...(category === null ? {} : { category }),
    ...(rawMax === null ? {} : { maxAmountMinor: BigInt(rawMax) }),
    ...(currency === undefined ? {} : { currency }),
    attributes: parseAttributeFilters(params),
    sort,
    limit:
      limitRaw === null
        ? DEFAULT_CATALOG_LIMIT
        : requireBoundedInteger(limitRaw, "limit", 1, MAX_CATALOG_LIMIT),
    offset:
      offsetRaw === null
        ? 0
        : requireBoundedInteger(offsetRaw, "offset", 0, MAX_CATALOG_OFFSET),
  };
}

/**
 * Validates a product id before it reaches the database.
 *
 * Prisma parameterises queries, so this is not what prevents injection - it is
 * what stops an obviously malformed id becoming a pointless round trip and a
 * misleading 404. A well-formed id that does not exist is a genuine 404; a
 * malformed one is a bad request, and the two deserve different codes.
 */
export function parseProductId(raw: string): string {
  if (!UUID_PATTERN.test(raw)) {
    throw new InvalidProductIdError();
  }
  return raw;
}
