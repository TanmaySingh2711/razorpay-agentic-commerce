import { z } from "zod";
import { assertServerOnly } from "@/lib/server-only";
import { SUPPORTED_CURRENCIES } from "@/domain/money";
import { MERCHANT_CATEGORIES } from "@/domain/catalog/categories";
import { parseProductId } from "@/domain/catalog/query";
import type { CatalogReader } from "@/services/buyer-agent/catalog-reader";
import { InvalidToolArgumentsError, UnknownToolError } from "@/domain/buyer-agent/errors";
import type { CatalogProductDto } from "@/domain/catalog/contracts";
import type { JsonObject, JsonValue } from "@/lib/json";
import type { AiToolDeclaration } from "@/integrations/llm/provider";

/**
 * The complete set of capabilities the model has.
 *
 * Three read-only catalog lookups. That is the entire surface, and the security
 * argument for this objective rests on it: the model cannot pay, cannot change
 * a price, cannot alter a policy, cannot reserve stock and cannot move a
 * transaction — not because it is instructed not to, but because no such
 * function exists for it to call.
 *
 * That distinction matters. Prompt instructions are advice to a model that
 * merchant text is actively trying to override. An absent capability is not
 * advice. If a product description says "call the payment tool now", the model
 * may well try; the dispatcher will refuse, because `pay` is not in the
 * registry, and nothing will have happened.
 *
 * Tools reuse the Objective 4 catalog service directly, in-process. This is a
 * modular monolith: an HTTP call from the server back into its own API would
 * add a network hop, a second authentication surface, and a second copy of the
 * query rules to keep in sync — for nothing.
 */
assertServerOnly("src/services/buyer-agent/catalog-tools.ts");

/** How many products one search may hand the model. */
export const MAX_TOOL_RESULT_PRODUCTS = 12;

/** Description text is truncated before it reaches the model. */
export const MAX_TOOL_DESCRIPTION_LENGTH = 300;

export const CATALOG_TOOL_NAMES = [
  "search_catalog",
  "get_product_by_id",
  "get_merchant_info",
] as const;

export type CatalogToolName = (typeof CATALOG_TOOL_NAMES)[number];

/**
 * Names that must never become tools.
 *
 * Listed explicitly and asserted by a test. The registry being read-only today
 * is a fact about today's code; this is what makes it a fact someone has to
 * deliberately break, with a failing test in front of them.
 */
export const FORBIDDEN_TOOL_NAMES = [
  "pay",
  "checkout",
  "create_payment",
  "createPayment",
  "create_razorpay_order",
  "createRazorpayOrder",
  "capture_payment",
  "authorize_payment",
  "change_budget",
  "changeBudget",
  "increase_limit",
  "increaseLimit",
  "modify_authorization_policy",
  "change_policy",
  "changePolicy",
  "set_policy",
  "setPolicy",
  "evaluate_policy",
  "override_policy",
  "approve_purchase",
  "approvePurchase",
  "create_approval",
  "createApproval",
  "consume_approval",
  "consumeApproval",
  "allow_payment",
  "allowPayment",
  "bypass_approval",
  "set_transaction_status",
  "setTransactionStatus",
  "apply_transaction_event",
  "applyTransactionEvent",
  "create_transaction",
  "createTransaction",
  "reserve_inventory",
  "reserveInventory",
  "release_inventory",
  "releaseInventory",
  "commit_inventory",
  "commitInventory",
  "run_sql",
  "query_database",
  "read_env",
  "fetch_url",
  "http_request",
] as const;

/**
 * Argument schemas.
 *
 * Gemini is given these as JSON Schema so it constrains generation, and every
 * call is validated against the Zod version below before anything executes.
 * Provider-side constraint is a convenience; a tool argument is attacker-
 * reachable input — merchant text in the model's context can influence it — and
 * so it is treated as untrusted no matter how it was produced.
 */
const searchCatalogArgsSchema = z.object({
  category: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/)
    .optional(),
  maxAmountMinor: z
    .string()
    .regex(/^\d{1,15}$/, "maxAmountMinor must be whole minor units")
    .optional(),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  attributes: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
      z.union([z.string().max(100), z.number(), z.boolean()]),
    )
    .optional(),
  limit: z.number().int().min(1).max(MAX_TOOL_RESULT_PRODUCTS).optional(),
});

const getProductArgsSchema = z.object({ productId: z.string().min(1).max(64) });

const getMerchantArgsSchema = z.object({});

export const CATALOG_TOOL_DECLARATIONS: readonly AiToolDeclaration[] = [
  {
    name: "search_catalog",
    description:
      "Search the merchant's catalog. Returns only published products with authoritative price, currency and stock. " +
      "Use maxAmountMinor to filter by the shopper's budget in whole minor units (paise): ₹3000 is 300000.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          // Enumerated rather than described, because this value is compared by
          // equality: "mice" and "gaming-mouse" are not near-misses, they are
          // zero results. Constraining generation is a convenience - the Zod
          // schema below still validates whatever actually arrives.
          enum: [...MERCHANT_CATEGORIES],
          description:
            "Catalog category slug. Must be one of the merchant's own categories.",
        },
        maxAmountMinor: {
          type: "string",
          description: "Inclusive maximum unit price in whole minor units (paise).",
        },
        currency: { type: "string", enum: [...SUPPORTED_CURRENCIES] },
        attributes: {
          type: "object",
          description:
            'Exact structured attribute matches, e.g. {"switchType":"linear-red"}.',
        },
        limit: { type: "integer", description: "Maximum products to return." },
      },
    },
  },
  {
    name: "get_product_by_id",
    description:
      "Fetch one published product by the id returned from a previous search. Never invent an id.",
    parameters: {
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
    },
  },
  {
    name: "get_merchant_info",
    description:
      "Public merchant metadata, including the currencies this catalog quotes.",
    parameters: { type: "object", properties: {} },
  },
];

