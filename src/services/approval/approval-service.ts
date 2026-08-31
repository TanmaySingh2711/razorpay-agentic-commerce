import { assertServerOnly } from "@/lib/server-only";
import { getApprovalConfig } from "@/config/env";
import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { evaluatePolicy } from "@/domain/policy/engine";
import { toPolicyDecisionDto } from "@/domain/policy/decision";
import {
  approvalTokenMatches,
  hashApprovalToken,
  issueApprovalToken,
} from "@/domain/approval/token";
import { ApprovalPersistenceError, ApprovalRefusedError } from "@/domain/approval/errors";
import {
  loadPolicySnapshot,
  readRecordedEvaluation,
} from "@/services/policy/policy-reader";
import { readActiveQuote, type ReadQuote } from "@/services/quote/quote-reader";
import { applyTransactionEventWithin } from "@/services/transaction/transition-service";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { AppError } from "@/domain/errors";
import type {
  ApprovalDecisionResult,
  ApprovalRequestDto,
  ApprovalRequestResult,
} from "@/domain/approval/contracts";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";
import type { TransactionState } from "@/domain/transaction/states";
import type { AuditEventType } from "@/domain/audit-event";
import type { CurrencyCode } from "@/domain/money";
import type { JsonObject } from "@/lib/json";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The human approval gate.
 *
 * Objective 7 can say "a person must decide this". This is where a person
 * actually does, and the whole file exists to keep three claims true.
 *
 * **A human approves one purchase, not a policy.** The approval is bound to one
 * transaction, one quote, one exact amount and one currency, and nothing here
 * writes to `AuthorizationPolicy`. Someone who agrees to a ₹3,499 keyboard has
 * not raised their spending limit, and an approval for that keyboard cannot
 * authorize a ₹4,999 one.
 *
 * **Approval is not authorization.** A person reads a notification and answers
 * minutes later, and in those minutes a price can move, stock can vanish and a
 * policy can be rewritten. So consent is the *beginning* of the check, not the
 * end: the quote is re-read, the product is re-read, and the policy engine is
 * re-run before the transaction is allowed to move.
 *
 * **The AI is not in this file.** No Gemini call, no model-callable tool, and
 * nothing in `src/services/buyer-agent/` may reach it. That is asserted by
 * test, not merely intended.
 */
assertServerOnly("src/services/approval/approval-service.ts");

/** The one actor permitted to convert human consent into authority. */
const APPROVAL_ACTOR = "approval_gate" as const;

export interface ApprovalServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  /** From configuration; never a literal at a call site. */
  readonly ttlSeconds: number;
}

export function defaultApprovalDeps(): ApprovalServiceDeps {
  return {
    prisma: getPrismaClient(),
    clock: systemClock,
    ttlSeconds: getApprovalConfig().APPROVAL_TTL_SECONDS,
  };
}

export interface RequestApprovalCommand {
  readonly transactionId: string;
  /** Operation identity, so a retried request writes one audit event. */
  readonly operationId: string;
}

/**
 * Opens an approval question for a transaction already waiting on one.
 *
 * The gate is the transaction's own state. Objective 7 puts a transaction into
 * `APPROVAL_REQUIRED` and nothing else does, so requiring that state here is
 * exactly the rule "an approval may be created only when the policy decision
 * was APPROVAL_REQUIRED" - expressed as persisted server truth rather than as a
 * flag a caller passes in. An ALLOWED transaction is already `AUTHORIZED` and a
 * BLOCKED one is terminal; neither can reach this.
 *
 * Every value the approval binds to is read here, from the database. The caller
 * supplies a transaction id and an operation id, and nothing else - there is no
 * field for an amount a browser might prefer.
 */
