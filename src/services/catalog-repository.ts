import { assertServerOnly } from "@/lib/server-only";
import { CatalogReadFailureError } from "@/domain/catalog/errors";
import { PUBLICLY_LISTED_PRODUCT_STATUSES } from "@/domain/catalog/contracts";
import type { CatalogQuery } from "@/domain/catalog/query";
import type { MerchantRecord, ProductRecord } from "@/domain/catalog/contracts";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * The catalog's read boundary.
 *
 * Every SQL-shaped decision in the catalog lives here and nowhere else - no
 * Prisma call in a route handler, none in the service, none in a component.
 * The service above deals in domain terms and never learns a column name.
 *
 * Three properties this file is responsible for:
 *
 *  1. **Filtering happens in PostgreSQL.** Budget, category, visibility and
 *     attribute matching all become SQL. Fetching the catalog and filtering it
 *     in JavaScript would work at six products and fail badly at six thousand,
 *     and it would move a financial comparison out of the database that owns
 *     the authoritative number.
 *
 *  2. **Nothing is interpolated.** Every caller-supplied value reaches the
 *     database as a bound parameter through Prisma's query builder. There is
 *     no string-built SQL here, so there is no escaping to get wrong.
 *
 *  3. **Errors never escape raw.** A Prisma failure carries connection detail
 *     and SQL in its message, so it is wrapped before it can travel.
 *
 * Read-only by construction: this module calls `findMany`, `findFirst` and
 * `count`. It writes nothing, and Objective 4 has no reason to.
 */
assertServerOnly("src/services/merchant/catalog-repository.ts");

/**
 * Columns the public catalog is allowed to read.
 *
 * An explicit projection, not `select: undefined`. A column added to the
 * Product model later is not fetched - let alone returned - until someone adds
 * it here deliberately.
 */
const PUBLIC_PRODUCT_COLUMNS = {
  id: true,
  merchantId: true,
  sku: true,
  name: true,
  description: true,
  category: true,
  unitAmount: true,
  currency: true,
  inventory: true,
  status: true,
  attributes: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ProductSelect;

/**
 * Translates a validated query into a Prisma filter.
 *
 * The visibility clause is unconditional and comes first: it is not one filter
 * among several but the precondition for appearing at all, so no combination of
 * caller-supplied parameters can widen it.
 */
function buildWhere(merchantId: string, query: CatalogQuery): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = {
    merchantId,
    status: { in: [...PUBLICLY_LISTED_PRODUCT_STATUSES] },
  };

  if (query.category !== undefined) {
    // Case-insensitive equality, evaluated by PostgreSQL. Exact matching would
    // make "Mechanical-Keyboard" and "mechanical-keyboard" different
    // categories, which is a surprise with no upside for a machine client.
    where.category = { equals: query.category, mode: "insensitive" };
  }

  if (query.maxAmountMinor !== undefined) {
    // Integer comparison against the authoritative BIGINT column. No float, no
    // formatted string, and no amount supplied by the caller - only their
    // stated ceiling.
    where.unitAmount = { lte: query.maxAmountMinor };
  }

  if (query.currency !== undefined) {
    // Paired with the budget so amounts are never compared across currencies.
    where.currency = query.currency;
  }

  if (query.attributes.length > 0) {
    // One JSON path predicate per attribute, ANDed. `path` and `equals` are
    // parameterised by Prisma; the key is already bounded by the query
    // contract. An attribute nobody has simply matches nothing.
    where.AND = query.attributes.map((filter) => ({
      attributes: { path: [filter.key], equals: filter.value },
    }));
  }

  return where;
}

/**
 * Ordering, always with `id` as the final tie-break.
 *
 * PostgreSQL guarantees no row order without an ORDER BY, and two products can
 * share an `updatedAt` or a price. Without the tie-break, paging through the
 * catalog could show one product twice and skip another.
 */
function buildOrderBy(query: CatalogQuery): Prisma.ProductOrderByWithRelationInput[] {
  switch (query.sort) {
    case "amount_asc":
      return [{ unitAmount: "asc" }, { id: "asc" }];
    case "amount_desc":
      return [{ unitAmount: "desc" }, { id: "asc" }];
    case "name_asc":
      return [{ name: "asc" }, { id: "asc" }];
    case "updated_desc":
      return [{ updatedAt: "desc" }, { id: "asc" }];
  }
}

export interface CatalogRepositoryDeps {
  readonly prisma: PrismaClient;
}

async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new CatalogReadFailureError(operation, error);
  }
}

/** The merchant behind this catalog, or null if it is missing or not active. */
export async function findActiveMerchantBySlug(
  slug: string,
  deps: CatalogRepositoryDeps,
): Promise<MerchantRecord | null> {
  return guarded("merchant lookup", () =>
    deps.prisma.merchant.findFirst({
      where: { slug, status: "ACTIVE" },
      select: { id: true, name: true, slug: true, updatedAt: true },
    }),
  );
}

export interface ProductPage {
  readonly products: readonly ProductRecord[];
  /** Total matching the filters, ignoring limit/offset. */
  readonly total: number;
}

/**
 * One page of publicly visible products.
 *
 * The count and the page are issued in a single `$transaction`, so a product
 * added between the two queries cannot produce a total that disagrees with the
 * rows returned beside it.
 */
export async function findVisibleProducts(
  merchantId: string,
  query: CatalogQuery,
  deps: CatalogRepositoryDeps,
): Promise<ProductPage> {
  const where = buildWhere(merchantId, query);

  return guarded("product search", async () => {
    const [products, total] = await deps.prisma.$transaction([
      deps.prisma.product.findMany({
        where,
        select: PUBLIC_PRODUCT_COLUMNS,
        orderBy: buildOrderBy(query),
        take: query.limit,
        skip: query.offset,
      }),
      deps.prisma.product.count({ where }),
    ]);
    return { products, total };
  });
}

/**
 * One publicly visible product by id.
 *
 * The visibility clause is part of the query rather than a check afterwards, so
 * an unpublished product is indistinguishable from a nonexistent one all the
 * way down - there is no branch that could accidentally return it.
 */
export async function findVisibleProductById(
  merchantId: string,
  productId: string,
  deps: CatalogRepositoryDeps,
): Promise<ProductRecord | null> {
  return guarded("product lookup", () =>
    deps.prisma.product.findFirst({
      where: {
        id: productId,
        merchantId,
        status: { in: [...PUBLICLY_LISTED_PRODUCT_STATUSES] },
      },
      select: PUBLIC_PRODUCT_COLUMNS,
    }),
  );
}
