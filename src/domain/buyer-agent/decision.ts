import { z } from "zod";
import type { MoneyDto } from "@/domain/money";
import type {
  BudgetScope,
  Constraint,
  PurchaseIntentType,
} from "@/domain/buyer-agent/intent";

/**
 * What the Buyer Agent hands back.
 *
 * A discriminated union rather than one wide object with optional fields
 * everywhere. Each outcome carries only what is meaningful for that outcome, so
 * there is no such thing as a half-filled decision with a `selectedProductId`
 * beside a `clarificationQuestion` — a shape a caller would have to defend
 * against, and a shape a bug could produce.
 *
 * The agent *proposes*. Nothing here authorizes, pays, reserves, or moves a
 * transaction. Objective 6 takes this proposal, re-reads the product from
 * PostgreSQL, and decides whether a trusted quote can be created from it.
 */

/**
 * Concise, structured reasons for a decision.
 *
 * A closed vocabulary, not free text, and emphatically not model reasoning.
 * A model asked to explain itself produces unbounded prose that is unverifiable,
 * prompt-injectable, and unsafe to show in a financial record. These codes are
 * checkable: every one of them corresponds to something the server verified
 * against the catalog.
 */
export const DECISION_REASON_CODES = [
  "WITHIN_BUDGET",
  "MATCHES_REQUESTED_CATEGORY",
  "MATCHES_REQUIRED_ATTRIBUTE",
  "MATCHES_SOFT_PREFERENCE",
  "IN_STOCK",
  "SUFFICIENT_INVENTORY",
  "CHEAPEST_COMPLIANT_OPTION",
  "ONLY_COMPLIANT_OPTION",
] as const;

export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

/** Why nothing could be selected. Equally closed, for the same reasons. */
export const NO_MATCH_REASON_CODES = [
  "NO_PRODUCT_WITHIN_BUDGET",
  "NO_PRODUCT_IN_CATEGORY",
  "NO_PRODUCT_WITH_REQUIRED_ATTRIBUTE",
  "NO_PRODUCT_IN_STOCK",
  "INSUFFICIENT_INVENTORY",
  "EMPTY_CATALOG_RESULT",
] as const;

export type NoMatchReasonCode = (typeof NO_MATCH_REASON_CODES)[number];

/** Which part of the request was too ambiguous to act on safely. */
export const CLARIFICATION_FIELDS = [
  "budget",
  "quantity",
  "product",
  "currency",
  "requirements",
] as const;

export type ClarificationField = (typeof CLARIFICATION_FIELDS)[number];

/**
 * The user's authority, as the server resolved it.
 *
 * Attached to every outcome so a caller — and Objective 6 — can see exactly
 * which constraints were treated as binding, without re-deriving them from the
 * original message.
 */
export interface NormalizedUserConstraints {
  readonly requestType: PurchaseIntentType;
  readonly quantity: number;
  /** Present only when the human explicitly stated a limit. Immutable once set. */
  readonly maxBudget: MoneyDto | null;
  /** Whether that limit applies per unit or to the whole order. */
  readonly budgetScope: BudgetScope | null;
  /**
   * The catalog category the shopper asked for, in the catalog's own spelling.
   *
   * Carried here because it is a *hard* constraint and the deterministic
   * eligibility check is downstream of this type. It used to stop at the agent:
   * the intent held a category, these constraints did not, and
   * `toAuthority` in the product-decision service had no choice but to pass
   * `category: null` — so `WRONG_CATEGORY` could never fire on the real
   * purchase path. With one category in the catalog that was invisible. With
   * keyboards, mice and headphones it is the difference between "find me a
   * mouse" returning a mouse and it returning whatever ranked best.
   *
   * Null when the shopper named no category, which leaves the search open
   * rather than narrowing it to a guess.
   */
  readonly category: string | null;
  readonly hardRequirements: readonly Constraint[];
  readonly softPreferences: readonly Constraint[];
}

/**
 * Catalog facts as observed during this execution.
 *
 * Included so a caller can render a result without a second round trip, and
 * labelled `observed` rather than `authoritative` on purpose: it is a snapshot
 * from a read that has already happened. Objective 6 re-reads before it trusts
 * any of it. Nothing here came from the model.
 */
export interface ObservedProduct {
  readonly productId: string;
  readonly name: string;
  readonly amount: MoneyDto;
  readonly availableQuantity: number;
  readonly version: number;
  readonly updatedAt: string;
}

export type BuyerAgentDecision =
  | {
      readonly kind: "PRODUCT_SELECTED";
      readonly correlationId: string;
      readonly selectedProductId: string;
      readonly quantity: number;
      readonly reasonCodes: readonly DecisionReasonCode[];
      /** One short sentence for a human. Never model reasoning. */
      readonly summary: string;
      readonly constraints: NormalizedUserConstraints;
      readonly observedProduct: ObservedProduct;
    }
  | {
      readonly kind: "NEEDS_CLARIFICATION";
      readonly correlationId: string;
      readonly clarificationQuestion: string;
      readonly ambiguousFields: readonly ClarificationField[];
      readonly constraints: NormalizedUserConstraints;
    }
  | {
      readonly kind: "NO_MATCH";
      readonly correlationId: string;
      readonly reasonCodes: readonly NoMatchReasonCode[];
      readonly summary: string;
      readonly constraints: NormalizedUserConstraints;
    };

