import { assertServerOnly } from "@/lib/server-only";
import { POLICY_AUDIT_EVENT_TYPE, type PolicySnapshot } from "@/domain/policy/decision";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";

/**
 * The single way a policy is read out of PostgreSQL.
 *
 * Shared by the evaluation path and the pre-payment recheck deliberately: those
 * two must agree about what "this buyer's policy" means, and two independently
 * written queries would eventually disagree - which is precisely the bug that
 * lets a payment proceed under a rule the evaluation never saw.
 */
assertServerOnly("src/services/policy/policy-reader.ts");

/**
 * The buyer's policy, or null.
 *
 * An active policy wins. Failing that, the most recent policy of any status is
 * returned *unfiltered*, so the engine can say POLICY_NOT_ACTIVE rather than
 * NO_POLICY_FOUND - a retired rule and no rule at all are different facts, and
 * the audit record should not confuse them. Both are refusals either way: this
 * function has no path that hides a policy from the engine, and none that
 * invents one when there is nothing to read.
 */
export async function loadPolicySnapshot(
  tx: TransactionCapableClient,
  buyerProfileId: string,
): Promise<PolicySnapshot | null> {
  const active = await tx.authorizationPolicy.findFirst({
    where: { buyerProfileId, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });
  const row =
    active ??
    (await tx.authorizationPolicy.findFirst({
      where: { buyerProfileId },
      orderBy: { version: "desc" },
    }));
  if (row === null) return null;

  return {
    policyId: row.id,
    buyerProfileId: row.buyerProfileId,
    version: row.version,
    status: row.status,
    autoPurchaseAllowed: row.autoPurchaseAllowed,
    maxAutoApproveAmountMinor: row.maxAutoApproveAmount,
    currency: row.currency,
  };
}

/**
 * The policy evaluation recorded for a transaction, read back from its audit event.
 *
 * The audit trail is the system's own memory of why a transaction is where it
 * is, and two later controls depend on reading it: the pre-payment recheck asks
 * "was this authorized under today's rules", and the approval gate asks "which
 * rule said a person was needed". Both must read it the same way, so the
 * parsing lives here once.
 */
export interface RecordedPolicyEvaluation {
  readonly policyVersion: number;
  readonly quoteId: string;
  readonly decision: string;
  readonly reasonCode: string;
  readonly autoApproveLimitMinor: bigint;
}

/**
 * Deliberately three outcomes, not two.
 *
 * `metadata` is a Json column, so its shape is a convention rather than a type.
 * A record that exists but cannot be read is a different fact from no record at
 * all, and both are refusals - but an operator looking at a refused payment
 * needs to know which one they are looking at.
 */
export type RecordedEvaluationLookup =
  | { readonly kind: "FOUND"; readonly evaluation: RecordedPolicyEvaluation }
  | { readonly kind: "MISSING" }
  | {
      readonly kind: "INCOMPLETE";
      readonly hasPolicyVersion: boolean;
      readonly hasQuoteId: boolean;
    };

export async function readRecordedEvaluation(
  client: TransactionCapableClient,
  transactionId: string,
): Promise<RecordedEvaluationLookup> {
  const row = await client.auditEvent.findFirst({
    where: { transactionId, eventType: POLICY_AUDIT_EVENT_TYPE },
    orderBy: { createdAt: "desc" },
    select: { metadata: true, reasonCode: true },
  });
  if (row === null) return { kind: "MISSING" };

  const policyVersion = readNumber(row.metadata, "policyVersion");
  const quoteId = readString(row.metadata, "quoteId");
  if (policyVersion === null || quoteId === null) {
    return {
      kind: "INCOMPLETE",
      hasPolicyVersion: policyVersion !== null,
      hasQuoteId: quoteId !== null,
    };
  }

  const limit = readString(row.metadata, "autoApproveLimitMinor");
  return {
    kind: "FOUND",
    evaluation: {
      policyVersion,
      quoteId,
      decision: readString(row.metadata, "decision") ?? "",
      reasonCode: row.reasonCode ?? readString(row.metadata, "reasonCode") ?? "",
      // A decision reached with no usable ceiling is BLOCKED and never reaches a
      // state that consults this, so zero is a floor rather than a guess.
      autoApproveLimitMinor: limit === null ? 0n : BigInt(limit),
    },
  };
}

/**
 * Reads one field out of stored JSON metadata.
 *
 * A missing or malformed field yields null, and every caller turns null into a
 * refusal rather than a skipped check - "cannot confirm" must never be the same
 * thing as "confirmed".
 */
function readNumber(metadata: unknown, key: string): number | null {
  const value = readField(metadata, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(metadata: unknown, key: string): string | null {
  const value = readField(metadata, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readField(metadata: unknown, key: string): unknown {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  return (metadata as Record<string, unknown>)[key];
}
