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
  selectedProductId: z.string().max(64).nullable(),
  quantity: z.number().int().min(1).max(100).nullable(),
  reasonCodes: z.array(z.enum(DECISION_REASON_CODES)).max(8),
  noMatchReasonCodes: z.array(z.enum(NO_MATCH_REASON_CODES)).max(6),
  clarificationQuestion: z.string().max(300).nullable(),
  summary: z.string().min(1).max(300),
});

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** The provider-facing schema for the selection step. See intent.ts for why. */
export const SELECTION_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["SELECT", "NO_MATCH", "CLARIFY"] },
    selectedProductId: {
      type: "string",
      nullable: true,
      description:
        "The id of a product returned by a catalog tool in THIS conversation. Never invent one.",
    },
    quantity: { type: "integer", nullable: true },
    reasonCodes: {
      type: "array",
      items: { type: "string", enum: [...DECISION_REASON_CODES] },
    },
    noMatchReasonCodes: {
      type: "array",
      items: { type: "string", enum: [...NO_MATCH_REASON_CODES] },
    },
    clarificationQuestion: { type: "string", nullable: true },
    summary: {
      type: "string",
      description:
        "One short sentence for the shopper. Never internal reasoning, never a price you calculated.",
    },
  },
  required: ["outcome", "reasonCodes", "noMatchReasonCodes", "summary"],
} as const;