export type BuyerAgentDecisionKind = BuyerAgentDecision["kind"];

/** Bounds stated once, so the validator and the provider cannot disagree. */
export const MAX_SELECTED_PRODUCT_ID_LENGTH = 64;
export const MAX_SELECTION_QUANTITY = 100;
export const MAX_DECISION_REASON_CODES = 8;
export const MAX_NO_MATCH_REASON_CODES = 6;
export const MAX_SUMMARY_LENGTH = 300;

/**
 * The clarification question's own limit, even though it currently equals the
 * summary's.
 *
 * They are different fields answering to different rules - one is a sentence
 * shown beside a product, the other is a question put to a shopper - and a
 * shared constant would mean that shortening the summary silently shortened the
 * question too. The intent schema states the same bound for its own
 * clarification question; both are 300 today, and neither is 300 *because* the
 * other is.
 */
export const MAX_SELECTION_CLARIFICATION_LENGTH = 300;

/**
 * A field that is absent means the same as a field that is null.
 *
 * The provider schema below marks `selectedProductId`, `quantity` and
 * `clarificationQuestion` optional, because none of them is meaningful for
 * every outcome - a `NO_MATCH` has no product and a `SELECT` has no question.
 * A model given that schema does the correct thing and omits them. This
 * validator used to demand them anyway (`.nullable()` accepts `null`, but still
 * requires the key), so a perfectly compliant answer was rejected as
 * `AI_PROVIDER_INVALID_RESPONSE`.
 *
 * Normalising absence to `null` here is not a relaxation: every value the
 * schema accepted before is still accepted, every bound still applies, and
 * downstream code keeps its single `=== null` comparison rather than learning
 * about two flavours of missing. The same normalisation already exists for the
 * intent schema, for the same reason and after the same live failure.
 */
const absentAsNull = <T extends z.ZodTypeAny>(inner: T) =>
  inner
    .nullish()
    .transform((value): z.output<T> | null => (value ?? null) as z.output<T> | null);

/**
 * What the model is allowed to propose after it has seen catalog results.
 *
 * Deliberately tiny. The model returns an id, a quantity, reason codes and a
 * sentence — and nothing else. In particular there is **no price field**: not
 * because the model would not happily provide one, but because a field that
 * exists is a field something downstream might read. The cheapest way to make
 * a model-invented price non-authoritative is to give it nowhere to live.
 */
export const modelSelectionSchema = z.object({
  outcome: z.enum(["SELECT", "NO_MATCH", "CLARIFY"]),
  selectedProductId: absentAsNull(z.string().max(MAX_SELECTED_PRODUCT_ID_LENGTH)),
  quantity: absentAsNull(z.number().int().min(1).max(MAX_SELECTION_QUANTITY)),
  reasonCodes: z.array(z.enum(DECISION_REASON_CODES)).max(MAX_DECISION_REASON_CODES),
  noMatchReasonCodes: z
    .array(z.enum(NO_MATCH_REASON_CODES))
    .max(MAX_NO_MATCH_REASON_CODES),
  clarificationQuestion: absentAsNull(z.string().max(MAX_SELECTION_CLARIFICATION_LENGTH)),
  summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
});

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * The provider-facing schema for the selection step. See intent.ts for why.
 *
 * Every bound the validator enforces is declared here as well. A model that is
 * never told a limit has no way to respect it, and the resulting refusal is our
 * own contract's fault rather than the model's - which is precisely how an
 * over-long clarification question once became a live failure. The parity test
 * in `tests/model-schema-parity.test.ts` is what keeps the two in step.
 */
export const SELECTION_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["SELECT", "NO_MATCH", "CLARIFY"] },
    selectedProductId: {
      type: "string",
      nullable: true,
      maxLength: MAX_SELECTED_PRODUCT_ID_LENGTH,
      description:
        "The id of a product returned by a catalog tool in THIS conversation. Never invent one.",
    },
    quantity: {
      type: "integer",
      nullable: true,
      minimum: 1,
      maximum: MAX_SELECTION_QUANTITY,
    },
    reasonCodes: {
      type: "array",
      maxItems: MAX_DECISION_REASON_CODES,
      items: { type: "string", enum: [...DECISION_REASON_CODES] },
    },
    noMatchReasonCodes: {
      type: "array",
      maxItems: MAX_NO_MATCH_REASON_CODES,
      items: { type: "string", enum: [...NO_MATCH_REASON_CODES] },
    },
    clarificationQuestion: {
      type: "string",
      nullable: true,
      maxLength: MAX_SELECTION_CLARIFICATION_LENGTH,
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SUMMARY_LENGTH,
      description:
        "One short sentence for the shopper. Never internal reasoning, never a price you calculated.",
    },
  },
  required: ["outcome", "reasonCodes", "noMatchReasonCodes", "summary"],
} as const;