export async function requestApproval(
  command: RequestApprovalCommand,
  deps: ApprovalServiceDeps = defaultApprovalDeps(),
): Promise<ApprovalRequestResult> {
  const now = deps.clock.now();

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { id: command.transactionId },
        select: { id: true, status: true, buyerProfileId: true, correlationId: true },
      });
      if (transaction === null || transaction.status !== "APPROVAL_REQUIRED") {
        return notRequired(
          command.transactionId,
          "NOT_AWAITING_APPROVAL",
          transaction?.status ?? "BLOCKED",
        );
      }

      await expireStaleApprovals(
        tx,
        command.transactionId,
        now,
        transaction.correlationId,
      );

      const pending = await tx.approvalRequest.findFirst({
        where: { transactionId: command.transactionId, status: "PENDING" },
      });
      if (pending !== null) {
        return {
          kind: "APPROVAL_ALREADY_PENDING" as const,
          approval: toApprovalDto(pending),
        };
      }

      // Why a person was asked, and under which rule. Read from the audit
      // record Objective 7 wrote, so the approval carries the same policy
      // version the decision was made under.
      const recorded = await readRecordedEvaluation(tx, command.transactionId);
      if (recorded.kind !== "FOUND") {
        return notRequired(
          command.transactionId,
          "NO_RECORDED_EVALUATION",
          transaction.status,
        );
      }

      const quote = await readActiveQuote(tx, command.transactionId, now);
      if (quote === null) {
        return notRequired(command.transactionId, "NO_ACTIVE_QUOTE", transaction.status);
      }
      if (quote.usability.kind !== "VALID") {
        // Do not put a stale price in front of a person. Whatever they agreed
        // to would be unauthorizable the moment they agreed to it.
        return notRequired(
          command.transactionId,
          "QUOTE_NOT_USABLE",
          transaction.status,
          quote.usability.kind === "INVALIDATED" ? quote.usability.reasons : [],
        );
      }

      // The window closes at whichever comes first: the approval TTL, or the
      // expiry of the quote it is bound to.
      //
      // Without the cap an approval outlives the price it exists to authorize,
      // and every answer given after the quote lapses is refused - so a person
      // is handed fifteen minutes and discovers at minute six that they never
      // had them. Capping makes the deadline the system shows the same as the
      // deadline it enforces. The quote was just checked as VALID, which means
      // `now` is strictly before its expiry, so the capped window is never
      // empty.
      const windowEnd = new Date(now.getTime() + deps.ttlSeconds * 1000);
      const expiresAt =
        windowEnd < quote.snapshot.expiresAt ? windowEnd : quote.snapshot.expiresAt;

      const { token, nonceHash } = issueApprovalToken();
      const created = await tx.approvalRequest.create({
        data: {
          transactionId: command.transactionId,
          purchaseQuoteId: quote.snapshot.quoteId,
          // Every financial field comes from the quote row, never from a caller.
          requestedAmount: quote.snapshot.totalAmountMinor,
          currency: quote.snapshot.currency,
          policyLimitSnapshot: recorded.evaluation.autoApproveLimitMinor,
          policyVersion: recorded.evaluation.policyVersion,
          reasonCode: recorded.evaluation.reasonCode,
          status: "PENDING",
          nonceHash,
          // Both ends of the window come from the same clock. Letting
          // `createdAt` fall through to the database default would measure the
          // TTL between two different time sources, and any drift between them
          // would silently lengthen or shorten how long a person has to answer.
          // The CHECK constraint requiring `expiresAt > createdAt` is what
          // surfaces the mistake.
          createdAt: now,
          expiresAt,
        },
      });

      await writeApprovalEvent(tx, {
        transactionId: command.transactionId,
        eventType: "approval_requested",
        result: "PENDING",
        reasonCode: recorded.evaluation.reasonCode,
        correlationId: transaction.correlationId,
        operationKey: `approval-request:${command.transactionId}:${command.operationId}`,
        metadata: {
          approvalId: created.id,
          quoteId: quote.snapshot.quoteId,
          quantity: quote.snapshot.quantity,
          amountMinor: quote.snapshot.totalAmountMinor.toString(),
          currency: quote.snapshot.currency,
          policyVersion: recorded.evaluation.policyVersion,
          expiresAt: created.expiresAt.toISOString(),
          operationId: command.operationId,
        },
      });

      // The one and only time the plaintext leaves this function. It is not in
      // the row above, not in the audit event, and not in any read path.
      return {
        kind: "APPROVAL_REQUESTED" as const,
        approval: toApprovalDto(created),
        token,
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new ApprovalPersistenceError("the approval could not be opened", error);
  }
}

