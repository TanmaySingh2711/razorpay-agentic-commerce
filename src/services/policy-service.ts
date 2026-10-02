import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { assessQuote, type QuoteSnapshot } from "@/domain/quote/rules";
import { evaluatePolicy } from "@/domain/policy/engine";
import {
  POLICY_AUDIT_EVENT_TYPE,
  toPolicyDecisionDto,
  type EvaluableQuote,
  type PolicyDecision,
  type PolicyDecisionDto,
  type PolicySnapshot,
} from "@/domain/policy/decision";
import {
  InvalidPolicyOperationIdError,
  PolicyEvaluationFailureError,
  QuoteChangedDuringEvaluationError,
} from "@/domain/policy/errors";
import {
  applyTransactionEventWithin,
  type TransactionCapableClient,
} from "@/services/transaction/transition-service";
import { defaultQuoteDeps, validateQuoteForUse } from "@/services/quote/quote-service";
import { loadPolicySnapshot } from "@/services/policy/policy-reader";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { AppError } from "@/domain/errors";
import type { QuoteServiceDeps } from "@/services/quote/quote-service";
import type { QuoteUnusableCause, QuoteValidationResult } from "@/domain/quote/contracts";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { JsonObject } from "@/lib/json";
import type { CurrencyCode } from "@/domain/money";
import type { TransactionEvent } from "@/domain/transaction/events";
import type { TransactionState } from "@/domain/transaction/states";
import type { AuditEventResult, PrismaClient } from "@/generated/prisma/client";

/**
 * Where an AI-selected purchase meets a rule it cannot argue with.
 *
 * The pure decision lives in `@/domain/policy/engine`. This file is the part
 * that has to touch the world: it reads the quote and the policy out of
 * PostgreSQL, hands those two values to the engine, and commits the answer -
 * the audit record and the lifecycle transitions - in a single database
 * transaction.
 *
 * Two properties are worth stating plainly, because everything else here is in
 * service of them.
 *
 * **The caller supplies no financial input.** The command is a quote id and an
 * operation id. There is no field for an amount, a currency, a limit, a policy
 * version or a desired outcome, so a request that invents one has nowhere to
 * put it - not a check that could be forgotten, an absence that cannot be
 * exploited. Every number in the decision was read from a row moments earlier.
 *
 * **A decision and its record commit together.** The audit event and both state
 * transitions are written in one transaction. The database can therefore never
 * say AUTHORIZED without carrying the policy evaluation that authorized it, and
 * a failure anywhere leaves the transaction exactly where it was.
 *
 * No Gemini call happens in this file, and none ever should. Objective 7 does
 * not need a model, and a model that could influence this answer would be the
 * one thing the whole architecture exists to prevent.
 */
assertServerOnly("src/services/policy/policy-service.ts");

/** The one actor permitted to request any of these transitions. */
const POLICY_ACTOR = "policy_engine" as const;

/** Decision -> the domain event that carries it into the lifecycle. */
const OUTCOME_EVENT: Record<PolicyDecision["decision"], TransactionEvent> = {
  ALLOWED: "POLICY_ALLOWED",
  APPROVAL_REQUIRED: "POLICY_REQUIRES_APPROVAL",
  BLOCKED: "POLICY_BLOCKED",
};

/**
 * Decision -> audit result.
 *
 * APPROVAL_REQUIRED maps to PENDING rather than FAILURE: nothing failed, the
 * question was handed to a person and is still open.
 */
const AUDIT_RESULT: Record<PolicyDecision["decision"], AuditEventResult> = {
  ALLOWED: "SUCCESS",
  APPROVAL_REQUIRED: "PENDING",
  BLOCKED: "BLOCKED",
};

/** Bounded so an operation key can never be truncated into someone else's. */
const MAX_OPERATION_ID_LENGTH = 64;

export interface PolicyServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly quote: QuoteServiceDeps;
}

export function defaultPolicyDeps(): PolicyServiceDeps {
  return { prisma: getPrismaClient(), clock: systemClock, quote: defaultQuoteDeps() };
}

