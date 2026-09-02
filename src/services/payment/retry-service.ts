import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/persistence/client";
import { getReservationConfig } from "@/config/env";
import { systemClock, type Clock } from "@/lib/clock";
import { createLogger } from "@/lib/logger";
import { readActiveQuote } from "@/services/quote/quote-reader";
import { recheckPolicyAuthorization } from "@/services/policy/authorization-recheck";
import { releaseReservation } from "@/services/inventory/reservation-service";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { createPaymentOrder } from "@/services/payment/payment-order-service";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import {
  MAX_PAYMENT_ATTEMPTS,
  endsWorkflow,
  remainingAttempts,
  withinAttemptLimit,
  type PaymentRetryResult,
  type RetryDenial,
  type RetryEligibility,
  type RetryStatusDto,
} from "@/domain/payment/retry";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { ReservationServiceDeps } from "@/services/inventory/reservation-service";
import type { PaymentOrderServiceDeps } from "@/services/payment/payment-order-service";
import type { PaymentProvider } from "@/domain/payment/provider";
import type { JsonObject } from "@/lib/json";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Retrying a failed payment: a bounded, human-triggered, deterministic gate.
 *
 * The whole file exists to make one thing true - **nothing except a person can
 * cause a second payment attempt**, and even a person only gets as many as this
 * system decided in advance. Everything else follows from that.
 *
 * **Nothing here is automatic.** There is no scheduler, no backoff, no queue and
 * no path from a webhook into this module. A `payment.failed` event records a
 * failure and stops. The buyer agent has no tool that reaches this code, and the
 * request boundary above it accepts one internal identifier and nothing else -
 * so there is no field through which a model, or a browser, could assert an
 * amount, a retry count, an approval or a provider order.
 *
 * **Being authorized once is not being authorized now.** Every retry re-reads
 * the trusted quote against today's product row, re-runs the deterministic
 * policy against today's policy version, re-checks that a human approval - if
 * one was needed - still names this exact quote and amount, and confirms the
 * stock hold is still live. A retry that skipped any of those would be charging
 * a price nobody currently offers on authority nobody currently holds.
 *
 * **A retry is a new attempt, never an edited one.** The failed PaymentAttempt
 * is left exactly as it is, forever. History reads #1 FAILED, #2 FAILED, #3
 * CAPTURED, and a reader can see every provider order and every provider
 * payment that was ever involved. Overwriting the failed row would destroy the
 * only evidence that a first payment was tried at all.
 *
 * **Concurrency is settled by PostgreSQL.** Two simultaneous requests compute
 * the same next attempt number from the same rows, so they race for one unique
 * claim key in `payment_attempt` and exactly one wins; the loser converges on
 * the winner's attempt without ever calling the provider. Nothing here depends
 * on a disabled button, an in-memory lock, or timing.
 */
assertServerOnly("src/services/payment/retry-service.ts");

const log = createLogger({ category: "payment" });

/**
 * The actor for every audit record this service writes.
 *
 * `transaction_service`, matching the actor the transition matrix permits to
 * take the retry edge out of PAYMENT_FAILED. Not `human_user`: a person asked,
 * but what is being recorded is a deterministic server decision, and attributing
 * it to the buyer would suggest they vouched for controls they never saw.
 */
const RETRY_ACTOR = "transaction_service" as const;

/** Attempt statuses that mean a payment is still live and must not be doubled. */
const LIVE_ATTEMPT_STATUSES = ["CREATED", "PENDING", "VERIFIED"] as const;

/** Transaction states in which the money has already arrived. */
const CAPTURED_STATES = ["PAYMENT_CAPTURED", "COMPLETED"] as const;

/**
 * What the read-only gate needs, and nothing more.
 *
 * Split out because the gate has two callers with very different privileges.
 * The retry request needs a payment provider and the inventory boundary; the
 * checkout page needs neither, and should not have to construct Razorpay
 * credentials just to decide whether to render a button. Narrowing the
 * parameter is also a small structural guarantee: a function typed against this
 * cannot reach a provider or release stock, because it has no handle on either.
 */
export interface RetryGateDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
}

