import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { createLogger } from "@/lib/logger";
import { readActiveQuote } from "@/services/quote/quote-reader";
import { recheckPolicyAuthorization } from "@/services/policy/authorization-recheck";
import { applyTransactionEventWithin } from "@/services/transaction/transition-service";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { assessPayableAmount, deriveReceipt } from "@/domain/payment/rules";
import { isSafelyRetryable } from "@/domain/payment/provider";
import { InfrastructureError } from "@/domain/errors";
import { toMoneyDto, moneyFromBigInt, type CurrencyCode } from "@/domain/money";
import type {
  PaymentOrderDto,
  PaymentOrderRefusal,
  PaymentOrderResult,
} from "@/domain/payment/contracts";
import type {
  PaymentProvider,
  ProviderFailure,
  ProviderOrder,
} from "@/domain/payment/provider";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";
import type { TransactionState } from "@/domain/transaction/states";
import type { JsonObject } from "@/lib/json";
import type { PaymentAttempt, PrismaClient } from "@/generated/prisma/client";

/**
 * Creating a payment order: the first thing this system does that it cannot
 * take back.
 *
 * Every objective before this one was reversible. A quote can be superseded, a
 * policy decision re-derived, a reservation released; if a PostgreSQL
 * transaction rolls back, the world is as it was. An order at Razorpay is not
 * like that. Once the request leaves this process the order may exist whether
 * or not our database ever hears about it, and no rollback anywhere reaches it.
 *
 * Three commitments follow from that, and they shape everything below.
 *
 * **1. Nothing external happens until every internal control has passed.** The
 * transaction state, the trusted quote, the inventory reservation, the
 * authorization and a fresh policy recheck are all verified first, in that
 * order, with no provider call anywhere among them. A refusal at any point
 * costs a database read and nothing else.
 *
 * **2. Exactly one caller may create the order.** A row in `payment_attempt`
 * with a unique, server-derived idempotency key is the claim. Two concurrent
 * requests both try to insert it, PostgreSQL lets exactly one succeed, and the
 * loser never calls the provider. No in-memory mutex - which would not survive
 * two processes - and no Redis.
 *
 * **3. The unknown outcome is a first-class state.** A lost response is not a
 * failure and must not be treated as one, because the natural response to a
 * failure is to try again and the result of trying again would be a second
 * order. The attempt is parked at RECONCILIATION_REQUIRED, holding the receipt
 * that can resolve it, and no retry is issued.
 *
 * The amount is read from the persisted PurchaseQuote and from nowhere else. It
 * is not in the request body, so a caller cannot supply one; there is no
 * parameter for it, so a future caller cannot start.
 */
assertServerOnly("src/services/payment/payment-order-service.ts");

/** The actor the state machine permits to move a transaction on a payment event. */
const PAYMENT_ACTOR = "payment_provider" as const;

/**
 * The actor for the retry edge out of PAYMENT_FAILED.
 *
 * The matrix restricts `PAYMENT_RETRY_REQUESTED` to `transaction_service`, and
 * that restriction is the point: leaving PAYMENT_FAILED is an internal decision
 * this system makes after re-running its own controls, not something the
 * provider - or anything acting for it - may assert. Attributing it to
 * `payment_provider` would say Razorpay decided to retry, which is false.
 */
const RETRY_ACTOR = "transaction_service" as const;

const AUDIT_ACTION = "payment_order_created" as const;

/** PostgreSQL's unique-violation code, surfaced by Prisma as `P2002`. */
const UNIQUE_VIOLATION = "P2002";

/**
 * The only states in which replaying this request may answer with an order.
 *
 * A transaction that was cancelled, expired, blocked or failed *after* its
 * order was created still has a perfectly real provider order attached to it.
 * Reporting that as ORDER_CREATED would hand a caller a green light read off a
 * dead transaction - "your order is ready, go pay" for a purchase that is over.
 *
 * So the replay short-circuit is narrowed to the states where the order is both
 * live and still unpaid. Everything else - including COMPLETED, where the money
 * has already moved - is a state error naming the state, which is honest and
 * actionable. This is the same narrowing the reservation service applies to its
 * own retry path, and for the same reason.
 */
const ORDER_REPLAYABLE_STATES: readonly TransactionState[] = [
  "PAYMENT_ORDER_CREATED",
  "PAYMENT_PENDING",
];

/**
 * How long a claim may sit with no recorded outcome before it is treated as
 * abandoned rather than in flight.
 *
 * A claim row is the right to call the provider, and the holder normally
 * resolves it within seconds - the provider request itself times out at 15s.
 * But a process that dies between claiming and recording an outcome leaves the
 * row at CREATED forever, and without a lease every later retry would answer
 * CREATION_IN_PROGRESS for a request nobody is working on. That is a permanent
 * wedge, not a safety property.
 *
 * Correctness does not depend on this number being right. If the lease expires
 * while the original holder is still working, both callers present the *same*
 * receipt, and Razorpay's receipt idempotency rejects the second create and
 * hands back the existing order. The lease only decides how long a wedged
 * transaction waits, never whether a duplicate order can exist.
 */
const CLAIM_LEASE_MS = 60_000;

const log = createLogger({ category: "payment" });

