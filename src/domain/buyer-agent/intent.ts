import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "@/domain/money";

/**
 * The structured purchase intent.
 *
 * This is the model's *interpretation* of what a human asked for — and it is
 * exactly one of the two levels of trust in this system. Everything here is a
 * claim about the user's wishes, and none of it is a claim about the world. The
 * model may say "they wanted a mechanical keyboard under ₹3,000"; it may never
 * say what a keyboard costs. Authoritative product facts come from PostgreSQL
 * through the Objective 4 catalog and nowhere else.
 *
 * The schema is enforced twice, on purpose. Gemini is given it as a native
 * structured-output schema so the provider constrains generation, and the
 * response is then validated again here at runtime. Provider-side enforcement
 * is a convenience, never a guarantee: it can change, degrade, or be bypassed
 * by a malformed response, and a financial system may not depend on a remote
 * service's promise about its own output.
 */

/**
 * What the human is trying to do.
 *
 * Classified explicitly rather than inferred downstream, so an informational
 * request cannot drift into purchase-shaped behaviour. Objective 5 performs no
 * payment action for any of these values — the distinction exists so later
 * objectives inherit an honest signal.
 */
export const PURCHASE_INTENTS = ["BROWSE", "RECOMMEND", "PURCHASE"] as const;

export type PurchaseIntentType = (typeof PURCHASE_INTENTS)[number];

/** Comparison operators a hard requirement may use. A closed set. */
export const REQUIREMENT_OPERATORS = ["EQUALS", "NOT_EQUALS"] as const;

export type RequirementOperator = (typeof REQUIREMENT_OPERATORS)[number];

export const MAX_QUANTITY = 10;
export const MAX_HARD_REQUIREMENTS = 8;
export const MAX_SOFT_PREFERENCES = 8;

/**
 * The upper bound on any budget the agent will accept, in minor units.
 * ₹10,00,000. A demo-scale sanity bound: a "budget" beyond this is far more
 * likely to be a hallucination or a unit confusion than a real intent.
 */
export const MAX_BUDGET_MINOR = 100_000_000n;

const attributeNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "attribute names are identifiers");

const attributeValueSchema = z.union([z.string().max(100), z.number(), z.boolean()]);

export const constraintSchema = z.object({
  attribute: attributeNameSchema,
  operator: z.enum(REQUIREMENT_OPERATORS),
  value: attributeValueSchema,
});

export type Constraint = z.infer<typeof constraintSchema>;

/**
 * A budget the human stated, with enough provenance to check it.
 *
 * `sourceText` is the load-bearing field. Without it the server would have to
 * take the model's word for a number that caps spending, and a hallucinated
 * "300000" would be indistinguishable from a real one. With it, the server can
 * confirm the span actually occurs in the human's message and parse the amount
 * deterministically — so the model's role is reduced to *locating* the budget,
 * never to *inventing* it.
 *
 * Amounts cross this boundary as decimal strings of minor units, matching the
 * project's money contract. No float ever represents an amount.
 */
/**
 * What a stated limit applies to.
 *
 * "Buy 2 keyboards under ₹3000 **each**" and "buy 2 keyboards with a total
 * budget of ₹3000" are different amounts of money — ₹6000 against ₹3000 — and
 * nothing downstream can tell them apart from the number alone. The scope is
 * therefore carried explicitly rather than assumed.
 *
 * At quantity 1 the two are identical, so the distinction only has to be
 * resolved when more than one unit is being bought. When it cannot be resolved
 * there, the agent asks: guessing would either double the shopper's spend or
 * reject products they could afford.
 */
export const BUDGET_SCOPES = ["PER_UNIT", "TOTAL"] as const;

export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const budgetSchema = z.object({
  maxAmountMinor: z
    .string()
    .regex(/^\d{1,15}$/, "maxAmountMinor must be whole minor units"),
  currency: z.enum(SUPPORTED_CURRENCIES),
  /** True only when the human actually stated a limit. */
  explicit: z.boolean(),
  /**
   * Whether the limit is per unit or for the whole order.
   *
   * Nullable because a shopper buying one item usually says neither, and
   * forcing the model to pick would invent a distinction the human never drew.
   * The server requires it only when quantity makes it financially material.
   */
  scope: z
    .enum(BUDGET_SCOPES)
    .nullish()
    .transform((value) => value ?? null),
  /** The exact span of the human's message the limit was read from. */
  sourceText: z.string().min(1).max(200),
});