/**
 * Everything the caller is permitted to say.
 *
 * Deliberately two identifiers and nothing else. Read the list of things that
 * are absent - amount, currency, policy version, spending limit, decision - and
 * that absence is the API's security boundary, stated in the type system.
 */
export interface PolicyEvaluationCommand {
  readonly quoteId: string;
  /** Identity of the logical operation, so a retry cannot evaluate twice. */
  readonly operationId: string;
}

export type PolicyEvaluationResult =
  | {
      readonly kind: "EVALUATED";
      readonly transactionId: string;
      readonly quoteId: string;
      readonly decision: PolicyDecisionDto;
      readonly transactionState: TransactionState;
      /** True when this call converged on a record that already existed. */
      readonly replayed: boolean;
    }
  | {
      /**
       * The quote could not be relied on, so no policy decision was made.
       *
       * Distinct from BLOCKED on purpose. A lapsed or re-priced quote says
       * nothing about whether the shopper is permitted to spend; answering it
       * with a terminal denial would burn a transaction for a reason the
       * shopper could have fixed by asking again.
       */
      readonly kind: "QUOTE_NOT_USABLE";
      readonly quoteId: string;
      readonly transactionId: string | null;
      /** Which flavour of unusable, in one flat value the caller can branch on. */
      readonly cause: QuoteUnusableCause;
      /** What changed, when the cause is one that has structured reasons. */
      readonly reasons: readonly QuoteInvalidationReason[];
      /**
       * The full validation result, when the quote was refused up front.
       *
       * Null only for CHANGED_DURING_EVALUATION: the transaction that observed
       * the change rolled back, so there is no committed state to describe and
       * inventing one would be a fiction.
       */
      readonly validation: QuoteValidationResult | null;
    };

/**
 * Evaluates a trusted PurchaseQuote against the buyer's current policy.
 *
 * The order of operations is the design:
 *
 *  1. Validate the quote through Objective 6's boundary. An expired,
 *     invalidated or re-priced quote stops here - no evaluation, no transition,
 *     no audit event.
 *  2. Open one database transaction.
 *  3. Re-read the quote and its product inside it and re-assess them, because
 *     step 1 happened a moment ago and a moment is enough.
 *  4. Read the buyer's policy from the same transaction.
 *  5. Ask the pure engine.
 *  6. Write the audit record and move the lifecycle, together.
 *
 * Steps 3 and 4 are what make the record honest: the quote and the policy the
 * decision cites are the rows as they existed at the instant of the commit, not
 * as they looked when the request arrived.
 */