export interface PaymentOrderServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly provider: PaymentProvider;
}

export function defaultPaymentOrderDeps(): PaymentOrderServiceDeps {
  return {
    prisma: getPrismaClient(),
    clock: systemClock,
    // Constructed lazily, so a repository with no Razorpay credentials still
    // imports this module, builds, and runs every deterministic test.
    provider: createRazorpayProvider(),
  };
}

/**
 * What a caller may say.
 *
 * One internal identifier, and an optional correlation id for tracing. There is
 * deliberately no amount, no currency, no quote id, no reservation quantity and
 * no provider order id: a browser that could name any of those could name a
 * cheaper one.
 *
 * `operationId` is explicitly *not* the idempotency identity. If it were, two
 * requests for the same transaction carrying different operation ids would each
 * be entitled to their own provider order - which is exactly the duplicate this
 * service exists to prevent. The claim key is derived server-side from the
 * transaction and its quote, so convergence does not depend on a caller
 * choosing the same string twice.
 */
export interface CreatePaymentOrderCommand {
  readonly transactionId: string;
  readonly operationId?: string;
  /**
   * Present only when the deterministic retry gate granted this call.
   *
   * It is not a flag a caller may set to unlock a shortcut - it changes which
   * *stricter* checks run, not which are skipped. With it the accepted starting
   * state becomes PAYMENT_FAILED instead of INVENTORY_RESERVED, the policy
   * recheck is told to accept that state, the claim key gains the attempt
   * number so a new attempt row is created rather than converging on the failed
   * one, and the lifecycle move becomes PAYMENT_RETRY_REQUESTED so the history
   * says a retry happened.
   *
   * The HTTP boundary cannot produce one. Both payment routes parse with
   * `z.strictObject`, so a request carrying `retry` is a 400 rather than a
   * field that is quietly honoured; the only constructor is
   * `@/services/payment/retry-service`, which builds it from persisted rows
   * after the gate has passed.
   */
  readonly retry?: RetryAuthorization;
}

/**
 * Proof that the retry gate ran, and the one fact the payment path needs from it.
 *
 * Deliberately carries no amount, no currency and no quote id. Everything
 * financial is still re-read from the persisted quote inside
 * `checkPreconditions`, so even a wrong value here could not change what is
 * charged - it could only change which claim key is used, and the unique index
 * decides that.
 */
export interface RetryAuthorization {
  /** The attempt number this retry is claiming. Always at least 2. */
  readonly attemptNumber: number;
}

class PaymentOrderRefusedError extends Error {
  readonly refusal: PaymentOrderRefusal;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly reasons: readonly QuoteInvalidationReason[];

  constructor(options: {
    readonly refusal: PaymentOrderRefusal;
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
    readonly reasons?: readonly QuoteInvalidationReason[];
  }) {
    super(`Payment order refused: ${options.refusal}`);
    this.refusal = options.refusal;
    this.detail = options.detail ?? {};
    this.reasons = options.reasons ?? [];
  }
}

/**
 * Creates the payment order for an authorized, stock-holding transaction.
 *
 * Reads as one sequence, and that sequence is the safety argument: preconditions,
 * then claim, then the single external call, then one atomic local commit.
 */