export interface RetryServiceDeps extends RetryGateDeps {
  readonly provider: PaymentProvider;
  /**
   * Passed explicitly rather than constructed here, matching how the policy
   * service takes its quote dependencies. A retry that ends the workflow gives
   * held stock back through the inventory boundary, and a test must be able to
   * point that boundary at the same database and clock as everything else.
   */
  readonly reservation: ReservationServiceDeps;
}

export function defaultRetryGateDeps(): RetryGateDeps {
  return { prisma: getPrismaClient(), clock: systemClock };
}

export function defaultRetryDeps(): RetryServiceDeps {
  const prisma = getPrismaClient();
  return {
    prisma,
    clock: systemClock,
    provider: createRazorpayProvider(),
    reservation: {
      prisma,
      clock: systemClock,
      ttlSeconds: getReservationConfig().RESERVATION_TTL_SECONDS,
    },
  };
}

/**
 * What a caller may say.
 *
 * One internal identifier and an optional correlation id. There is deliberately
 * no amount, no currency, no retry number, no retry limit, no provider order id,
 * no policy verdict and no approval flag - and no parameter for a future caller
 * to start adding one to.
 */
export interface RequestPaymentRetryCommand {
  readonly transactionId: string;
  readonly operationId?: string;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Decides whether this transaction may be paid again, changing nothing.
 *
 * Read-only on purpose, and that is what makes it usable twice: the checkout
 * page consults it to decide whether to offer a Retry button, and the retry
 * request itself consults it again a moment later. A gate with side effects
 * could not be asked speculatively, and one that could only be asked once would
 * force the page to guess.
 *
 * The checks run in the order a sceptic would ask them, cheapest and most
 * fundamental first, and each one is answered from persisted rows.
 */
export async function evaluateRetryEligibility(
  transactionId: string,
  deps: RetryGateDeps,
): Promise<RetryEligibility> {
  const now = deps.clock.now();

  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    // The correlation id is carried out of the gate rather than fetched again
    // by the caller. It costs nothing here and saves a round trip on a path
    // that already makes a dozen of them against a remote database.
    select: { id: true, status: true, correlationId: true },
  });
  if (transaction === null) {
    return denied(transactionId, "TRANSACTION_NOT_FOUND", 0, {});
  }
  const correlationId = transaction.correlationId;

  // Every attempt this transaction has ever had. The limit is counted from
  // these rows and from nothing else - there is no browser state, no session
  // counter and no request field anywhere on this path.
  const attempts = await deps.prisma.paymentAttempt.findMany({
    where: { transactionId },
    select: { id: true, attemptNumber: true, status: true },
    orderBy: { attemptNumber: "asc" },
  });
  const attemptsUsed = attempts.length;

  if ((CAPTURED_STATES as readonly string[]).includes(transaction.status)) {
    // Includes the late-capture case: a genuine capture for an earlier attempt
    // arrived while a retry was being considered. The money is here; asking for
    // more would be asking to be charged twice.
    return denied(transactionId, "PAYMENT_ALREADY_CAPTURED", attemptsUsed, {
      state: transaction.status,
    });
  }
  if (transaction.status !== "PAYMENT_FAILED") {
    return denied(transactionId, "TRANSACTION_STATE_INVALID", attemptsUsed, {
      state: transaction.status,
    });
  }

  // Belt and braces against the transaction row and its attempts disagreeing.
  // If any attempt is captured the money arrived, whatever the lifecycle says.
  const capturedAttempt = attempts.find((attempt) => attempt.status === "CAPTURED");
  if (capturedAttempt !== undefined) {
    return denied(transactionId, "PAYMENT_ALREADY_CAPTURED", attemptsUsed, {
      paymentAttemptId: capturedAttempt.id,
    });
  }

  const unresolved = attempts.find(
    (attempt) => attempt.status === "RECONCILIATION_REQUIRED",
  );
  if (unresolved !== undefined) {
    // The strictest refusal in the gate. An unresolved attempt may correspond
    // to a real provider order this database never finished recording, and the
    // only safe move is to look its receipt up - never to create another.
    return denied(transactionId, "OUTCOME_UNRESOLVED", attemptsUsed, {
      paymentAttemptId: unresolved.id,
    });
  }

  const live = attempts.find((attempt) =>
    (LIVE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status),
  );
  if (live !== undefined) {
    // Closes the double-click window that the state check alone would miss: an
    // attempt row is committed a moment before the lifecycle move that follows
    // it, so for that instant the transaction still reads PAYMENT_FAILED while
    // a new attempt already exists.
    return denied(transactionId, "ATTEMPT_IN_PROGRESS", attemptsUsed, {
      paymentAttemptId: live.id,
      attemptStatus: live.status,
    });
  }

  if (!withinAttemptLimit(attemptsUsed)) {
    return denied(transactionId, "RETRY_LIMIT_REACHED", attemptsUsed, {
      maxAttempts: MAX_PAYMENT_ATTEMPTS,
    });
  }

  // --- The financial facts, re-read rather than remembered. ----------------
  const quote = await readActiveQuote(deps.prisma, transactionId, now);
  if (quote === null) {
    return denied(transactionId, "NO_ACTIVE_QUOTE", attemptsUsed, {});
  }
  if (quote.usability.kind !== "VALID") {
    // The price moved, the currency changed, the product version was bumped or
    // the quote simply lapsed. This system will not silently reprice: the
    // amount a person was shown is the only amount it is willing to charge, and
    // there is no legal path from PAYMENT_FAILED back to quoting.
    return denied(
      transactionId,
      "FINANCIAL_FACTS_CHANGED",
      attemptsUsed,
      { usability: quote.usability.kind, quoteId: quote.snapshot.quoteId },
      quote.usability.kind === "INVALIDATED" ? quote.usability.reasons : [],
    );
  }
  const snapshot = quote.snapshot;

  // --- The stock hold. -----------------------------------------------------
  //
  // A retry cannot create one. `reserveInventory` only claims stock from
  // AUTHORIZED, and there is no edge from PAYMENT_FAILED back to it - so the
  // hold made before the first attempt either survived or the purchase is over.
  // That is the deliberate design: re-reserving here would need a fresh
  // authorization, and inventing one is exactly what this gate exists to
  // prevent.
  const reservation = await deps.prisma.inventoryReservation.findFirst({
    where: { transactionId, status: "ACTIVE" },
    select: {
      id: true,
      purchaseQuoteId: true,
      productId: true,
      quantity: true,
      expiresAt: true,
    },
  });
  if (
    reservation === null ||
    reservation.expiresAt.getTime() <= now.getTime() ||
    reservation.purchaseQuoteId !== snapshot.quoteId ||
    reservation.productId !== snapshot.productId ||
    reservation.quantity !== snapshot.quantity
  ) {
    return denied(transactionId, "RESERVATION_NOT_HELD", attemptsUsed, {
      held: reservation !== null,
      expired: reservation !== null && reservation.expiresAt.getTime() <= now.getTime(),
    });
  }

  // --- Authorization, re-derived against today's policy. -------------------
  const recheck = await recheckPolicyAuthorization(
    transactionId,
    { prisma: deps.prisma, clock: deps.clock },
    // The approval may answer only the question it was asked: it must name this
    // transaction, this exact quote, this exact amount and currency, and the
    // policy version still in force. An approval bound to anything else cannot
    // authorize this retry, which is what stops a retry from being a way to
    // launder a changed amount past a decision a person already made.
    { acceptedStates: ["PAYMENT_FAILED"], approvalMaySatisfy: true },
  );
  if (recheck.kind !== "AUTHORIZED") {
    return denied(transactionId, "NOT_AUTHORIZED", attemptsUsed, {
      recheck: recheck.refusal,
    });
  }
  if (recheck.quoteId !== snapshot.quoteId) {
    // Defensive: the recheck reads the active quote independently, so a
    // divergence means a row moved between two reads. Refuse rather than pick.
    return denied(transactionId, "NOT_AUTHORIZED", attemptsUsed, {
      recheck: "QUOTE_CHANGED_SINCE_AUTHORIZATION",
    });
  }

  const highestAttemptNumber = attempts.reduce(
    (highest, attempt) => Math.max(highest, attempt.attemptNumber),
    0,
  );

  return {
    kind: "ELIGIBLE",
    transactionId,
    correlationId,
    quoteId: snapshot.quoteId,
    reservationId: reservation.id,
    // Derived from the persisted rows, so two concurrent requests compute the
    // same number and therefore race for the same claim key.
    nextAttemptNumber: highestAttemptNumber + 1,
    attemptsUsed,
    amountMinor: snapshot.totalAmountMinor,
    currency: snapshot.currency,
    policyVersion: recheck.policyVersion,
    policyDecision: recheck.decision.decision,
    approvalId: recheck.satisfiedByApprovalId,
  };
}

