import { assertServerOnly } from "@/lib/server-only";
import { getCatalogConfig } from "@/config/env";
import { getPrismaClient } from "@/integrations/persistence/client";
import { SUPPORTED_CURRENCIES } from "@/domain/money";
import {
  toCatalogMerchantDto,
  toCatalogProductDto,
  type CatalogMerchantDto,
  type CatalogProductDto,
} from "@/domain/catalog/contracts";
import {
  CatalogMerchantNotFoundError,
  CatalogProductNotFoundError,
} from "@/domain/catalog/errors";
import {
  findActiveMerchantBySlug,
  findVisibleProductById,
  findVisibleProducts,
} from "@/services/merchant/catalog-repository";
import type { CatalogQuery } from "@/domain/catalog/query";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The catalog application service.
 *
 * This is the layer a future consumer talks to - the Objective 5 Buyer Agent,
 * the UI, a test, an external client. It speaks in domain terms: a validated
 * query in, a public contract out. It knows nothing about HTTP and nothing
 * about columns.
 *
 * That separation is the point. When the Buyer Agent arrives it must read the
 * catalog through exactly the same code path a test does, so what the tests
 * prove about price authority and visibility is true of the agent too. A second
 * "agent-friendly" read path would be a second set of rules to get wrong.
 *
 * **Read-only.** Nothing here creates a Transaction, calls
 * `applyTransactionEvent`, issues a quote, evaluates policy, or reserves stock.
 * Reading the catalog is not part of a transaction's lifecycle and must not
 * start one.
 */
assertServerOnly("src/services/merchant/catalog-service.ts");

export interface CatalogServiceDeps {
  readonly prisma: PrismaClient;
  /** Which merchant this catalog serves. Configuration, never a request field. */
  readonly merchantSlug: string;
}

export function defaultCatalogDeps(): CatalogServiceDeps {
  return {
    prisma: getPrismaClient(),
    merchantSlug: getCatalogConfig().CATALOG_MERCHANT_SLUG,
  };
}

/**
 * Resolves the merchant every catalog read is scoped to.
 *
 * Scoping is done here, once, from configuration - so no endpoint takes a
 * merchant id from the caller and no query can reach another merchant's
 * products. An inactive merchant resolves to nothing at all rather than to an
 * empty catalog, because "this shop is closed" and "this shop has no stock" are
 * different answers.
 */
async function requireMerchant(deps: CatalogServiceDeps) {
  const merchant = await findActiveMerchantBySlug(deps.merchantSlug, deps);
  if (merchant === null) {
    throw new CatalogMerchantNotFoundError(deps.merchantSlug);
  }
  return merchant;
}

/** Public merchant metadata. Carries no configuration and no credentials. */
export async function getCatalogMerchant(
  deps: CatalogServiceDeps = defaultCatalogDeps(),
): Promise<CatalogMerchantDto> {
  const merchant = await requireMerchant(deps);
  return toCatalogMerchantDto(merchant, SUPPORTED_CURRENCIES);
}

export interface CatalogSearchResult {
  readonly products: readonly CatalogProductDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Deterministic catalog search.
 *
 * Deterministic is the operative word: the same query against the same data
 * returns the same products in the same order, every time. There is no
 * relevance scoring, no embedding, no model. An AI may *rank* what this returns,
 * but it ranks a set the database chose - the AI never decides which products
 * exist or what they cost.
 *
 * A query matching nothing is a successful, empty result, not an error. An
 * agent asking "anything under ₹500?" deserves a clean "no" it can act on.
 */
export async function searchCatalogProducts(
  query: CatalogQuery,
  deps: CatalogServiceDeps = defaultCatalogDeps(),
): Promise<CatalogSearchResult> {
  const merchant = await requireMerchant(deps);
  const page = await findVisibleProducts(merchant.id, query, deps);

  return {
    products: page.products.map(toCatalogProductDto),
    total: page.total,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * One product by its server-issued id.
 *
 * Throws `PRODUCT_NOT_FOUND` for an unknown id and for an unpublished one
 * alike. A caller cannot use this endpoint to discover that a discontinued
 * product exists, and it could not buy one either way.
 */
export async function getCatalogProduct(
  productId: string,
  deps: CatalogServiceDeps = defaultCatalogDeps(),
): Promise<CatalogProductDto> {
  const merchant = await requireMerchant(deps);
  const product = await findVisibleProductById(merchant.id, productId, deps);
  if (product === null) {
    throw new CatalogProductNotFoundError(productId);
  }
  return toCatalogProductDto(product);
}