export async function createPaymentOrder(
  command: CreatePaymentOrderCommand,
  deps: PaymentOrderServiceDeps = defaultPaymentOrderDeps(),
): Promise<PaymentOrderResult> {
  const { transactionId, retry } = command;
  const now = deps.clock.now();

  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true, correlationId: true },
  });
  if (transaction === null) {
    return refused(transactionId, { refusal: "TRANSACTION_NOT_FOUND" });
  }

  // The state a payment order may be created from. An ordinary first order
  // starts from the stock hold. A retry starts from the failure it is
  // retrying - or, when its own quote had gone stale, from AUTHORIZED: the
  // retry-service re-quotes and re-runs policy before calling here, which is
  // what lands the transaction back at AUTHORIZED with its *original* hold
  // still ACTIVE and already rebound to the fresh quote (see
  // `src/domain/transaction/transitions.ts`, the `AUTHORIZED` block). Either
  // starting state is only ever paired with `retry` by
  // `@/services/payment/retry-service`, never by an ordinary first order.
  const requiredState =
    retry === undefined
      ? "INVENTORY_RESERVED"
      : transaction.status === "AUTHORIZED"
        ? "AUTHORIZED"
        : "PAYMENT_FAILED";

  // --- An order this transaction already has. ------------------------------
  //
  // Checked before the state gate, not after: a transaction that has moved to
  // PAYMENT_ORDER_CREATED fails the "must be INVENTORY_RESERVED" test, and
  // answering a retry with "wrong state" would be true but useless. A repeated
  // logical request should converge on the order it already made.
  if (transaction.status !== requiredState) {
    if (ORDER_REPLAYABLE_STATES.includes(transaction.status)) {
      const settled = await findSettledOrder(deps.prisma, transactionId);
      if (settled !== null) {
        return {
          kind: "ORDER_CREATED",
          transactionId,
          quoteId: settled.quoteId,
          order: settled.order,
          transactionState: transaction.status,
          replayed: true,
        };
      }
    }
    return refused(transactionId, {
      refusal: "TRANSACTION_STATE_INVALID",
      detail: { state: transaction.status },
    });
  }

  try {
    const context = await checkPreconditions(
      deps,
      transactionId,
      transaction.correlationId,
      now,
      requiredState,
      retry !== undefined,
    );

    // --- The durable claim. Still no provider call. ------------------------
    const claim = await claimPaymentAttempt(deps.prisma, {
      transactionId,
      quoteId: context.quoteId,
      amountMinor: context.amountMinor,
      currency: context.currency,
      now,
      ...(retry === undefined ? {} : { retryAttemptNumber: retry.attemptNumber }),
    });
    const attempt = claim.attempt;
    const receipt = attempt.receipt ?? deriveReceipt(attempt.id);

    // An order created by an earlier run whose local finalization did not
    // finish. Nothing external is needed; finish the local half.
    if (attempt.providerOrderId !== null) {
      return finalize(deps, context, attempt, {
        providerOrderId: attempt.providerOrderId,
        amountMinor: context.amountMinor,
        currency: context.currency,
        receipt,
        status: "created",
      });
    }

    // --- What an existing claim without an order actually means. -----------
    //
    // "The row is already there" is not one situation but three, and the
    // difference decides whether a provider call is safe. The attempt's own
    // status is what tells them apart, which is why the unresolved outcome was
    // given a status of its own rather than being inferred from null columns.
    if (!claim.owned && attempt.status === "CREATED") {
      // Creation may be in flight in another request right now. A *read* is
      // always safe, and it resolves both the ordinary race and the case where
      // the owning process created the order but died before recording it.
      const lookup = await deps.provider.findOrderByReceipt(receipt);
      if (lookup.kind === "FOUND") {
        return finalize(deps, context, attempt, lookup.order);
      }

      // Only a definitive NOT_FOUND, on a claim old enough that no live request
      // could still be holding it, permits this call to create. Anything else
      // waits: an inconclusive lookup tells us nothing, and a fresh claim
      // belongs to somebody who is probably mid-flight.
      const heldForMs = now.getTime() - attempt.createdAt.getTime();
      if (lookup.kind !== "NOT_FOUND" || heldForMs < CLAIM_LEASE_MS) {
        return {
          kind: "CREATION_IN_PROGRESS",
          transactionId,
          paymentAttemptId: attempt.id,
        };
      }
      // The claim is abandoned and no order exists for its receipt. Falling
      // through is safe, and it is the only thing that unwedges a transaction
      // whose original request died.
    }

    if (attempt.status === "RECONCILIATION_REQUIRED") {
      // An earlier call lost its answer. Read before doing anything else: the
      // whole point of a stable receipt is that this question has an answer.
      const lookup = await deps.provider.findOrderByReceipt(receipt);
      if (lookup.kind === "FOUND") {
        return finalize(deps, context, attempt, lookup.order);
      }
      if (lookup.kind !== "NOT_FOUND") {
        // Still unresolved. Creating now could duplicate; say so instead.
        return {
          kind: "RECONCILIATION_REQUIRED",
          transactionId,
          paymentAttemptId: attempt.id,
          receipt,
          reason: lookup.failure.category,
        };
      }
      // NOT_FOUND is authoritative: no order carries this receipt, so the
      // earlier ambiguity is settled and creating one is safe.
    }

    // A previously FAILED attempt falls through to a fresh create. That is not
    // a blind retry of an ambiguous outcome: a definite failure created
    // nothing, and the receipt is unchanged, so even a wrong judgement here is
    // caught by Razorpay's own receipt idempotency rather than by luck.

    // --- The external side effect. Exactly one call, exactly once. ----------
    const outcome = await deps.provider.createOrder({
      amountMinor: context.amountMinor,
      currency: context.currency,
      receipt,
      // Trusted internal references only. No buyer identity, no prices beyond
      // the one already in `amount`, and nothing a model produced.
      notes: {
        transactionId,
        quoteId: context.quoteId,
        reservationId: context.reservationId,
      },
    });

    switch (outcome.kind) {
      case "CREATED":
      case "ALREADY_EXISTS":
        return finalize(deps, context, attempt, outcome.order);
      case "FAILED":
        return recordDefiniteFailure(deps, context, attempt, receipt, outcome.failure);
      case "UNKNOWN":
        return parkForReconciliation(deps, context, attempt, receipt, null, {
          category: outcome.failure.category,
          code: outcome.failure.code,
        });
    }
  } catch (error) {
    if (error instanceof PaymentOrderRefusedError) {
      await auditRefusal(deps, transaction.correlationId, transactionId, error);
      return refused(transactionId, error);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

interface OrderContext {
  readonly transactionId: string;
  readonly correlationId: string | null;
  readonly quoteId: string;
  readonly reservationId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly policyVersion: number | null;
  readonly policyDecision: string;
  readonly approvalId: string | null;
  /** Decides which lifecycle event finalization emits. Set by the caller, not inferred. */
  readonly isRetry: boolean;
}

/**
 * Everything that must be true before Razorpay is contacted.
 *
 * Ordered from cheapest and most fundamental to most expensive, and each one
 * throws rather than returning, so there is no path through this function that
 * reaches the provider with a check skipped. The final policy recheck is last
 * because it is the closest thing to the side effect: the smaller the gap
 * between "policy says yes" and "the order is created", the smaller the window
 * in which a buyer's revised policy can be ignored.
 */
async function checkPreconditions(
  deps: PaymentOrderServiceDeps,
  transactionId: string,
  correlationId: string | null,
  now: Date,
  /**
   * The state this order is being created from.
   *
   * Threaded through rather than defaulted because it is also what the
   * authorization recheck is told to accept. A retry that quietly let the
   * recheck keep accepting INVENTORY_RESERVED would refuse every retry with
   * TRANSACTION_NOT_AUTHORIZED - fail-closed, but for the wrong reason and
   * indistinguishable from a genuine policy refusal.
   */
  requiredState: TransactionState,
  /**
   * Whether the caller supplied a `RetryAuthorization` at all.
   *
   * Not derived from `requiredState` any more: a requoted retry's
   * `requiredState` reads AUTHORIZED, the same value an ordinary first order
   * would never carry `retry` alongside, so the two can only be told apart by
   * what the caller actually passed. This is what `finalize()` uses to choose
   * between `PAYMENT_ORDER_CREATED` and `PAYMENT_RETRY_REQUESTED` - a
   * requoted retry must still record that a retry happened, not a first order.
   */
  isRetry: boolean,
): Promise<OrderContext> {
  // --- The trusted quote, re-validated at the moment of use. ---------------
  const quote = await readActiveQuote(deps.prisma, transactionId, now);
  if (quote === null) {
    throw new PaymentOrderRefusedError({ refusal: "NO_ACTIVE_QUOTE" });
  }
  if (quote.usability.kind !== "VALID") {
    throw new PaymentOrderRefusedError({
      refusal: "QUOTE_NOT_USABLE",
      detail: { usability: quote.usability.kind },
      reasons: quote.usability.kind === "INVALIDATED" ? quote.usability.reasons : [],
    });
  }
  const snapshot = quote.snapshot;

  // --- The stock hold. ------------------------------------------------------
  //
  // Loaded server-side and matched field by field. A reservation that names a
  // different quote, product or quantity is not this purchase's reservation,
  // and paying against it would charge for units nobody set aside.
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
  if (reservation === null) {
    throw new PaymentOrderRefusedError({ refusal: "NO_ACTIVE_RESERVATION" });
  }
  if (
    reservation.purchaseQuoteId !== snapshot.quoteId ||
    reservation.productId !== snapshot.productId ||
    reservation.quantity !== snapshot.quantity
  ) {
    throw new PaymentOrderRefusedError({
      refusal: "RESERVATION_MISMATCH",
      detail: {
        reservationQuoteId: reservation.purchaseQuoteId,
        activeQuoteId: snapshot.quoteId,
        reservedQuantity: reservation.quantity,
        quotedQuantity: snapshot.quantity,
      },
    });
  }
  if (reservation.expiresAt.getTime() <= now.getTime()) {
    // A lapsed hold no longer protects anyone. Charging against it is how a
    // system sells the same unit twice.
    throw new PaymentOrderRefusedError({
      refusal: "RESERVATION_EXPIRED",
      detail: { expiresAt: reservation.expiresAt.toISOString() },
    });
  }

  // --- Authorization, re-derived rather than assumed. -----------------------
  //
  // `status = INVENTORY_RESERVED` is only reachable from AUTHORIZED, so the
  // state is already evidence that authority once existed. That is not the
  // question being asked here. The question is whether it still holds *now*,
  // against today's policy version and today's price - and a person's approval
  // is allowed to answer it, provided the approval names this exact quote,
  // amount, currency and policy version.
  const recheck = await recheckPolicyAuthorization(
    transactionId,
    { prisma: deps.prisma, clock: deps.clock },
    { acceptedStates: [requiredState], approvalMaySatisfy: true },
  );
  if (recheck.kind !== "AUTHORIZED") {
    throw new PaymentOrderRefusedError({
      refusal: "NOT_AUTHORIZED",
      detail: { recheck: recheck.refusal, ...flattenDetail(recheck.detail) },
    });
  }
  if (recheck.quoteId !== snapshot.quoteId) {
    // Defensive: the recheck reads the active quote independently, so a
    // divergence means the row moved between two reads. Refuse rather than
    // pick one.
    throw new PaymentOrderRefusedError({
      refusal: "NOT_AUTHORIZED",
      detail: { recheck: "QUOTE_CHANGED_SINCE_AUTHORIZATION" },
    });
  }

  // --- The amount, judged one last time before it leaves the process. -------
  const payable = assessPayableAmount(snapshot.totalAmountMinor, snapshot.currency);
  if (payable.kind !== "PAYABLE") {
    throw new PaymentOrderRefusedError({
      refusal: "AMOUNT_NOT_PAYABLE",
      detail: { reason: payable.refusal },
    });
  }

  return {
    transactionId,
    correlationId,
    quoteId: snapshot.quoteId,
    reservationId: reservation.id,
    productId: snapshot.productId,
    quantity: snapshot.quantity,
    // Straight from the persisted quote. Never a request field, never a
    // model's number, never the display price the agent saw.
    amountMinor: snapshot.totalAmountMinor,
    currency: snapshot.currency,
    policyVersion: recheck.policyVersion,
    policyDecision: recheck.decision.decision,
    approvalId: recheck.satisfiedByApprovalId,
    isRetry,
  };
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

interface Claim {
  readonly attempt: PaymentAttempt;
  /** True when this call inserted the row and therefore owns provider creation. */
  readonly owned: boolean;
}

/**
 * Wins, or loses, the right to call the provider.
 *
 * The whole mechanism is one unique index. `idempotencyKey` is derived from the
 * transaction and its quote - never from anything the caller sends - so two
 * concurrent requests compute the same string, both attempt the insert, and
 * PostgreSQL decides. The loser reads the winner's row and returns it with
 * `owned: false`.
 *
 * This is durable in a way an in-process lock is not: it survives a second
 * server process, a restart, and a request handled on another machine, because
 * the arbiter is the database everyone already shares.
 */
async function claimPaymentAttempt(
  prisma: PrismaClient,
  input: {
    readonly transactionId: string;
    readonly quoteId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    /**
     * Stamped from the injected clock, not the database default, so the lease
     * above is measured against the same clock that reads it. Mixing an
     * injected clock with a server-side `now()` would make the lease mean
     * different things in tests and in production.
     */
    readonly now: Date;
    /**
     * Set on a retry, and it is what makes the claim a *new* one.
     *
     * Without it the key is a function of the transaction and its quote alone -
     * which is exactly right for a first order, because two concurrent requests
     * for the same purchase must converge. A retry reuses the same quote by
     * design, so that same key would converge on the attempt that already
     * failed and hand its dead provider order back as if it were live. Adding
     * the attempt number makes each retry cycle its own claim while keeping
     * concurrency safety within the cycle: two simultaneous retries compute the
     * same number from the same rows, so they still race for one key and
     * PostgreSQL still picks one winner.
     */
    readonly retryAttemptNumber?: number;
  },
): Promise<Claim> {
  const base = `payment_order:${input.transactionId}:${input.quoteId}`;
  const idempotencyKey =
    input.retryAttemptNumber === undefined
      ? base
      : `${base}:retry${String(input.retryAttemptNumber)}`;

  try {
    const attempt = await prisma.$transaction(async (tx) => {
      const last = await tx.paymentAttempt.findFirst({
        where: { transactionId: input.transactionId },
        orderBy: { attemptNumber: "desc" },
        select: { attemptNumber: true },
      });
      const created = await tx.paymentAttempt.create({
        data: {
          transactionId: input.transactionId,
          attemptNumber: (last?.attemptNumber ?? 0) + 1,
          amount: input.amountMinor,
          currency: input.currency,
          provider: "RAZORPAY",
          status: "CREATED",
          idempotencyKey,
          createdAt: input.now,
        },
        select: { id: true },
      });
      // The receipt is a function of the id, so it cannot be computed until the
      // row exists. Written back in the same transaction, so an attempt without
      // its receipt is never visible to anyone.
      return await tx.paymentAttempt.update({
        where: { id: created.id },
        data: { receipt: deriveReceipt(created.id) },
      });
    });
    return { attempt, owned: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw new InfrastructureError({
        code: "PAYMENT_ATTEMPT_CLAIM_FAILED",
        message: "The payment attempt claim could not be written.",
        publicMessage: "We could not start this payment. Please try again.",
        cause: error,
      });
    }
    const existing = await prisma.paymentAttempt.findUnique({
      where: { idempotencyKey },
    });
    if (existing === null) {
      // The violation was not ours to converge on - an attemptNumber race
      // against a different quote. Surfaced rather than retried silently.
      throw new InfrastructureError({
        code: "PAYMENT_ATTEMPT_CLAIM_CONFLICT",
        message: "A conflicting payment attempt exists for this transaction.",
        publicMessage: "We could not start this payment. Please try again.",
        cause: error,
      });
    }
    return { attempt: existing, owned: false };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === UNIQUE_VIOLATION
  );
}

// ---------------------------------------------------------------------------
// Local finalization
// ---------------------------------------------------------------------------

/**
 * Records a confirmed provider order, atomically.
 *
 * The provider reference, the audit event and the lifecycle transition are one
 * PostgreSQL commit. That is what makes the two forbidden half-states
 * impossible: a transaction at PAYMENT_ORDER_CREATED with no stored order id,
 * and a stored order id with no transition or audit record explaining it.
 *
 * The audit write comes before the transition so the trail reads in causal
 * order - the decision, then the move it caused - which is the ordering the
 * timeline reader in the audit service is built around.
 *
 * If this commit fails, the provider order still exists. That is not something
 * a rollback can fix and this function does not pretend otherwise: the failure
 * is caught and the attempt is parked for reconciliation *with the order id
 * preserved*, so the reference survives the failure that lost it.
 */
async function finalize(
  deps: PaymentOrderServiceDeps,
  context: OrderContext,
  attempt: PaymentAttempt,
  order: ProviderOrder,
): Promise<PaymentOrderResult> {
  const receipt = attempt.receipt ?? deriveReceipt(attempt.id);

  // Fail closed before anything is written. A blank provider reference would
  // otherwise become a transaction at PAYMENT_ORDER_CREATED with nothing to
  // reconcile against, which is the one outcome this objective forbids.
  if (order.providerOrderId.length === 0) {
    return parkForReconciliation(deps, context, attempt, receipt, null, {
      category: "UNREADABLE_RESPONSE",
      code: "PROVIDER_ORDER_ID_MISSING",
    });
  }
  // The provider echoing back a different amount than we sent is not a
  // situation to record and move on from.
  if (order.amountMinor !== context.amountMinor) {
    log.error("provider order amount does not match the trusted quote", {
      transactionId: context.transactionId,
      providerOrderId: order.providerOrderId,
    });
    return parkForReconciliation(deps, context, attempt, receipt, order.providerOrderId, {
      category: "UNREADABLE_RESPONSE",
      code: "PROVIDER_AMOUNT_MISMATCH",
    });
  }

  try {
    const state = await deps.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          providerOrderId: order.providerOrderId,
          status: "CREATED",
          failureCode: null,
          failureReason: null,
        },
      });

      await recordAuditEvent(tx, {
        transactionId: context.transactionId,
        action: AUDIT_ACTION,
        actor: PAYMENT_ACTOR,
        result: "SUCCESS",
        reasonCode: "PAYMENT_ORDER_CREATED",
        correlationId: context.correlationId,
        operationKey: `payment_order:${attempt.id}`,
        trustedInputs: auditFacts(context, attempt, {
          receipt,
          providerOrderId: order.providerOrderId,
          providerStatus: order.status,
        }),
      });

      const outcome = await applyTransactionEventWithin(tx, {
        transactionId: context.transactionId,
        // A retry says so in the history. Both edges land at
        // PAYMENT_ORDER_CREATED, but only one of them records that a person
        // asked to pay again - and a lifecycle that replayed the original event
        // would make a retried purchase indistinguishable from a first attempt.
        event: context.isRetry ? "PAYMENT_RETRY_REQUESTED" : "PAYMENT_ORDER_CREATED",
        actor: context.isRetry ? RETRY_ACTOR : PAYMENT_ACTOR,
        idempotencyKey: `payment_order:${attempt.id}`,
        details: {
          paymentAttemptId: attempt.id,
          providerOrderId: order.providerOrderId,
          quoteId: context.quoteId,
          reservationId: context.reservationId,
        },
      });
      return outcome.kind === "APPLIED" ? outcome.to : outcome.currentState;
    });

    return {
      kind: "ORDER_CREATED",
      transactionId: context.transactionId,
      quoteId: context.quoteId,
      order: {
        paymentAttemptId: attempt.id,
        providerOrderId: order.providerOrderId,
        receipt,
        provider: "RAZORPAY",
        amount: toMoneyDto(moneyFromBigInt(context.amountMinor, context.currency)),
        providerStatus: order.status,
      },
      transactionState: state,
      replayed: attempt.providerOrderId !== null,
    };
  } catch (error) {
    // Before calling this unresolved, find out whether it actually is.
    //
    // Two requests can legitimately reach this function for the same attempt:
    // one creates the order, the other's receipt lookup finds it in the window
    // before the first commits. Both then run this transaction, and the loser
    // is rejected by the state machine's concurrency guard. That rejection
    // means *somebody else already finished this*, which is the convergence the
    // claim exists to produce - not a lost provider response.
    //
    // Treating it as ambiguous was actively destructive: it overwrote a healthy
    // attempt with RECONCILIATION_REQUIRED, stamped a failure code on an order
    // that had succeeded, and wrote a PENDING audit record for something
    // already audited as SUCCESS.
    const converged = await readFinalizedAttempt(deps, attempt.id);
    if (converged !== null) {
      return converged;
    }

    // The order exists at the provider; the local record of it does not. This
    // is precisely the window the objective is about, and the answer is never
    // to create another order.
    log.error("local finalization failed after a confirmed provider order", {
      transactionId: context.transactionId,
      paymentAttemptId: attempt.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return parkForReconciliation(deps, context, attempt, receipt, order.providerOrderId, {
      category: "UNREADABLE_RESPONSE",
      code: "LOCAL_FINALIZATION_FAILED",
    });
  }
}

/**
 * Reports a finalization that another caller already committed, if there is one.
 *
 * The test is precise because finalization is atomic: the provider reference,
 * the audit record and the state transition commit together. So an attempt
 * carrying a provider order id *and* still at CREATED can only have got that
 * way through a successful `finalize` - `parkForReconciliation` leaves
 * RECONCILIATION_REQUIRED and `recordDefiniteFailure` leaves FAILED, so neither
 * can be mistaken for success.
 *
 * Returns null when nothing is recorded, when the row says something else, or
 * when the read itself fails - all of which fall through to the ambiguous path,
 * which is the fail-closed direction.
 */
async function readFinalizedAttempt(
  deps: PaymentOrderServiceDeps,
  paymentAttemptId: string,
): Promise<PaymentOrderResult | null> {
  try {
    const row = await deps.prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      include: { transaction: { select: { status: true } } },
    });
    if (
      row === null ||
      row.providerOrderId === null ||
      row.receipt === null ||
      row.status !== "CREATED"
    ) {
      return null;
    }
    const quoteId = quoteIdFromClaimKey(row.idempotencyKey);
    if (quoteId === null) return null;
    return {
      kind: "ORDER_CREATED",
      transactionId: row.transactionId,
      quoteId,
      order: {
        paymentAttemptId: row.id,
        providerOrderId: row.providerOrderId,
        receipt: row.receipt,
        provider: "RAZORPAY",
        amount: toMoneyDto(moneyFromBigInt(row.amount, row.currency as CurrencyCode)),
        providerStatus: "created",
      },
      transactionState: row.transaction.status,
      replayed: true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The two non-success endings
// ---------------------------------------------------------------------------

/**
 * A failure the provider is known to have made before creating anything.
 *
 * The attempt is marked FAILED and the transaction is deliberately left where
 * it was - INVENTORY_RESERVED for a first order, PAYMENT_FAILED for a retry.
 * Two things follow from that, both intentional:
 *
 *  - **The stock hold is kept.** A transient provider failure is not a reason
 *    to give a buyer's reserved unit away; the reservation has its own expiry
 *    and will lapse on its own if nobody comes back.
 *  - **No lifecycle event is emitted.** A provider that would not create an
 *    order has not failed a payment - no payment was ever attempted - so
 *    recording PAYMENT_FAILED here would consume one of the buyer's bounded
 *    attempts for something that never reached a payment form. The retry gate
 *    in @/services/payment/retry-service owns that decision, and it counts
 *    attempt rows, which this path does create; that is the honest accounting,
 *    because a provider order really was claimed.
 */
async function recordDefiniteFailure(
  deps: PaymentOrderServiceDeps,
  context: OrderContext,
  attempt: PaymentAttempt,
  receipt: string,
  failure: ProviderFailure,
): Promise<PaymentOrderResult> {
  try {
    await deps.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "FAILED",
          failureCode: failure.category,
          // A mapped sentence, never the provider's own message.
          failureReason: `The payment provider did not create an order (${failure.code}).`,
        },
      });
      await recordAuditEvent(tx, {
        transactionId: context.transactionId,
        action: AUDIT_ACTION,
        actor: PAYMENT_ACTOR,
        result: "FAILURE",
        reasonCode: failure.category,
        correlationId: context.correlationId,
        // Deliberately no operation key. A key derived from the attempt would
        // be identical across every failure this attempt ever suffers, and a
        // FAILED attempt is explicitly allowed to be retried into a fresh
        // create - so the second failure would converge on the first record and
        // never be audited at all. Each provider call that failed is its own
        // event, and this write happens exactly once per such call.
        trustedInputs: auditFacts(context, attempt, {
          receipt,
          failureCode: failure.code,
        }),
      });
    });
  } catch (error) {
    // Best-effort, for the same reason as parking: the provider has definitely
    // created nothing, so the caller's answer is already known and must not be
    // replaced by an infrastructure error that hides it.
    //
    // The attempt stays at CREATED when this fails, which used to wedge the
    // transaction permanently - every retry answered CREATION_IN_PROGRESS for a
    // claim nobody held. The claim lease is what now lets a later retry take it
    // over.
    log.error("could not record a definite payment order failure", {
      transactionId: context.transactionId,
      paymentAttemptId: attempt.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  return {
    kind: "PROVIDER_FAILED",
    transactionId: context.transactionId,
    paymentAttemptId: attempt.id,
    category: failure.category,
    failureCode: failure.code,
    retryable: isSafelyRetryable(failure.category),
  };
}

/**
 * Parks an attempt whose provider outcome is unresolved.
 *
 * `RECONCILIATION_REQUIRED` is a status rather than an absence so that finding
 * everything still awaiting the provider's word is a single indexed query. Any
 * provider order id we did learn is stored even here - especially here - since
 * an order whose id was lost is far harder to reconcile than one whose local
 * bookkeeping simply did not finish.
 *
 * The write is best-effort: if the database is the thing that is broken, this
 * update fails too. It is attempted anyway, and its failure is logged rather
 * than thrown, because returning RECONCILIATION_REQUIRED to the caller is more
 * useful than replacing it with an infrastructure error that hides what
 * happened at the provider.
 */
async function parkForReconciliation(
  deps: PaymentOrderServiceDeps,
  context: OrderContext,
  attempt: PaymentAttempt,
  receipt: string,
  providerOrderId: string | null,
  failure: { readonly category: string; readonly code: string },
): Promise<PaymentOrderResult> {
  try {
    await deps.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "RECONCILIATION_REQUIRED",
          failureCode: failure.code,
          failureReason:
            "The payment provider's outcome could not be confirmed. This attempt must be reconciled by receipt, never retried.",
          ...(providerOrderId === null ? {} : { providerOrderId }),
        },
      });
      await recordAuditEvent(tx, {
        transactionId: context.transactionId,
        action: AUDIT_ACTION,
        actor: PAYMENT_ACTOR,
        // PENDING, not FAILURE: nothing has been decided, and calling it a
        // failure would invite exactly the retry that must not happen.
        result: "PENDING",
        reasonCode: "PROVIDER_OUTCOME_UNKNOWN",
        correlationId: context.correlationId,
        // No operation key, for the same reason as the failure record above:
        // one attempt can end up unresolved more than once, and those are
        // distinct events about distinct provider calls. Collapsing them would
        // hide the later one entirely.
        trustedInputs: auditFacts(context, attempt, {
          receipt,
          failureCode: failure.code,
          ...(providerOrderId === null ? {} : { providerOrderId }),
        }),
      });
    });
  } catch (error) {
    log.error("could not park a payment attempt for reconciliation", {
      transactionId: context.transactionId,
      paymentAttemptId: attempt.id,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  return {
    kind: "RECONCILIATION_REQUIRED",
    transactionId: context.transactionId,
    paymentAttemptId: attempt.id,
    receipt,
    reason: failure.code,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The trusted facts every payment-order audit record carries. */
function auditFacts(
  context: OrderContext,
  attempt: PaymentAttempt,
  extra: JsonObject,
): JsonObject {
  return {
    paymentAttemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    quoteId: context.quoteId,
    reservationId: context.reservationId,
    amountMinor: context.amountMinor.toString(),
    currency: context.currency,
    provider: "RAZORPAY",
    policyVersion: context.policyVersion,
    policyDecision: context.policyDecision,
    ...(context.approvalId === null ? {} : { approvalId: context.approvalId }),
    ...extra,
  };
}

/**
 * Records that the server declined before contacting the provider.
 *
 * Written outside any business transaction because there is no business
 * transaction: nothing was changed, and the only thing worth persisting is that
 * a payment was asked for and refused. A failure to write it must not convert a
 * clean refusal into a server error, so it is logged and swallowed.
 */
async function auditRefusal(
  deps: PaymentOrderServiceDeps,
  correlationId: string | null,
  transactionId: string,
  error: PaymentOrderRefusedError,
): Promise<void> {
  try {
    await recordAuditEvent(deps.prisma, {
      transactionId,
      action: AUDIT_ACTION,
      actor: PAYMENT_ACTOR,
      result: "BLOCKED",
      reasonCode: error.refusal,
      correlationId,
      trustedInputs: { refusal: error.refusal, provider: "RAZORPAY" },
    });
  } catch (auditError) {
    log.error("could not record a payment order refusal", {
      transactionId,
      refusal: error.refusal,
      reason: auditError instanceof Error ? auditError.name : "unknown",
    });
  }
}

/** The most recent attempt that actually holds a provider order. */
async function findSettledOrder(
  prisma: TransactionCapableClient,
  transactionId: string,
): Promise<{ readonly quoteId: string; readonly order: PaymentOrderDto } | null> {
  const attempt = await prisma.paymentAttempt.findFirst({
    where: { transactionId, providerOrderId: { not: null } },
    orderBy: { attemptNumber: "desc" },
  });
  if (attempt === null || attempt.providerOrderId === null || attempt.receipt === null) {
    return null;
  }

  // Read off the claim key rather than guessed at. The idempotency key is
  // `payment_order:<transactionId>:<quoteId>`, so the quote this order was
  // actually created for is recorded rather than inferred - "the transaction's
  // most recent quote" is usually the same row, and a financial record should
  // not rest on "usually".
  const quoteId = quoteIdFromClaimKey(attempt.idempotencyKey);
  if (quoteId === null) return null;

  return {
    quoteId,
    order: {
      paymentAttemptId: attempt.id,
      providerOrderId: attempt.providerOrderId,
      receipt: attempt.receipt,
      provider: "RAZORPAY",
      amount: toMoneyDto(
        moneyFromBigInt(attempt.amount, attempt.currency as CurrencyCode),
      ),
      providerStatus: "created",
    },
  };
}

/**
 * Recovers the quote id from a claim key.
 *
 * Two shapes, and the quote is in the same position in both:
 *
 *     payment_order:<transactionId>:<quoteId>
 *     payment_order:<transactionId>:<quoteId>:retry<n>
 *
 * The retry suffix is matched exactly rather than merely tolerated. Accepting
 * any fourth segment would let a malformed key parse successfully and report a
 * quote id nobody wrote, which is worse than reporting none: this value decides
 * which quote an existing order is attributed to.
 */
function quoteIdFromClaimKey(idempotencyKey: string | null): string | null {
  if (idempotencyKey === null) return null;
  const parts = idempotencyKey.split(":");
  // Neither a UUID nor the prefix contains a colon, so the segments are exact.
  if (parts[0] !== "payment_order") return null;
  if (parts.length === 4 && !/^retry[1-9]\d*$/.test(parts[3] ?? "")) return null;
  if (parts.length !== 3 && parts.length !== 4) return null;
  const quoteId = parts[2];
  return quoteId === undefined || quoteId.length === 0 ? null : quoteId;
}

function refused(
  transactionId: string,
  error: {
    readonly refusal: PaymentOrderRefusal;
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
    readonly reasons?: readonly QuoteInvalidationReason[];
  },
): PaymentOrderResult {
  return {
    kind: "REFUSED",
    transactionId,
    refusal: error.refusal,
    detail: error.detail ?? {},
    reasons: error.reasons ?? [],
  };
}

/** Flattens the recheck's structured detail into scalar fields safe to report. */
function flattenDetail(
  detail: JsonObject,
): Readonly<Record<string, string | number | boolean | null>> {
  const flat: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      flat[key] = value;
    }
  }
  return flat;
}