/**
 * What the checkout page shows about retrying.
 *
 * Derived from the same gate the request itself runs, so the page can never
 * offer a button the server would refuse - and, more importantly, a page that
 * somehow did would change nothing, because the button only sends a transaction
 * id and the decision is made again on arrival.
 */
export async function readRetryStatus(
  transactionId: string,
  deps: RetryGateDeps = defaultRetryGateDeps(),
): Promise<RetryStatusDto | null> {
  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { status: true },
  });
  if (transaction === null) return null;

  const eligibility = await evaluateRetryEligibility(transactionId, deps);
  const { attemptsUsed } = eligibility;

  // The newest failure, so the page can explain the most recent thing that
  // happened rather than the first. Read-only, like the rest of this function.
  const lastFailed = await deps.prisma.paymentAttempt.findFirst({
    where: { transactionId, status: "FAILED" },
    orderBy: { attemptNumber: "desc" },
    select: { failureCategory: true },
  });

  return {
    transactionId,
    transactionState: transaction.status,
    attemptsUsed,
    maxAttempts: MAX_PAYMENT_ATTEMPTS,
    remaining: remainingAttempts(attemptsUsed),
    available: eligibility.kind === "ELIGIBLE",
    denial: eligibility.kind === "ELIGIBLE" ? null : eligibility.denial,
    lastFailure: lastFailed?.failureCategory ?? null,
  };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * Grants or refuses one explicit human retry request.
 *
 * The sequence is: decide, record the decision, then act on it. Recording
 * before the provider call means a retry that was authorized and then failed at
 * the provider still shows *why it was allowed* - which is the question asked
 * after a disputed charge, and it cannot be reconstructed from a provider error.
 */