export type BudgetClaim = z.infer<typeof budgetSchema>;

/**
 * Optional fields are accepted as absent, not only as explicit null.
 *
 * A model given a schema that does not list a field as required will often
 * simply omit it rather than emit `null` - which is correct JSON Schema
 * behaviour, and which an earlier version of this validator rejected outright.
 * The live smoke test caught exactly that, which is the reason it exists: the
 * in-memory fakes always produced complete payloads, so no deterministic test
 * could have found it.
 *
 * Normalising an absent field to `null` here keeps every downstream check a
 * plain `=== null` comparison, so no consumer has to handle two flavours of
 * absent.
 */
const nullishString = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value ?? null);

export const structuredPurchaseIntentSchema = z.object({
  requestType: z.enum(PURCHASE_INTENTS),
  /** Free-text product description, used only to search the catalog. */
  productQuery: z.string().min(1).max(200),
  /** Catalog category if the human implied one. Never invented to force a match. */
  category: nullishString(64),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  budget: budgetSchema.nullish().transform((value) => value ?? null),
  hardRequirements: z.array(constraintSchema).max(MAX_HARD_REQUIREMENTS).default([]),
  softPreferences: z.array(constraintSchema).max(MAX_SOFT_PREFERENCES).default([]),
  needsClarification: z.boolean(),
  clarificationQuestion: nullishString(300),
});

export type StructuredPurchaseIntent = z.infer<typeof structuredPurchaseIntentSchema>;

/**
 * The same schema in the JSON Schema dialect Gemini's structured output takes.
 *
 * Hand-written rather than generated, because only a subset of JSON Schema is
 * supported by the provider and a generator would happily emit constructs it
 * silently ignores. Keeping it explicit means the constraint we *think* we are
 * sending is the one we are sending. `structuredPurchaseIntentSchema` above
 * remains the authority — this is a hint to the provider, not the check.
 */
export const INTENT_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    requestType: { type: "string", enum: [...PURCHASE_INTENTS] },
    productQuery: { type: "string" },
    category: { type: "string", nullable: true },
    quantity: { type: "integer" },
    budget: {
      type: "object",
      nullable: true,
      properties: {
        maxAmountMinor: {
          type: "string",
          description: "Whole minor units (paise). '₹3000' is '300000'. Never a decimal.",
        },
        currency: { type: "string", enum: [...SUPPORTED_CURRENCIES] },
        explicit: { type: "boolean" },
        scope: {
          type: "string",
          nullable: true,
          enum: [...BUDGET_SCOPES],
          description:
            "PER_UNIT if the limit is per item ('under ₹3000 each'), TOTAL if it covers the whole order ('₹3000 total'). Leave null only if the shopper did not distinguish.",
        },
        sourceText: {
          type: "string",
          description:
            "The exact substring of the user's message the limit was read from, copied verbatim.",
        },
      },
      required: ["maxAmountMinor", "currency", "explicit", "sourceText"],
    },
    hardRequirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          attribute: { type: "string" },
          operator: { type: "string", enum: [...REQUIREMENT_OPERATORS] },
          value: { type: "string" },
        },
        required: ["attribute", "operator", "value"],
      },
    },
    softPreferences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          attribute: { type: "string" },
          operator: { type: "string", enum: [...REQUIREMENT_OPERATORS] },
          value: { type: "string" },
        },
        required: ["attribute", "operator", "value"],
      },
    },
    needsClarification: { type: "boolean" },
    clarificationQuestion: { type: "string", nullable: true },
  },
  required: [
    "requestType",
    "productQuery",
    "quantity",
    "hardRequirements",
    "softPreferences",
    "needsClarification",
  ],
} as const;
