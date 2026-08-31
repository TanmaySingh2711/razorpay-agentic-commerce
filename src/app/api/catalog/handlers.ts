import { jsonData, respond } from "@/lib/api-response";
import { parseCatalogQuery, parseProductId } from "@/domain/catalog/query";
import { CATALOG_CONTRACT_VERSION } from "@/domain/catalog/contracts";
import {
  defaultCatalogDeps,
  getCatalogMerchant,
  getCatalogProduct,
  searchCatalogProducts,
  type CatalogServiceDeps,
} from "@/services/merchant/catalog-service";
import type { JsonObject, JsonValue } from "@/lib/json";

/**
 * HTTP for the catalog.
 *
 * These are the route handlers' bodies, kept beside the routes but out of
 * `route.ts` for one concrete reason: a `route.ts` file may only export the
 * HTTP methods and Next's segment config, so there is nowhere to put a
 * dependency seam. Here, each handler takes its dependencies as an argument
 * and defaults them, exactly as the transaction services do - which lets the
 * integration tests drive the real handlers against the isolated test schema
 * instead of the development database.
 *
 * Each handler does three things and nothing else: validate the request, call
 * one service, map the result to a response. There is no business logic here,
 * no persistence, and no error handling beyond funnelling everything into the
 * shared envelope.
 */

/**
 * DTOs are structurally JSON, but TypeScript will not infer that through an
 * interface with a `readonly` index-free shape. This asserts the intent at the
 * one place responses are built, rather than weakening the DTO types.
 */
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

const CATALOG_META: JsonObject = { catalogVersion: CATALOG_CONTRACT_VERSION };

/** `GET /api/catalog/merchant` */
export function handleMerchantRequest(
  deps: CatalogServiceDeps = defaultCatalogDeps(),
): Promise<Response> {
  return respond(async () =>
    jsonData(asJson(await getCatalogMerchant(deps)), CATALOG_META),
  );
}

/** `GET /api/catalog/products` */
export function handleProductSearchRequest(
  request: Request,
  deps: CatalogServiceDeps = defaultCatalogDeps(),
): Promise<Response> {
  return respond(async () => {
    // Validation happens before anything touches the database, so a malformed
    // query costs a round trip to nobody and fails with a precise code.
    const query = parseCatalogQuery(new URL(request.url).searchParams);
    const result = await searchCatalogProducts(query, deps);

    return jsonData(asJson(result.products), {
      ...CATALOG_META,
      // Enough for a client to page deterministically without guessing.
      count: result.products.length,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      sort: query.sort,
    });
  });
}

/** `GET /api/catalog/products/[productId]` */
export function handleProductByIdRequest(
  rawProductId: string,
  deps: CatalogServiceDeps = defaultCatalogDeps(),
): Promise<Response> {
  return respond(async () => {
    const productId = parseProductId(rawProductId);
    return jsonData(asJson(await getCatalogProduct(productId, deps)), CATALOG_META);
  });
}