export async function evaluateQuotePolicy(
  command: PolicyEvaluationCommand,
  deps: PolicyServiceDeps = defaultPolicyDeps(),
): Promise<PolicyEvaluationResult> {
  assertUsableOperationId(command.operationId);

  // --- Precondition: only a currently valid quote may reach the engine. -------
  const validation = await validateQuoteForUse(command.quoteId, deps.quote);
  if (validation.kind !== "VALID") {
    return {
      kind: "QUOTE_NOT_USABLE",
      quoteId: command.quoteId,
      transactionId:
        validation.kind === "NOT_FOUND" ? null : validation.quote.transactionId,
      cause: validation.kind,
      reasons: validation.kind === "INVALIDATED" ? validation.reasons : [],
      validation,
    };
  }

  // One reading of the clock for the whole evaluation. Two calls would let the
  // instant the quote was assessed and the instant the record claims differ by
  // however long the transaction took, which is a small lie in a record whose
  // entire job is to be exact.
  const now = deps.clock.now();

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const loaded = await loadEvaluationInputs(tx, command.quoteId, now);
      const decision = evaluatePolicy(loaded.quote, loaded.policy);

      // The identity of this evaluation. It carries the policy version, so a
      // decision made under a newer policy is a genuinely new operation rather
      // than a duplicate of the old one.
      const operationKey = buildOperationKey(command, decision.policyVersion);

      // Through the audit boundary, in this transaction. The decision and its
      // record commit together or not at all.
      const recorded = await recordAuditEvent(tx, {
        transactionId: loaded.quote.transactionId,
        action: POLICY_AUDIT_EVENT_TYPE,
        actor: POLICY_ACTOR,
        result: AUDIT_RESULT[decision.decision],
        reasonCode: decision.reasonCode,
        trustedInputs: buildAuditMetadata(command, loaded, decision),
        correlationId: loaded.correlationId,
        operationKey,
      });
      const replayed = recorded.kind === "ALREADY_RECORDED";

      const transactionState = await moveLifecycle(tx, command, loaded, decision);

      return {
        kind: "EVALUATED" as const,
        transactionId: loaded.quote.transactionId,
        quoteId: loaded.quote.quoteId,
        decision: toPolicyDecisionDto(decision),
        transactionState,
        replayed,
      };
    });
  } catch (error) {
    if (error instanceof QuoteChangedDuringEvaluationError) {
      // The quote lapsed or was re-priced inside the write transaction. Report
      // what actually happened: it is not a missing quote, and a caller told so
      // would abandon a purchase that only needed a fresh price.
      return {
        kind: "QUOTE_NOT_USABLE",
        quoteId: command.quoteId,
        transactionId: null,
        cause: error.causeCode,
        reasons: error.reasons,
        validation: null,
      };
    }
    // Typed domain failures - an illegal transition, a terminal state, a
    // duplicate operation key used for a different event - already carry a safe
    // public face and are the caller's to handle. Everything else is wrapped so
    // a Prisma error, with its SQL and connection detail, travels no further.
    if (error instanceof AppError) throw error;
    throw new PolicyEvaluationFailureError(
      "the transaction could not be committed",
      error,
    );
  }
}

/** What the engine is given, plus the context the record needs. */
interface EvaluationInputs {
  readonly quote: EvaluableQuote;
  readonly policy: PolicySnapshot | null;
  readonly productId: string;
  readonly buyerProfileId: string;
  readonly correlationId: string | null;
}

/**
 * Reads the quote, its product and the buyer's policy inside the write transaction.
 *
 * The quote is re-assessed here even though the caller validated it moments
 * ago. That is not belt-and-braces: `validateQuoteForUse` runs on its own
 * connection, outside this transaction, and between the two a price can move.
 * Re-checking inside the transaction is what ties the decision to rows that
 * cannot change under it before it commits.
 */
async function loadEvaluationInputs(
  tx: TransactionCapableClient,
  quoteId: string,
  now: Date,
): Promise<EvaluationInputs> {
  const row = await tx.purchaseQuote.findUnique({
    where: { id: quoteId },
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
      transaction: { select: { buyerProfileId: true, correlationId: true } },
    },
  });

  if (row === null) {
    throw new QuoteChangedDuringEvaluationError(quoteId, "NOT_FOUND");
  }

  const snapshot: QuoteSnapshot = {
    quoteId: row.id,
    transactionId: row.transactionId,
    productId: row.productId,
    quantity: row.quantity,
    unitAmountMinor: row.unitAmount,
    totalAmountMinor: row.totalAmount,
    currency: row.currency as CurrencyCode,
    productVersion: row.productVersion,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };

  const verdict = assessQuote(
    snapshot,
    {
      unitAmountMinor: row.product.unitAmount,
      currency: row.product.currency,
      availableQuantity: row.product.inventory,
      purchasable: row.product.status === "AVAILABLE" && row.product.inventory > 0,
      version: row.product.version,
    },
    now,
  );
  if (verdict.kind !== "VALID") {
    throw new QuoteChangedDuringEvaluationError(
      quoteId,
      "CHANGED_DURING_EVALUATION",
      verdict.kind === "INVALIDATED" ? verdict.reasons : [],
    );
  }

  return {
    quote: {
      quoteId: snapshot.quoteId,
      transactionId: snapshot.transactionId,
      quantity: snapshot.quantity,
      unitAmountMinor: snapshot.unitAmountMinor,
      totalAmountMinor: snapshot.totalAmountMinor,
      currency: snapshot.currency,
    },
    policy: await loadPolicySnapshot(tx, row.transaction.buyerProfileId),
    productId: snapshot.productId,
    buyerProfileId: row.transaction.buyerProfileId,
    correlationId: row.transaction.correlationId,
  };
}

