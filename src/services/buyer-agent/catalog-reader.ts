import {
  defaultCatalogDeps,
  getCatalogMerchant,
  getCatalogProduct,
  searchCatalogProducts,
  type CatalogSearchResult,
  type CatalogServiceDeps,
} from "@/services/merchant/catalog-service";
import type { CatalogMerchantDto, CatalogProductDto } from "@/domain/catalog/contracts";
import type { CatalogQuery } from "@/domain/catalog/query";

/**
 * The catalog, as the Buyer Agent sees it.
 *
 * A narrow read port with exactly the three operations the agent's tools need.
 * It is not a second catalog: `createServiceCatalogReader` delegates straight to
 * the Objective 4 application service, in-process, so there is one set of
 * visibility rules, one price authority and one place filtering happens. A
 * modular monolith calling its own HTTP API would only add a network hop and a
 * second copy of the query rules to keep in sync.
 *
 * The port exists for two reasons that are worth the small indirection:
 *
 *  - it lets the agent's tests run against an in-memory catalog, so the budget,
 *    provenance and injection rules are proven without a database or an API
 *    key, and
 *  - it keeps the agent's dependency on the catalog explicit and read-only. The
 *    port has no method that could write, so no amount of prompt persuasion can
 *    reach one.
 */
export interface CatalogReader {
  searchProducts(query: CatalogQuery): Promise<CatalogSearchResult>;
  getProduct(productId: string): Promise<CatalogProductDto>;
  getMerchant(): Promise<CatalogMerchantDto>;
}

/** The production reader: the Objective 4 catalog service, unchanged. */
export function createServiceCatalogReader(
  deps: CatalogServiceDeps = defaultCatalogDeps(),
): CatalogReader {
  return {
    searchProducts: (query) => searchCatalogProducts(query, deps),
    getProduct: (productId) => getCatalogProduct(productId, deps),
    getMerchant: () => getCatalogMerchant(deps),
  };
}