export async function requestPaymentRetry(
  command: RequestPaymentRetryCommand,
  deps: RetryServiceDeps = defaultRetryDeps(),
): Promise<PaymentRetryResult> {
  const { transactionId } = command;

  const eligibility = await evaluateRetryEligibility(transactionId, deps);
  if (eligibility.kind === "DENIED" && eligibility.denial === "TRANSACTION_NOT_FOUND") {
    // Nothing to attribute an audit record to. Answered exactly like every
    // other refusal so a caller cannot probe for which transactions exist.
    return refuse(eligibility, false);
  }

  const correlationId = eligibility.correlationId;

  await audit(deps, {
    transactionId,
    action: "payment_retry_requested",
    result: "PENDING",
    reasonCode: "PAYMENT_RETRY_REQUESTED",
    correlationId,
    // Keyed on the attempts already used, so repeated clicks within one retry
    // cycle converge on a single record rather than letting anyone with a
    // transaction id append rows to a financial trail at will.
    operationKey: `payment_retry_requested:${transactionId}:${String(eligibility.attemptsUsed)}`,
    trustedInputs: counters(eligibility.attemptsUsed, command.operationId),
  });

  if (eligibility.kind === "DENIED") {
    return await recordDenial(deps, eligibility, correlationId, command.operationId);
  }

  // Fail closed, unlike every other record here. This one is written *before*
  // the provider call and is the only evidence that the gate re-ran the quote,
  // the policy, the approval binding and the stock hold. Swallowing its failure
  // would let a retry create a real order at Razorpay with nothing in the trail
  // saying why it was allowed - and an unexplained charge is exactly what this
  // objective exists to prevent. No record, no provider call.
  await recordAuditEvent(deps.prisma, {
    transactionId,
    action: "payment_retry_authorized",
    actor: RETRY_ACTOR,
    result: "SUCCESS",
    reasonCode: "PAYMENT_RETRY_AUTHORIZED",
    correlationId,
    operationKey: `payment_retry_authorized:${transactionId}:${String(eligibility.nextAttemptNumber)}`,
    trustedInputs: {
      ...counters(eligibility.attemptsUsed, command.operationId),
      attemptNumber: eligibility.nextAttemptNumber,
      quoteId: eligibility.quoteId,
      reservationId: eligibility.reservationId,
      amountMinor: eligibility.amountMinor.toString(),
      currency: eligibility.currency,
      policyVersion: eligibility.policyVersion,
      policyDecision: eligibility.policyDecision,
      provider: "RAZORPAY",
      ...(eligibility.approvalId === null ? {} : { approvalId: eligibility.approvalId }),
    },
  });

  // --- The one external side effect, behind the existing safe boundary. ----
  //
  // Reused rather than reimplemented. Everything that makes order creation safe
  // - the durable claim, the receipt idempotency, the three-outcome provider
  // contract, the unresolved-outcome parking - is Objective 10's, and a second
  // implementation for retries would be a second chance to get it wrong.
  const order = await createPaymentOrder(
    { transactionId, retry: { attemptNumber: eligibility.nextAttemptNumber } },
    orderDeps(deps),
  );

  if (order.kind !== "ORDER_CREATED") {
    log.warn("a retry was authorized but no payment order became available", {
      transactionId,
      outcome: order.kind,
    });
    return {
      kind: "ORDER_NOT_READY",
      transactionId,
      attemptsUsed: eligibility.attemptsUsed,
      maxAttempts: MAX_PAYMENT_ATTEMPTS,
      reason: order.kind,
      detail:
        order.kind === "REFUSED"
          ? { refusal: order.refusal, ...order.detail }
          : order.kind === "PROVIDER_FAILED"
            ? { category: order.category, retryable: order.retryable }
            : { paymentAttemptId: order.paymentAttemptId },
    };
  }

  // Read back rather than assumed. On the convergence path this call may be
  // reporting an attempt another request created, and its number is the one
  // that was actually written.
  const created = await deps.prisma.paymentAttempt.findUnique({
    where: { id: order.order.paymentAttemptId },
    select: { attemptNumber: true },
  });

  return {
    kind: "RETRY_STARTED",
    transactionId,
    paymentAttemptId: order.order.paymentAttemptId,
    attemptNumber: created?.attemptNumber ?? eligibility.nextAttemptNumber,
    attemptsUsed: eligibility.attemptsUsed,
    maxAttempts: MAX_PAYMENT_ATTEMPTS,
    amount: order.order.amount,
    transactionState: order.transactionState,
    replayed: order.replayed,
  };
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/**
 * Records a refusal, and gives held stock back when nothing further can happen.
 *
 * The release is the part worth reading twice. A purchase whose retry limit is
 * exhausted, whose price has moved, or whose authorization no longer holds is
 * over - there is no legal path from PAYMENT_FAILED to a new quote, a new
 * approval or a new reservation - and continuing to hold a unit for it keeps
 * stock away from buyers who can actually complete. Refusals that are merely
 * *not yet* resolvable release nothing, because releasing on a guess is how a
 * system gives away a unit somebody is in the middle of paying for.
 */
async function recordDenial(
  deps: RetryServiceDeps,
  eligibility: RetryEligibility & { readonly kind: "DENIED" },
  correlationId: string | null,
  operationId: string | undefined,
): Promise<PaymentRetryResult> {
  const { transactionId, denial, attemptsUsed } = eligibility;

  if (denial === "RETRY_LIMIT_REACHED") {
    // Its own record, because "you have used every attempt" is the one refusal
    // a person is most likely to come back and ask about, and burying it inside
    // a generic denial would make it findable only by reading reason codes.
    await audit(deps, {
      transactionId,
      action: "payment_retry_limit_reached",
      result: "BLOCKED",
      reasonCode: "RETRY_LIMIT_REACHED",
      correlationId,
      operationKey: `payment_retry_limit:${transactionId}`,
      trustedInputs: counters(attemptsUsed, operationId),
    });
  }

  await audit(deps, {
    transactionId,
    action: "payment_retry_denied",
    result: "BLOCKED",
    reasonCode: denial,
    correlationId,
    // Keyed on the refusal as well as the cycle: a person who clicks twice gets
    // one record, while a genuinely different refusal later is its own event
    // rather than being swallowed by the first.
    operationKey: `payment_retry_denied:${transactionId}:${String(attemptsUsed)}:${denial}`,
    trustedInputs: {
      ...counters(attemptsUsed, operationId),
      refusal: denial,
      ...(eligibility.reasons.length === 0 ? {} : { reasons: [...eligibility.reasons] }),
    },
  });

  let released = false;
  if (endsWorkflow(denial)) {
    released = await releaseHeldStock(deps, transactionId);
  }

  return refuse(eligibility, released);
}

/**
 * Gives back whatever ACTIVE hold this transaction still has.
 *
 * Goes through the inventory boundary, never near the stock counters. That
 * boundary's conditional UPDATE from ACTIVE is what makes the decrement happen
 * exactly once however many refusals arrive at the same moment.
 */
async function releaseHeldStock(
  deps: RetryServiceDeps,
  transactionId: string,
): Promise<boolean> {
  const reservation = await deps.prisma.inventoryReservation.findFirst({
    where: { transactionId, status: "ACTIVE" },
    select: { id: true },
  });
  if (reservation === null) return false;

  try {
    const outcome = await releaseReservation(
      { reservationId: reservation.id, reasonCode: "PAYMENT_RETRY_UNAVAILABLE" },
      deps.reservation,
    );
    return outcome.kind === "RELEASED";
  } catch (error) {
    // A refusal is still a correct refusal if the stock could not be handed
    // back; the reservation has its own expiry and will lapse on its own. What
    // must not happen is an infrastructure error replacing the answer the
    // caller is owed.
    log.error("held stock could not be released after a refused retry", {
      transactionId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function orderDeps(deps: RetryServiceDeps): PaymentOrderServiceDeps {
  return { prisma: deps.prisma, clock: deps.clock, provider: deps.provider };
}

/** The two counters every retry record carries, both read from the database. */
function counters(attemptsUsed: number, operationId: string | undefined): JsonObject {
  return {
    attemptsUsed,
    maxAttempts: MAX_PAYMENT_ATTEMPTS,
    ...(operationId === undefined ? {} : { operationId }),
  };
}

function denied(
  transactionId: string,
  denial: RetryDenial,
  attemptsUsed: number,
  detail: Readonly<Record<string, string | number | boolean | null>>,
  reasons: readonly QuoteInvalidationReason[] = [],
  correlationId: string | null = null,
): RetryEligibility {
  return {
    kind: "DENIED",
    transactionId,
    correlationId,
    denial,
    attemptsUsed,
    detail,
    reasons,
    workflowEnded: endsWorkflow(denial),
  };
}

function refuse(
  eligibility: RetryEligibility & { readonly kind: "DENIED" },
  reservationReleased: boolean,
): PaymentRetryResult {
  return {
    kind: "DENIED",
    transactionId: eligibility.transactionId,
    denial: eligibility.denial,
    attemptsUsed: eligibility.attemptsUsed,
    maxAttempts: MAX_PAYMENT_ATTEMPTS,
    detail: eligibility.detail,
    reasons: eligibility.reasons,
    reservationReleased,
  };
}

/**
 * Writes one best-effort audit record.
 *
 * Only for records that describe a decision which changed nothing by itself:
 * the request was received, or it was refused. Neither writes financial state,
 * so a trail entry that could not be written is logged for operators rather
 * than turned into a server error that hides what the gate actually decided.
 *
 * The authorization record does **not** go through here. It is the evidence
 * that the controls ran, it precedes an irreversible provider call, and it is
 * written fail-closed at the call site for that reason.
 */
async function audit(
  deps: RetryServiceDeps,
  command: {
    readonly transactionId: string;
    readonly action:
      "payment_retry_requested" | "payment_retry_denied" | "payment_retry_limit_reached";
    readonly result: "BLOCKED" | "PENDING";
    readonly reasonCode: string;
    readonly correlationId: string | null;
    readonly operationKey: string;
    readonly trustedInputs: JsonObject;
  },
): Promise<void> {
  try {
    await recordAuditEvent(deps.prisma, {
      transactionId: command.transactionId,
      action: command.action,
      actor: RETRY_ACTOR,
      result: command.result,
      reasonCode: command.reasonCode,
      correlationId: command.correlationId,
      operationKey: command.operationKey,
      trustedInputs: command.trustedInputs,
    });
  } catch (error) {
    log.error("a payment retry decision could not be audited", {
      transactionId: command.transactionId,
      action: command.action,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}