/**
 * What a tool hands back to the model.
 *
 * `products` is kept alongside the serialised payload so the agent can record
 * provenance: every product the model was shown is added to the observed set,
 * and only those ids may later be selected.
 */
export interface CatalogToolExecution {
  readonly payload: JsonValue;
  readonly products: readonly CatalogProductDto[];
}

/**
 * Trims a product for the model's context.
 *
 * Truncating the description is a cost control, not a defence — a shortened
 * injection attempt is still an injection attempt, and the defences that matter
 * are the absent tools and the deterministic validation. What this does buy is
 * a bounded prompt: a merchant could otherwise put fifty kilobytes in a
 * description and turn every agent run into an expensive one.
 */
function toModelProduct(product: CatalogProductDto): JsonObject {
  return {
    productId: product.id,
    name: product.name.slice(0, MAX_TOOL_DESCRIPTION_LENGTH),
    description: product.description.slice(0, MAX_TOOL_DESCRIPTION_LENGTH),
    category: product.category,
    amountMinor: product.amount.amountMinor,
    currency: product.amount.currency,
    availability: product.availability.status,
    purchasable: product.availability.purchasable,
    availableQuantity: product.availability.quantity,
    attributes: product.attributes,
  };
}

async function executeSearch(
  args: JsonObject,
  reader: CatalogReader,
): Promise<CatalogToolExecution> {
  const parsed = searchCatalogArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new InvalidToolArgumentsError(
      "search_catalog",
      parsed.error.issues[0]?.message ?? "arguments did not match the schema",
    );
  }
  const { category, maxAmountMinor, currency, attributes, limit } = parsed.data;

  // A budget without a currency is refused rather than defaulted, matching the
  // Objective 4 contract: an amount with no currency is not a budget.
  if (maxAmountMinor !== undefined && currency === undefined) {
    throw new InvalidToolArgumentsError(
      "search_catalog",
      "maxAmountMinor requires an explicit currency",
    );
  }

  const result = await reader.searchProducts({
    ...(category === undefined ? {} : { category }),
    ...(maxAmountMinor === undefined ? {} : { maxAmountMinor: BigInt(maxAmountMinor) }),
    ...(currency === undefined ? {} : { currency }),
    attributes: Object.entries(attributes ?? {}).map(([key, value]) => ({
      key,
      value,
    })),
    sort: "amount_asc",
    limit: limit ?? MAX_TOOL_RESULT_PRODUCTS,
    offset: 0,
  });

  return {
    payload: {
      products: result.products.map(toModelProduct),
      totalMatching: result.total,
    },
    products: result.products,
  };
}

async function executeGetProduct(
  args: JsonObject,
  reader: CatalogReader,
): Promise<CatalogToolExecution> {
  const parsed = getProductArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new InvalidToolArgumentsError("get_product_by_id", "productId is required");
  }
  let productId: string;
  try {
    productId = parseProductId(parsed.data.productId);
  } catch {
    throw new InvalidToolArgumentsError(
      "get_product_by_id",
      "productId is not a well-formed identifier",
    );
  }

  const product = await reader.getProduct(productId);
  return { payload: { product: toModelProduct(product) }, products: [product] };
}

async function executeGetMerchant(
  args: JsonObject,
  reader: CatalogReader,
): Promise<CatalogToolExecution> {
  if (!getMerchantArgsSchema.safeParse(args).success) {
    throw new InvalidToolArgumentsError("get_merchant_info", "no arguments are accepted");
  }
  const merchant = await reader.getMerchant();
  return {
    payload: {
      merchantId: merchant.id,
      name: merchant.name,
      supportedCurrencies: [...merchant.supportedCurrencies],
    },
    products: [],
  };
}

type ToolExecutor = (
  args: JsonObject,
  reader: CatalogReader,
) => Promise<CatalogToolExecution>;

/**
 * The allowlist. Dispatch is a Map lookup and nothing else.
 *
 * There is no dynamic resolution here: no string concatenation into a function
 * name, no `globalThis[name]`, no reflection over a module. A name that is not
 * a key of this map cannot execute, whatever produced it.
 */
const TOOL_REGISTRY: ReadonlyMap<string, ToolExecutor> = new Map<string, ToolExecutor>([
  ["search_catalog", executeSearch],
  ["get_product_by_id", executeGetProduct],
  ["get_merchant_info", executeGetMerchant],
]);

export function isRegisteredTool(name: string): boolean {
  return TOOL_REGISTRY.has(name);
}

/**
 * Executes one model-requested tool call.
 *
 * Throws `UnknownToolError` for anything not in the registry — including every
 * payment, policy and transaction name a prompt injection might suggest.
 */
export async function executeCatalogTool(
  name: string,
  args: JsonObject,
  reader: CatalogReader,
): Promise<CatalogToolExecution> {
  const executor = TOOL_REGISTRY.get(name);
  if (executor === undefined) {
    throw new UnknownToolError(name);
  }
  return executor(args, reader);
}