export interface ApprovalDecisionCommand {
  /** The plaintext token the human presented. Never logged, never persisted. */
  readonly token: string;
  readonly decision: "APPROVE" | "REJECT";
  /** Who is answering. Must be the buyer the transaction belongs to. */
  readonly decidedByBuyerId: string;
  readonly operationId: string;
}

/**
 * Applies a human's answer.
 *
 * The order of operations is the security design:
 *
 *  1. Find the approval by the digest of the presented token, then confirm the
 *     match in constant time.
 *  2. Inside one transaction, settle the approval with a **conditional**
 *     UPDATE - `WHERE status = 'PENDING' AND expiresAt > now`. That single
 *     statement is the replay guard: PostgreSQL evaluates it under a row lock,
 *     so of two simultaneous uses of the same token exactly one can match, and
 *     a token that was already consumed, rejected or expired matches nothing.
 *     There is deliberately no "read the status, then update it" pair anywhere
 *     in this file; that shape loses the race it is meant to win.
 *  3. Re-read the quote and the product, and re-run the policy engine.
 *  4. Only then move the transaction.
 *
 * Any refusal in step 3 or 4 throws, which rolls step 2 back - so a person's
 * single-use token is not burned because the world moved while they were
 * reading their phone. What burns a token is a decision that was actually
 * applied.
 */
export async function decideApproval(
  command: ApprovalDecisionCommand,
  deps: ApprovalServiceDeps = defaultApprovalDeps(),
): Promise<ApprovalDecisionResult> {
  const now = deps.clock.now();
  const presentedHash = hashApprovalToken(command.token);

  const candidate = await deps.prisma.approvalRequest.findUnique({
    where: { nonceHash: presentedHash },
    select: { id: true, nonceHash: true, transactionId: true },
  });
  // A forged, mistyped or already-forgotten token looks exactly like this, and
  // the reply says nothing about which - there is no oracle here for probing
  // whether a given approval exists.
  const storedHash = candidate?.nonceHash ?? null;
  if (
    candidate === null ||
    storedHash === null ||
    !approvalTokenMatches(command.token, storedHash)
  ) {
    return {
      kind: "REFUSED",
      transactionId: null,
      approvalId: null,
      refusal: "UNKNOWN_TOKEN",
      detail: {},
      reasons: [],
    };
  }

  try {
    return await deps.prisma.$transaction(async (tx) =>
      command.decision === "REJECT"
        ? await applyRejection(tx, candidate.id, command, now)
        : await applyApproval(tx, candidate.id, command, now),
    );
  } catch (error) {
    if (error instanceof ApprovalRefusedError) {
      return {
        kind: "REFUSED",
        transactionId: error.transactionId,
        approvalId: error.approvalId,
        refusal: error.refusal,
        detail: error.detail,
        reasons: error.reasons,
      };
    }
    if (error instanceof AppError) throw error;
    throw new ApprovalPersistenceError("the decision could not be committed", error);
  }
}

/** The conditional settle. The single statement that makes a token single-use. */
async function settleApproval(
  tx: TransactionCapableClient,
  approvalId: string,
  status: "CONSUMED" | "REJECTED",
  decidedByBuyerId: string,
  now: Date,
): Promise<void> {
  const settled = await tx.approvalRequest.updateMany({
    where: { id: approvalId, status: "PENDING", expiresAt: { gt: now } },
    data: { status, decidedAt: now, decidedByBuyerId },
  });
  if (settled.count === 1) return;

  // Nothing matched. Read the row only to say *why* - the decision itself was
  // already made, and lost, by the statement above.
  const row = await tx.approvalRequest.findUnique({
    where: { id: approvalId },
    select: { status: true, expiresAt: true, transactionId: true },
  });
  const expired = row !== null && row.status === "PENDING" && row.expiresAt <= now;
  throw new ApprovalRefusedError({
    refusal: expired ? "EXPIRED" : "ALREADY_SETTLED",
    approvalId,
    transactionId: row?.transactionId ?? null,
    detail: { status: row?.status ?? "UNKNOWN" },
  });
}

