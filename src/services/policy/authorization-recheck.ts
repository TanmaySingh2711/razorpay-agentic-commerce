import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { assessQuote, type QuoteSnapshot } from "@/domain/quote/rules";
import { evaluatePolicy } from "@/domain/policy/engine";
import { toPolicyDecisionDto, type PolicyDecisionDto } from "@/domain/policy/decision";
import {
  loadPolicySnapshot,
  readRecordedEvaluation,
} from "@/services/policy/policy-reader";
import type { CurrencyCode } from "@/domain/money";
import type { JsonObject } from "@/lib/json";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The pre-payment authorization recheck.
 *
 * This is the handoff Objective 10 will call, and the reason it exists is a
 * gap in time. Policy is evaluated when a quote is created; a payment order is
 * created later. In between, a price can move, a quote can lapse, and - most
 * importantly - a person can change their spending policy. An authorization
 * that was correct at 10:00 is not evidence about 10:40, and a payment service
 * that treated `status = AUTHORIZED` as sufficient would be charging on the
 * strength of a stale decision.
 *
 * So this function re-derives the decision from scratch, against the rows as
 * they are *now*, and compares it with what was recorded. It is deliberately
 * **read-only**: it opens no transaction, writes no audit event, moves no
 * state, and marks no quote expired. A gate that mutates something every time
 * it is consulted cannot be consulted freely, and this one must be callable
 * immediately before money moves without changing anything it is measuring.
 *
 * Everything it can return other than AUTHORIZED is a refusal, and the caller's
 * only correct response to a refusal is to not prepare a payment.
 */
assertServerOnly("src/services/policy/authorization-recheck.ts");

/**
 * Why a payment must not be prepared.
 *
 * Each is a distinct fact an operator would want to see; collapsing them into a
 * single "not authorized" would make the one case that matters - the policy
 * changed under a live transaction - indistinguishable from an ordinary lapsed
 * quote.
 */
export const POLICY_RECHECK_REFUSALS = [
  /** The transaction is not in AUTHORIZED. Nothing here can put it there. */
  "TRANSACTION_NOT_AUTHORIZED",
  /** AUTHORIZED, but no policy evaluation is on record. Fail closed. */
  "NO_RECORDED_EVALUATION",
  /** No live quote, so there is no amount to charge. */
  "NO_ACTIVE_QUOTE",
  /** The quote lapsed or the product moved since it was issued. */
  "QUOTE_NOT_USABLE",
  /** The live quote is not the one the recorded authorization was about. */
  "QUOTE_CHANGED_SINCE_AUTHORIZATION",
  /** The buyer's policy has been revised since the decision was made. */
  "POLICY_VERSION_CHANGED",
  /** Re-evaluated today, the policy refuses this purchase outright. */
  "POLICY_BLOCKS",
  /** Re-evaluated today, this purchase needs a person. */
  "APPROVAL_REQUIRED",
] as const;

export type PolicyRecheckRefusal = (typeof POLICY_RECHECK_REFUSALS)[number];

export type PolicyAuthorizationRecheck =
  | {
      readonly kind: "AUTHORIZED";
      readonly transactionId: string;
      readonly quoteId: string;
      /** Freshly derived, not read back from the earlier record. */
      readonly decision: PolicyDecisionDto;
      readonly policyVersion: number | null;
    }
  | {
      readonly kind: "NOT_AUTHORIZED";
      readonly transactionId: string;
      readonly quoteId: string | null;
      readonly refusal: PolicyRecheckRefusal;
      /** Present when a decision could be derived at all. */
      readonly decision: PolicyDecisionDto | null;
      /** Structured, safe context. Never SQL, never provider detail. */
      readonly detail: JsonObject;
    };

export interface AuthorizationRecheckDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
}

export function defaultRecheckDeps(): AuthorizationRecheckDeps {
  return { prisma: getPrismaClient(), clock: systemClock };
}

/**
 * Asks whether this transaction may still be paid.
 *
 * The checks run in the order a sceptic would ask them: is this transaction
 * even authorized, is there a record of why, is there still something to
 * charge, is it still the same something, and does today's policy still say
 * yes. Only a run that survives all five returns AUTHORIZED.
 *
 * Note the APPROVAL_REQUIRED refusal. A purchase a person approved reaches
 * AUTHORIZED through the approval gate, and re-running the engine against a
 * policy that always demanded approval will keep saying so - correctly. Making
 * that a refusal rather than a pass is the fail-closed choice, and it is the
 * seam Objective 8 fills: the approval gate will supply the missing authority,
 * as a stored decision this function can then consult. Until that exists, a
 * purchase above the ceiling cannot be paid, which is the right way round.
 */
