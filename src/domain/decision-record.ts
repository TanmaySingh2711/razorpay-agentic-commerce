import { z } from "zod";
import { TRANSACTION_ACTORS } from "@/domain/transaction/states";

/**
 * Structured decision records - the system's explainability contract.
 *
 * Explainability here is NOT "show the model's reasoning". Hidden
 * chain-of-thought is never captured, stored, or displayed: it is unverified,
 * unbounded text that would leak prompt internals and invite prompt-injected
 * narration into a financial record.
 *
 * Instead every consequential decision emits a small, fixed, machine-checkable
 * record: what was decided, on which inputs, under which rule, with what
 * result, and a short human-readable reason. That is enough to answer "why was
 * this product chosen", "why was this payment allowed", "why did this need my
 * approval" and "why was this blocked" without trusting the model's narration.
 */
export const DECISION_TYPES = [
  "intent_interpretation",
  "product_selection",
  "product_verification",
  "policy_evaluation",
  "approval_decision",
  "payment_authorization",
  "payment_execution",
  "state_transition",
  "failure_handling",
] as const;

export type DecisionType = (typeof DECISION_TYPES)[number];

export const DECISION_RESULTS = [
  "selected",
  "verified",
  "allowed",
  "requires_approval",
  "blocked",
  "failed",
] as const;

export type DecisionResult = (typeof DECISION_RESULTS)[number];

/**
 * Hard cap on the reason field. A bounded reason is a design constraint, not a
 * formatting preference: it structurally prevents a model from dumping
 * reasoning into an audit-visible field.
 */
export const DECISION_REASON_MAX_LENGTH = 400;

const decisionInputValueSchema = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const decisionRecordSchema = z.object({
  decisionId: z.string().min(1),
  transactionId: z.string().min(1),
  decisionType: z.enum(DECISION_TYPES),
  /** Which component decided. AI components can only own AI-domain decision types. */
  actor: z.enum(TRANSACTION_ACTORS),
  /** The specific inputs the decision turned on - flat and bounded, never a raw payload. */
  inputs: z.record(z.string(), decisionInputValueSchema),
  /** Identifier of the deterministic rule applied, or null for AI-domain decisions. */
  ruleApplied: z.string().min(1).nullable(),
  result: z.enum(DECISION_RESULTS),
  reason: z.string().min(1).max(DECISION_REASON_MAX_LENGTH),
  occurredAt: z.iso.datetime(),
});

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

/** Decision types an AI component is permitted to own. */
export const AI_OWNED_DECISION_TYPES: readonly DecisionType[] = [
  "intent_interpretation",
  "product_selection",
];