async function loadApprovalContext(
  tx: TransactionCapableClient,
  approvalId: string,
  decidedByBuyerId: string,
) {
  const approval = await tx.approvalRequest.findUniqueOrThrow({
    where: { id: approvalId },
    include: {
      transaction: {
        select: { id: true, status: true, buyerProfileId: true, correlationId: true },
      },
    },
  });

  // The approval belongs to one buyer. Someone else holding the token - a
  // forwarded link, a shared screen - is not the person whose money this is.
  if (approval.transaction.buyerProfileId !== decidedByBuyerId) {
    throw new ApprovalRefusedError({
      refusal: "NOT_THE_BUYER",
      approvalId,
      transactionId: approval.transactionId,
    });
  }
  return approval;
}

async function applyRejection(
  tx: TransactionCapableClient,
  approvalId: string,
  command: ApprovalDecisionCommand,
  now: Date,
): Promise<ApprovalDecisionResult> {
  await settleApproval(tx, approvalId, "REJECTED", command.decidedByBuyerId, now);
  const approval = await loadApprovalContext(tx, approvalId, command.decidedByBuyerId);

  // The existing lifecycle already has a word for a purchase a person refused,
  // and it is CANCELLED. Inventing a REJECTED transaction state would add a
  // second name for the same fact.
  await writeApprovalEvent(tx, {
    transactionId: approval.transactionId,
    eventType: "approval_denied",
    result: "BLOCKED",
    reasonCode: "APPROVAL_REJECTED",
    correlationId: approval.transaction.correlationId,
    operationKey: `approval-decision:${approvalId}:${command.operationId}`,
    metadata: {
      approvalId,
      quoteId: approval.purchaseQuoteId,
      amountMinor: approval.requestedAmount.toString(),
      currency: approval.currency,
      decidedByBuyerId: command.decidedByBuyerId,
      operationId: command.operationId,
    },
  });

  const outcome = await applyTransactionEventWithin(tx, {
    transactionId: approval.transactionId,
    event: "APPROVAL_REJECTED",
    actor: APPROVAL_ACTOR,
    idempotencyKey: `approval:${command.operationId}:rejected`,
    details: {
      approvalId,
      quoteId: approval.purchaseQuoteId,
      amountMinor: approval.requestedAmount.toString(),
      currency: approval.currency,
    },
  });

  return {
    kind: "REJECTED",
    transactionId: approval.transactionId,
    approvalId,
    transactionState: stateOf(outcome) ?? "CANCELLED",
  };
}