export async function recheckPolicyAuthorization(
  transactionId: string,
  deps: AuthorizationRecheckDeps = defaultRecheckDeps(),
): Promise<PolicyAuthorizationRecheck> {
  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true, buyerProfileId: true },
  });

  if (transaction === null) {
    return refuse(transactionId, null, "TRANSACTION_NOT_AUTHORIZED", null, {
      reason: "no such transaction",
    });
  }
  if (transaction.status !== "AUTHORIZED") {
    // Includes APPROVAL_REQUIRED and BLOCKED. A payment service that reached
    // this point with either has skipped a control, and gets nothing here.
    return refuse(transactionId, null, "TRANSACTION_NOT_AUTHORIZED", null, {
      state: transaction.status,
    });
  }

  const recorded = await readRecordedEvaluation(deps.prisma, transactionId);
  if (recorded.kind !== "FOUND") {
    // Either AUTHORIZED with nothing explaining why, or a record this code
    // cannot read. Both mean the comparisons below cannot be made, and a
    // comparison that cannot be made must not be skipped: guarding them on "if
    // we happen to know" would make a corrupt record quietly *easier* to pay
    // against than an intact one - the exact inversion this gate exists to
    // prevent. So incompleteness is a refusal here, once, and every comparison
    // below is unconditional.
    return refuse(transactionId, null, "NO_RECORDED_EVALUATION", null, {
      reason:
        recorded.kind === "MISSING"
          ? "no policy evaluation is recorded for this transaction"
          : "the recorded policy evaluation is missing the fields needed to re-check it",
      hasPolicyVersion:
        recorded.kind === "INCOMPLETE" ? recorded.hasPolicyVersion : false,
      hasQuoteId: recorded.kind === "INCOMPLETE" ? recorded.hasQuoteId : false,
    });
  }
  const recordedPolicyVersion = recorded.evaluation.policyVersion;
  const recordedQuoteId = recorded.evaluation.quoteId;

  const quote = await deps.prisma.purchaseQuote.findFirst({
    where: { transactionId, status: "ACTIVE" },
    include: {
      product: {
        select: {
          unitAmount: true,
          currency: true,
          inventory: true,
          status: true,
          version: true,
        },
      },
    },
  });
  if (quote === null) {
    return refuse(transactionId, null, "NO_ACTIVE_QUOTE", null, {
      recordedQuoteId,
    });
  }

  const snapshot: QuoteSnapshot = {
    quoteId: quote.id,
    transactionId: quote.transactionId,
    productId: quote.productId,
    quantity: quote.quantity,
    unitAmountMinor: quote.unitAmount,
    totalAmountMinor: quote.totalAmount,
    currency: quote.currency as CurrencyCode,
    productVersion: quote.productVersion,
    status: quote.status,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
  };

  // Assessed, not marked. Expiring the quote here would be a side effect of
  // asking a question, and the payment service must be able to ask it twice.
  const usability = assessQuote(
    snapshot,
    {
      unitAmountMinor: quote.product.unitAmount,
      currency: quote.product.currency,
      availableQuantity: quote.product.inventory,
      purchasable: quote.product.status === "AVAILABLE" && quote.product.inventory > 0,
      version: quote.product.version,
    },
    deps.clock.now(),
  );
  if (usability.kind !== "VALID") {
    return refuse(transactionId, quote.id, "QUOTE_NOT_USABLE", null, {
      usability: usability.kind,
      ...(usability.kind === "INVALIDATED" ? { reasons: [...usability.reasons] } : {}),
    });
  }

  if (recordedQuoteId !== quote.id) {
    // The transaction was re-quoted after it was authorized. The live price is
    // one nothing has ever evaluated, and paying it would charge an amount no
    // policy decision was made about.
    return refuse(transactionId, quote.id, "QUOTE_CHANGED_SINCE_AUTHORIZATION", null, {
      recordedQuoteId,
      activeQuoteId: quote.id,
    });
  }

  const policy = await loadPolicySnapshot(deps.prisma, transaction.buyerProfileId);
  const decision = evaluatePolicy(
    {
      quoteId: snapshot.quoteId,
      transactionId: snapshot.transactionId,
      quantity: snapshot.quantity,
      unitAmountMinor: snapshot.unitAmountMinor,
      totalAmountMinor: snapshot.totalAmountMinor,
      currency: snapshot.currency,
    },
    policy,
  );
  const dto = toPolicyDecisionDto(decision);

  if (decision.policyVersion !== recordedPolicyVersion) {
    // Checked before the verdict itself, because this is the question the
    // recheck exists to answer. Even a policy that still says ALLOWED is a
    // different policy from the one on record, and the authorization was
    // granted under the old one.
    return refuse(transactionId, quote.id, "POLICY_VERSION_CHANGED", dto, {
      recordedPolicyVersion,
      currentPolicyVersion: decision.policyVersion,
    });
  }

  if (decision.decision === "BLOCKED") {
    return refuse(transactionId, quote.id, "POLICY_BLOCKS", dto, {
      reasonCode: decision.reasonCode,
    });
  }
  if (decision.decision === "APPROVAL_REQUIRED") {
    return refuse(transactionId, quote.id, "APPROVAL_REQUIRED", dto, {
      reasonCode: decision.reasonCode,
    });
  }

  return {
    kind: "AUTHORIZED",
    transactionId,
    quoteId: quote.id,
    decision: dto,
    policyVersion: decision.policyVersion,
  };
}

function refuse(
  transactionId: string,
  quoteId: string | null,
  refusal: PolicyRecheckRefusal,
  decision: PolicyDecisionDto | null,
  detail: JsonObject,
): PolicyAuthorizationRecheck {
  return { kind: "NOT_AUTHORIZED", transactionId, quoteId, refusal, decision, detail };
}