/**
 * Moves the transaction through the state machine, twice.
 *
 * QUOTE_CREATED -> POLICY_EVALUATED records that a decision was reached at all;
 * the second event records which one. Splitting them is what lets the history
 * show the evaluation happening independently of its verdict, and it is why
 * BLOCKED has a predecessor rather than appearing out of nowhere.
 *
 * Both go through the same transition service used everywhere else, lent this
 * caller's transaction. `Transaction.status` is never written here.
 */
async function moveLifecycle(
  tx: TransactionCapableClient,
  command: PolicyEvaluationCommand,
  loaded: EvaluationInputs,
  decision: PolicyDecision,
): Promise<TransactionState> {
  const base = `policy:${command.operationId}`;
  const details: JsonObject = {
    quoteId: loaded.quote.quoteId,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    amountMinor: decision.evaluatedAmountMinor.toString(),
    currency: decision.currency,
  };

  const evaluated = await applyTransactionEventWithin(tx, {
    transactionId: loaded.quote.transactionId,
    event: "POLICY_EVALUATION_COMPLETED",
    actor: POLICY_ACTOR,
    idempotencyKey: `${base}:evaluated`,
    details,
  });

  const outcome = await applyTransactionEventWithin(tx, {
    transactionId: loaded.quote.transactionId,
    event: OUTCOME_EVENT[decision.decision],
    actor: POLICY_ACTOR,
    idempotencyKey: `${base}:outcome`,
    details,
  });

  return stateOf(outcome) ?? stateOf(evaluated) ?? "POLICY_EVALUATED";
}

/** The state a transition outcome leaves the transaction in, whichever arm it is. */
function stateOf(outcome: {
  readonly to?: TransactionState;
  readonly currentState?: TransactionState;
}): TransactionState | null {
  return outcome.to ?? outcome.currentState ?? null;
}

function assertUsableOperationId(operationId: string): void {
  if (operationId.length === 0) {
    throw new InvalidPolicyOperationIdError("it is empty");
  }
  if (operationId.length > MAX_OPERATION_ID_LENGTH) {
    throw new InvalidPolicyOperationIdError(
      `it is longer than ${String(MAX_OPERATION_ID_LENGTH)} characters`,
    );
  }
}

function buildOperationKey(
  command: PolicyEvaluationCommand,
  policyVersion: number | null,
): string {
  const version = policyVersion === null ? "none" : String(policyVersion);
  return `policy:${command.quoteId}:v${version}:${command.operationId}`;
}

/**
 * The structured record of one decision.
 *
 * Everything here is a fact the system computed or read. There is no model
 * narration, no prompt, no chain of thought, no request body and no environment
 * detail - an audit trail that quoted any of those would become a place secrets
 * go to be stored forever.
 */
function buildAuditMetadata(
  command: PolicyEvaluationCommand,
  loaded: EvaluationInputs,
  decision: PolicyDecision,
): JsonObject {
  // Trusted facts only, and only facts the row does not already carry as a
  // column. The transaction id, the reason code and the timestamp are columns;
  // the explanation is derived at read time from the code plus these numbers,
  // so storing a sentence here would be a second source of truth.
  return {
    quoteId: loaded.quote.quoteId,
    productId: loaded.productId,
    buyerProfileId: loaded.buyerProfileId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    decision: decision.decision,
    quantity: loaded.quote.quantity,
    amountMinor: decision.evaluatedAmountMinor.toString(),
    currency: decision.currency,
    autoApproveLimitMinor:
      decision.autoApproveLimitMinor === null
        ? null
        : decision.autoApproveLimitMinor.toString(),
    operationId: command.operationId,
  };
}