async function applyApproval(
  tx: TransactionCapableClient,
  approvalId: string,
  command: ApprovalDecisionCommand,
  now: Date,
): Promise<ApprovalDecisionResult> {
  await settleApproval(tx, approvalId, "CONSUMED", command.decidedByBuyerId, now);
  const approval = await loadApprovalContext(tx, approvalId, command.decidedByBuyerId);
  const transactionId = approval.transactionId;

  if (approval.transaction.status !== "APPROVAL_REQUIRED") {
    throw new ApprovalRefusedError({
      refusal: "TRANSACTION_NOT_AWAITING_APPROVAL",
      approvalId,
      transactionId,
      detail: { state: approval.transaction.status },
    });
  }

  // --- Revalidate the quote. Consent was about a specific price. -------------
  const quote = await readActiveQuote(tx, transactionId, now);
  if (quote === null) {
    throw new ApprovalRefusedError({
      refusal: "QUOTE_MISMATCH",
      approvalId,
      transactionId,
    });
  }
  if (quote.snapshot.quoteId !== approval.purchaseQuoteId) {
    // The transaction was re-quoted while the question was open. The live price
    // is one nobody has agreed to.
    throw new ApprovalRefusedError({
      refusal: "QUOTE_MISMATCH",
      approvalId,
      transactionId,
      detail: {
        approvedQuoteId: approval.purchaseQuoteId,
        activeQuoteId: quote.snapshot.quoteId,
      },
    });
  }
  if (quote.usability.kind !== "VALID") {
    throw new ApprovalRefusedError({
      refusal: "QUOTE_NOT_USABLE",
      approvalId,
      transactionId,
      detail: { usability: quote.usability.kind },
      reasons: quote.usability.kind === "INVALIDATED" ? quote.usability.reasons : [],
    });
  }
  assertBoundAmount(approval, quote, approvalId, transactionId);

  // --- Re-run the policy engine against today's rules. -----------------------
  const policy = await loadPolicySnapshot(tx, approval.transaction.buyerProfileId);
  const decision = evaluatePolicy(
    {
      quoteId: quote.snapshot.quoteId,
      transactionId,
      quantity: quote.snapshot.quantity,
      unitAmountMinor: quote.snapshot.unitAmountMinor,
      totalAmountMinor: quote.snapshot.totalAmountMinor,
      currency: quote.snapshot.currency,
    },
    policy,
  );

  if (decision.decision === "BLOCKED") {
    // A person can supply consent the policy was waiting for. A person cannot
    // supply consent for a purchase the policy forbids outright - those are
    // different questions, and this is the one the human was never asked.
    throw new ApprovalRefusedError({
      refusal: "POLICY_NOW_BLOCKS",
      approvalId,
      transactionId,
      detail: { reasonCode: decision.reasonCode },
    });
  }
  if (decision.policyVersion !== approval.policyVersion) {
    throw new ApprovalRefusedError({
      refusal: "POLICY_VERSION_CHANGED",
      approvalId,
      transactionId,
      detail: {
        approvedUnderPolicyVersion: approval.policyVersion,
        currentPolicyVersion: decision.policyVersion,
      },
    });
  }

  // --- Only now. ------------------------------------------------------------
  await writeApprovalEvent(tx, {
    transactionId,
    eventType: "approval_granted",
    result: "SUCCESS",
    reasonCode: decision.reasonCode,
    correlationId: approval.transaction.correlationId,
    operationKey: `approval-decision:${approvalId}:${command.operationId}`,
    metadata: {
      approvalId,
      quoteId: quote.snapshot.quoteId,
      quantity: quote.snapshot.quantity,
      amountMinor: quote.snapshot.totalAmountMinor.toString(),
      currency: quote.snapshot.currency,
      policyVersion: decision.policyVersion,
      policyDecision: decision.decision,
      decidedByBuyerId: command.decidedByBuyerId,
      operationId: command.operationId,
    },
  });

  const outcome = await applyTransactionEventWithin(tx, {
    transactionId,
    event: "APPROVAL_GRANTED",
    actor: APPROVAL_ACTOR,
    idempotencyKey: `approval:${command.operationId}:granted`,
    details: {
      approvalId,
      quoteId: quote.snapshot.quoteId,
      amountMinor: quote.snapshot.totalAmountMinor.toString(),
      currency: quote.snapshot.currency,
      policyVersion: decision.policyVersion,
      policyDecision: decision.decision,
    },
  });

  return {
    kind: "AUTHORIZED",
    transactionId,
    approvalId,
    quoteId: quote.snapshot.quoteId,
    authorizedAmount: {
      amountMinor: quote.snapshot.totalAmountMinor.toString(),
      currency: quote.snapshot.currency,
    },
    policy: toPolicyDecisionDto(decision),
    transactionState: stateOf(outcome) ?? "AUTHORIZED",
  };
}

/**
 * The binding that makes an approval mean one purchase.
 *
 * A human agreed to an exact number of an exact currency. If the live quote no
 * longer says that number, their consent does not reach it - not "close
 * enough", not "cheaper so surely fine". Cheaper counts too: an amount nobody
 * agreed to is an amount nobody agreed to.
 */
function assertBoundAmount(
  approval: { readonly requestedAmount: bigint; readonly currency: string },
  quote: ReadQuote,
  approvalId: string,
  transactionId: string,
): void {
  const sameAmount = approval.requestedAmount === quote.snapshot.totalAmountMinor;
  const sameCurrency = approval.currency === quote.snapshot.currency;
  if (sameAmount && sameCurrency) return;

  throw new ApprovalRefusedError({
    refusal: "AMOUNT_MISMATCH",
    approvalId,
    transactionId,
    detail: {
      approvedAmountMinor: approval.requestedAmount.toString(),
      approvedCurrency: approval.currency,
      liveAmountMinor: quote.snapshot.totalAmountMinor.toString(),
      liveCurrency: quote.snapshot.currency,
    },
  });
}

