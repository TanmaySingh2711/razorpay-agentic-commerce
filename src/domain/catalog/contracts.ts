import type { JsonObject, JsonValue } from "@/lib/json";
import type { MoneyDto } from "@/domain/money";
import { isJsonObject } from "@/lib/json";

/**
 * The public, machine-readable catalog contract.
 *
 * This file defines what a software client - today a test, tomorrow the AI
 * Buyer Agent - actually receives. It is deliberately separate from the Prisma
 * model, because those two things answer different questions: the model is how
 * we store a product, the contract is what we are willing to promise about one.
 *
 * Returning a Prisma row directly would couple every future consumer to the
 * database schema, leak columns the moment one is added, and fail outright on
 * `BigInt` serialization. Every response is mapped through here instead.
 *
 * The contract is designed so a machine never has to read prose. Price,
 * currency, stock, purchasability, category and structured attributes are all
 * discrete typed fields. Nothing important is knowable only by parsing the
 * `name` or `description` - those are merchant-authored text and are treated
 * strictly as data (see docs/18-agent-readable-catalog.md).
 */

/**
 * Version of the *API contract*, not of any product row.
 *
 * A consumer can assert on it to notice a breaking shape change. It is not a
 * negotiation mechanism: there is one contract, and this names it.
 */
export const CATALOG_CONTRACT_VERSION = "1";

/**
 * Product statuses that may appear in the public catalog at all.
 *
 * An allowlist rather than "everything except DISCONTINUED": a status added to
 * the schema later is then hidden by default and has to be published
 * deliberately, which is the safe direction for a mistake to fall.
 */
export const PUBLICLY_LISTED_PRODUCT_STATUSES = ["AVAILABLE", "OUT_OF_STOCK"] as const;

export type PubliclyListedProductStatus =
  (typeof PUBLICLY_LISTED_PRODUCT_STATUSES)[number];

export const AVAILABILITY_STATUSES = ["AVAILABLE", "OUT_OF_STOCK"] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

/**
 * Whether a product can be bought right now, and why.
 *
 * `purchasable` is the single field a client should branch on. It is derived,
 * never stored, so "listed" and "buyable" cannot drift apart: a response can
 * never say a product is out of stock and simultaneously purchasable.
 */
export interface AvailabilityDto {
  readonly status: AvailabilityStatus;
  /** Authoritative stock from PostgreSQL. Never supplied by a caller. */
  readonly quantity: number;
  readonly purchasable: boolean;
}

/**
 * One product, as promised to a machine client.
 *
 * `amount` is the authoritative unit price read from PostgreSQL, in integer
 * minor units as a string (see `MoneyDto`). There is no formatted display
 * string here on purpose: the UI formats money, the API states it.
 */
export interface CatalogProductDto {
  readonly id: string;
  readonly merchantId: string;
  /** The merchant's public product code. Stable, and safe to show. */
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly amount: MoneyDto;
  readonly availability: AvailabilityDto;
  readonly attributes: JsonObject;
  /** Merchant-managed revision counter. */
  readonly version: number;
  /** Database-maintained modification time, ISO 8601. The freshness signal. */
  readonly updatedAt: string;
}

/** Public merchant metadata. Carries no configuration and no credentials. */
export interface CatalogMerchantDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** Currencies this catalog quotes in. Today exactly one. */
  readonly supportedCurrencies: readonly string[];
  readonly updatedAt: string;
  readonly catalogVersion: string;
}

/** The authoritative product facts this module maps from. */
export interface ProductRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly unitAmount: bigint;
  readonly currency: string;
  readonly inventory: number;
  readonly status: string;
  readonly attributes: unknown;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface MerchantRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly updatedAt: Date;
}

/**
 * Derives purchasability from authoritative fields only.
 *
 * Both conditions are required, and they mean different things: `status` is the
 * merchant's publication decision, `inventory` is physical stock. A product the
 * merchant has marked `OUT_OF_STOCK` stays unpurchasable even if a stock number
 * disagrees, and an `AVAILABLE` product with zero stock is reported honestly
 * rather than hidden - a client is told *why* it cannot buy.
 *
 * Nothing here reads the description. Merchant text has no authority over
 * whether something can be sold.
 */
export function deriveAvailability(status: string, inventory: number): AvailabilityDto {
  const purchasable = status === "AVAILABLE" && inventory > 0;
  return {
    status: purchasable ? "AVAILABLE" : "OUT_OF_STOCK",
    quantity: inventory,
    purchasable,
  };
}

/**
 * Normalises the JSON attributes column to an object.
 *
 * The column is `Json`, so PostgreSQL would accept an array, a string or a
 * number there. The contract promises an object, so anything else becomes an
 * empty one rather than changing the response's shape under a consumer. This is
 * a shape guarantee, not sanitisation: the *values* inside a genuine object are
 * passed through untouched, however strange their text.
 */
export function normaliseAttributes(attributes: unknown): JsonObject {
  return isJsonObject(attributes as JsonValue) ? (attributes as JsonObject) : {};
}

/**
 * The single mapping from a database row to the public contract.
 *
 * Every field is named explicitly. A column added to the Product model does not
 * appear in an API response until someone writes it here, which is the point:
 * exposure is a decision, not a side effect.
 */
export function toCatalogProductDto(product: ProductRecord): CatalogProductDto {
  return {
    id: product.id,
    merchantId: product.merchantId,
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    amount: {
      amountMinor: product.unitAmount.toString(),
      currency: product.currency as MoneyDto["currency"],
    },
    availability: deriveAvailability(product.status, product.inventory),
    attributes: normaliseAttributes(product.attributes),
    version: product.version,
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function toCatalogMerchantDto(
  merchant: MerchantRecord,
  supportedCurrencies: readonly string[],
): CatalogMerchantDto {
  return {
    id: merchant.id,
    name: merchant.name,
    slug: merchant.slug,
    supportedCurrencies,
    updatedAt: merchant.updatedAt.toISOString(),
    catalogVersion: CATALOG_CONTRACT_VERSION,
  };
}