/**
 * Retires approvals whose window closed, before anything else looks at them.
 *
 * Lazy rather than scheduled, deliberately: a control that depends on a cron
 * job having run is a control that is wrong whenever the job is late, and an
 * expired approval must authorize nothing the instant it expires. The
 * conditional `status: "PENDING"` means two concurrent callers cannot both
 * record the same expiry.
 */
async function expireStaleApprovals(
  tx: TransactionCapableClient,
  transactionId: string,
  now: Date,
  correlationId: string | null,
): Promise<void> {
  const stale = await tx.approvalRequest.findMany({
    where: { transactionId, status: "PENDING", expiresAt: { lte: now } },
    select: { id: true, purchaseQuoteId: true },
  });

  for (const { id, purchaseQuoteId } of stale) {
    const marked = await tx.approvalRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    if (marked.count !== 1) continue;
    await writeApprovalEvent(tx, {
      transactionId,
      eventType: "approval_expired",
      result: "FAILURE",
      reasonCode: "APPROVAL_EXPIRED",
      correlationId,
      operationKey: `approval-expiry:${id}`,
      metadata: {
        approvalId: id,
        quoteId: purchaseQuoteId,
        expiredAt: now.toISOString(),
      },
    });
  }
}

interface ApprovalEvent {
  readonly transactionId: string;
  readonly eventType: AuditEventType;
  readonly result: "SUCCESS" | "FAILURE" | "BLOCKED" | "PENDING";
  readonly reasonCode: string;
  readonly correlationId: string | null;
  readonly operationKey: string;
  readonly metadata: JsonObject;
}

/**
 * Writes one approval event through the central audit boundary.
 *
 * A thin adapter rather than its own implementation: the boundary owns
 * idempotency, the trusted-input allow-list and the secret scan, so this
 * service cannot drift away from how the rest of the system audits. Note what
 * the metadata never contains - the token. The allow-list refuses it outright
 * rather than trusting this file to remember.
 */
async function writeApprovalEvent(
  tx: TransactionCapableClient,
  event: ApprovalEvent,
): Promise<void> {
  await recordAuditEvent(tx, {
    transactionId: event.transactionId,
    action: event.eventType,
    actor: APPROVAL_ACTOR,
    result: event.result,
    reasonCode: event.reasonCode,
    trustedInputs: event.metadata,
    correlationId: event.correlationId,
    operationKey: event.operationKey,
  });
}

interface ApprovalRow {
  readonly id: string;
  readonly transactionId: string;
  readonly purchaseQuoteId: string;
  readonly requestedAmount: bigint;
  readonly currency: string;
  readonly policyLimitSnapshot: bigint;
  readonly policyVersion: number;
  readonly reasonCode: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** The safe projection. Never carries the token, by construction. */
function toApprovalDto(row: ApprovalRow): ApprovalRequestDto {
  const currency = row.currency as CurrencyCode;
  return {
    id: row.id,
    transactionId: row.transactionId,
    quoteId: row.purchaseQuoteId,
    requestedAmount: { amountMinor: row.requestedAmount.toString(), currency },
    policyVersion: row.policyVersion,
    policyLimit: { amountMinor: row.policyLimitSnapshot.toString(), currency },
    reasonCode: row.reasonCode,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function notRequired(
  transactionId: string,
  refusal:
    | "NOT_AWAITING_APPROVAL"
    | "NO_RECORDED_EVALUATION"
    | "NO_ACTIVE_QUOTE"
    | "QUOTE_NOT_USABLE",
  transactionState: TransactionState,
  reasons: readonly (
    | "PRICE_CHANGED"
    | "CURRENCY_CHANGED"
    | "INSUFFICIENT_STOCK"
    | "PRODUCT_UNAVAILABLE"
    | "PRODUCT_VERSION_CHANGED"
    | "SUPERSEDED_BY_NEWER_QUOTE"
  )[] = [],
): ApprovalRequestResult {
  return {
    kind: "APPROVAL_NOT_REQUIRED",
    transactionId,
    refusal,
    transactionState,
    reasons,
  };
}

function stateOf(outcome: {
  readonly to?: TransactionState;
  readonly currentState?: TransactionState;
}): TransactionState | null {
  return outcome.to ?? outcome.currentState ?? null;
}
