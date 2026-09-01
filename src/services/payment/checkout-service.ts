import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/persistence/client";
import { getRazorpayCredentials } from "@/config/env";
import { systemClock, type Clock } from "@/lib/clock";
import { createLogger } from "@/lib/logger";
import { applyTransactionEventWithin } from "@/services/transaction/transition-service";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { toMoneyDto, moneyFromBigInt, type CurrencyCode } from "@/domain/money";
import type {
  CallbackRejection,
  CheckoutCallbackClaim,
  CheckoutCallbackResult,
  CheckoutDismissalResult,
  CheckoutSessionDto,
  CheckoutStartRefusal,
  CheckoutStartResult,
} from "@/domain/payment/checkout";
import type { PaymentProvider } from "@/domain/payment/provider";
import type { TransactionState } from "@/domain/transaction/states";
import type { JsonObject } from "@/lib/json";
import type { PaymentAttempt, PrismaClient } from "@/generated/prisma/client";

/**
 * Checkout, and proving that what came back from it is real.
 *
 * This service sits either side of the one moment the system hands control to a
 * person and a third party. Two things happen here and nothing else does.
 *
 * **Starting checkout** issues the small set of values a payment form needs and
 * records that a human chose to pay. It is a POST rather than part of rendering
 * a page on purpose: `PAYMENT_PENDING` must mean "somebody pressed Pay", and a
 * state that could be reached by a crawler, a prefetch or a refresh would mean
 * nothing at all.
 *
 * **Verifying the callback** decides whether the browser is telling the truth.
 * Everything it posts is a claim. The server loads its own copy of the order
 * id, computes the HMAC over that, and compares in constant time. The client's
 * order id is never signed with - the provider's documentation is explicit
 * about this, and the reason is worth stating plainly: if the client supplied
 * both halves of the signed payload, an attacker could present a genuine
 * signature from an order they really did pay for against somebody else's
 * transaction, and it would verify perfectly.
 *
 * **What a verified signature means, and does not.** It proves the provider
 * produced this confirmation for this order. It does not prove funds moved. So
 * this service stops at `PAYMENT_VERIFIED`: it never reaches `PAYMENT_CAPTURED`
 * or `COMPLETED`, and it never commits inventory. Only the provider, speaking
 * for itself through a channel we authenticate separately, can say money was
 * captured - and that belongs to a later objective.
 */
assertServerOnly("src/services/payment/checkout-service.ts");

/**
 * The actor for both halves.
 *
 * Not `human_user`, even though a person pressed the button. The state machine's
 * actors describe which *component* is asserting the change, and in both cases
 * that is the payment integration acting on evidence - a checkout session it
 * issued, or a signature it verified. Attributing a verified callback to the
 * human would let the audit trail imply a person vouched for a cryptographic
 * check they never saw.
 */
const PAYMENT_ACTOR = "payment_provider" as const;

/** Bounds a provider payment reference so a malformed one is refused, not stored. */
const PROVIDER_PAYMENT_ID = /^[A-Za-z0-9_-]{6,128}$/;

const log = createLogger({ category: "payment" });

export interface CheckoutServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly provider: PaymentProvider;
  /** The provider's public key id, for the browser. Never the secret. */
  readonly providerKeyId: string;
}

export function defaultCheckoutDeps(): CheckoutServiceDeps {
  return {
    prisma: getPrismaClient(),
    clock: systemClock,
    provider: createRazorpayProvider(),
    // Read lazily, and only the public half is ever pulled out of the section.
    providerKeyId: getRazorpayCredentials().RAZORPAY_KEY_ID,
  };
}

export interface StartCheckoutCommand {
  readonly transactionId: string;
}

// ---------------------------------------------------------------------------
// Starting checkout
// ---------------------------------------------------------------------------

/**
 * Authorizes a checkout session for a transaction that already holds an order.
 *
 * Called only from the explicit "Pay" action. The reservation is re-checked
 * because sending a person to a payment form for stock the system no longer
 * holds is how a shop takes money it cannot honour - the hold has its own
 * expiry, and once it lapses the honest answer is to refuse rather than to
 * collect.
 */
export async function startCheckout(
  command: StartCheckoutCommand,
  deps: CheckoutServiceDeps = defaultCheckoutDeps(),
): Promise<CheckoutStartResult> {
  const { transactionId } = command;
  const now = deps.clock.now();

  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      status: true,
      correlationId: true,
      merchant: { select: { name: true } },
    },
  });
  if (transaction === null) {
    return startRefused(transactionId, "TRANSACTION_NOT_FOUND", {});
  }

  const started = transaction.status === "PAYMENT_PENDING";
  if (transaction.status !== "PAYMENT_ORDER_CREATED" && !started) {
    return startRefused(transactionId, "TRANSACTION_STATE_INVALID", {
      state: transaction.status,
    });
  }

  const attempt = await deps.prisma.paymentAttempt.findFirst({
    where: { transactionId, providerOrderId: { not: null }, status: "CREATED" },
    orderBy: { attemptNumber: "desc" },
  });
  if (attempt === null || attempt.providerOrderId === null) {
    return startRefused(transactionId, "NO_PAYMENT_ORDER", {});
  }

  // Stock, still held, still ours.
  const reservation = await deps.prisma.inventoryReservation.findFirst({
    where: { transactionId, status: "ACTIVE" },
    // The product comes from the reservation rather than from the transaction:
    // `Transaction.productId` is optional and only the agent flow sets it,
    // whereas a reservation always names the exact product whose stock is held.
    // It costs no extra round trip and it is the more authoritative source.
    select: {
      id: true,
      expiresAt: true,
      product: { select: { name: true } },
    },
  });
  if (reservation === null || reservation.expiresAt.getTime() <= now.getTime()) {
    return startRefused(transactionId, "RESERVATION_NOT_HELD", {
      held: reservation !== null,
    });
  }

  const session = toSession(
    attempt,
    attempt.providerOrderId,
    deps.providerKeyId,
    transaction.merchant.name,
    reservation.product.name,
  );

  // Already started. Re-issuing the same session is right - a person who
  // reloaded and pressed Pay again should get the same order - but the
  // lifecycle move happens once.
  if (started) {
    return {
      kind: "CHECKOUT_READY",
      session,
      transactionState: transaction.status,
      replayed: true,
    };
  }

  const state = await deps.prisma.$transaction(async (tx) => {
    await recordAuditEvent(tx, {
      transactionId,
      action: "payment_attempt_started",
      actor: PAYMENT_ACTOR,
      result: "SUCCESS",
      reasonCode: "PAYMENT_STARTED",
      correlationId: transaction.correlationId,
      operationKey: `checkout_started:${attempt.id}`,
      trustedInputs: {
        paymentAttemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        reservationId: reservation.id,
        providerOrderId: attempt.providerOrderId ?? "",
        amountMinor: attempt.amount.toString(),
        currency: attempt.currency,
        provider: "RAZORPAY",
      },
    });
    const outcome = await applyTransactionEventWithin(tx, {
      transactionId,
      event: "PAYMENT_STARTED",
      actor: PAYMENT_ACTOR,
      idempotencyKey: `checkout_started:${attempt.id}`,
      details: {
        paymentAttemptId: attempt.id,
        providerOrderId: attempt.providerOrderId ?? "",
      },
    });
    return outcome.kind === "APPLIED" ? outcome.to : outcome.currentState;
  });

  return { kind: "CHECKOUT_READY", session, transactionState: state, replayed: false };
}

// ---------------------------------------------------------------------------
// Verifying the callback
// ---------------------------------------------------------------------------

/**
 * Decides whether a checkout callback is authentic, and records it if so.
 *
 * The checks run in the order a sceptic would ask them, and every one of them
 * is answered from the database rather than from the request:
 *
 *  1. Does this transaction exist?
 *  2. Which payment attempt is this about, and does it belong here?
 *  3. Does the order id the client presented match the one we stored?
 *  4. Is the payment reference even well formed?
 *  5. Does the signature verify against **our** order id?
 *  6. Have we already verified this exact payment? (converge)
 *  7. Is a *different* payment already recorded against it? (refuse)
 *  8. Is the transaction still awaiting a payment result?
 *  9. Is this payment already bound to some other attempt?
 *
 * The ordering is load-bearing. Authentication comes before *everything* that
 * could produce a success answer, including convergence on an earlier result -
 * so an unauthenticated caller cannot learn anything by guessing, and the
 * answer to "is this payment already recorded?" is only ever given to someone
 * who has proved they hold the provider's signature for it.
 *
 * Only a callback that survives all nine is recorded, and it is recorded in
 * one transaction with the lifecycle move it justifies.
 */
export async function verifyCheckoutCallback(
  claim: CheckoutCallbackClaim,
  deps: CheckoutServiceDeps = defaultCheckoutDeps(),
): Promise<CheckoutCallbackResult> {
  const { transactionId } = claim;

  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, status: true, correlationId: true },
  });
  if (transaction === null) {
    return await reject(deps, null, transactionId, "TRANSACTION_NOT_FOUND", {}, claim);
  }

  const attempt = await loadAttempt(deps, claim);
  if (attempt === null) {
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      claim.paymentAttemptId === undefined ? "NO_PAYMENT_ORDER" : "ATTEMPT_MISMATCH",
      {},
      claim,
    );
  }
  const storedOrderId = attempt.providerOrderId;
  if (storedOrderId === null) {
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      "NO_PAYMENT_ORDER",
      { paymentAttemptId: attempt.id },
      claim,
    );
  }

  // --- The client's order id has no authority, but a mismatch is a signal. ---
  if (claim.presentedOrderId !== undefined && claim.presentedOrderId !== storedOrderId) {
    log.warn("checkout callback presented an order id we did not issue", {
      transactionId,
      paymentAttemptId: attempt.id,
    });
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      "ORDER_ID_MISMATCH",
      { paymentAttemptId: attempt.id },
      claim,
    );
  }

  if (!PROVIDER_PAYMENT_ID.test(claim.providerPaymentId)) {
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      "MALFORMED_PAYMENT_ID",
      { paymentAttemptId: attempt.id },
      claim,
    );
  }

  // --- The signature, over the order id WE stored. ---------------------------
  const authentic = deps.provider.verifyCheckoutSignature({
    serverStoredOrderId: storedOrderId,
    providerPaymentId: claim.providerPaymentId,
    signature: claim.signature,
  });
  if (!authentic) {
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      "INVALID_SIGNATURE",
      { paymentAttemptId: attempt.id },
      claim,
    );
  }

  // --- Only now: has this already been answered? -----------------------------
  //
  // Authenticity is established *before* convergence, deliberately. Checking
  // "have we seen this payment id?" first would have meant a caller who merely
  // knew a transaction id and a payment id could present any rubbish as a
  // signature and still be handed a PAYMENT_VERIFIED answer - no state change,
  // but a success response to a request that proved nothing. A callback that
  // cannot authenticate itself gets nothing, including confirmation.
  if (attempt.providerPaymentId !== null) {
    if (attempt.providerPaymentId === claim.providerPaymentId) {
      // The same callback again - browsers retry, and people refresh. Converge
      // on the verified result rather than recording it twice or failing on the
      // uniqueness constraint the first pass created.
      return verified(
        attempt,
        storedOrderId,
        attempt.providerPaymentId,
        transaction.status,
        true,
      );
    }
    // A different payment for an attempt that already has one. Two payments
    // cannot both be the payment for this order.
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      "CONFLICTING_PAYMENT",
      { paymentAttemptId: attempt.id },
      claim,
    );
  }

  if (transaction.status !== "PAYMENT_PENDING") {
    // Includes callbacks arriving after expiry. A late callback cannot
    // resurrect a transaction that has moved on - and note there is no cancel
    // edge out of PAYMENT_PENDING at all, so expiry is how this state ends
    // without a payment.
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      "TRANSACTION_STATE_INVALID",
      { state: transaction.status },
      claim,
    );
  }

  // --- One payment, one attempt. --------------------------------------------
  const boundElsewhere = await deps.prisma.paymentAttempt.findFirst({
    where: {
      provider: "RAZORPAY",
      providerPaymentId: claim.providerPaymentId,
      id: { not: attempt.id },
    },
    select: { id: true },
  });
  if (boundElsewhere !== null) {
    // A genuine signature for a payment that belongs to a different attempt.
    // The database's unique index would also stop this, but refusing here means
    // the answer is a controlled rejection rather than a constraint violation.
    return await reject(
      deps,
      transaction.correlationId,
      transactionId,
      "PAYMENT_ID_ALREADY_USED",
      { paymentAttemptId: attempt.id },
      claim,
    );
  }

  const state = await deps.prisma.$transaction(async (tx) => {
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { providerPaymentId: claim.providerPaymentId, status: "VERIFIED" },
    });
    await recordAuditEvent(tx, {
      transactionId,
      action: "payment_verified",
      actor: PAYMENT_ACTOR,
      result: "SUCCESS",
      reasonCode: "PAYMENT_SIGNATURE_VERIFIED",
      correlationId: transaction.correlationId,
      // Keyed on the payment as well as the attempt: a replay of this exact
      // callback converges, while a different payment would be a different
      // event rather than one silently swallowed by the first.
      operationKey: `payment_verified:${attempt.id}:${claim.providerPaymentId}`,
      trustedInputs: {
        paymentAttemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        providerOrderId: storedOrderId,
        providerPaymentId: claim.providerPaymentId,
        amountMinor: attempt.amount.toString(),
        currency: attempt.currency,
        provider: "RAZORPAY",
      },
    });
    const outcome = await applyTransactionEventWithin(tx, {
      transactionId,
      event: "PAYMENT_CALLBACK_VERIFIED",
      actor: PAYMENT_ACTOR,
      idempotencyKey: `payment_verified:${attempt.id}`,
      details: {
        paymentAttemptId: attempt.id,
        providerOrderId: storedOrderId,
        providerPaymentId: claim.providerPaymentId,
      },
    });
    return outcome.kind === "APPLIED" ? outcome.to : outcome.currentState;
  });

  return verified(attempt, storedOrderId, claim.providerPaymentId, state, false);
}

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

/**
 * Records that a person closed the payment window.
 *
 * Deliberately does almost nothing. No state moves, no payment id is invented,
 * and nothing is marked failed - the provider has not said a payment failed, it
 * has said nothing at all, and a browser event is not authority to write either
 * outcome. The stock hold is left alone to expire on its own clock.
 *
 * It is recorded rather than ignored because "the buyer reached checkout and
 * backed out" is a real fact about a transaction, and a trail that omits it
 * leaves an unexplained gap between an order and an expiry.
 */
export async function recordCheckoutDismissal(
  command: StartCheckoutCommand,
  deps: CheckoutServiceDeps = defaultCheckoutDeps(),
): Promise<CheckoutDismissalResult> {
  const transaction = await deps.prisma.transaction.findUnique({
    where: { id: command.transactionId },
    select: { id: true, status: true, correlationId: true },
  });
  if (transaction === null) {
    return {
      kind: "IGNORED",
      transactionId: command.transactionId,
      reason: "NO_SUCH_TRANSACTION",
    };
  }
  if (transaction.status !== "PAYMENT_PENDING") {
    // Nothing to say about a transaction that is not mid-checkout. In
    // particular a dismissal arriving after a verified payment must never
    // overwrite or contradict it.
    return {
      kind: "IGNORED",
      transactionId: command.transactionId,
      reason: transaction.status,
    };
  }

  const attempt = await deps.prisma.paymentAttempt.findFirst({
    where: { transactionId: command.transactionId, providerOrderId: { not: null } },
    orderBy: { attemptNumber: "desc" },
  });

  try {
    await recordAuditEvent(deps.prisma, {
      transactionId: command.transactionId,
      action: "payment_checkout_dismissed",
      actor: PAYMENT_ACTOR,
      result: "FAILURE",
      reasonCode: "CHECKOUT_DISMISSED",
      correlationId: transaction.correlationId,
      // Keyed on the attempt, so repeated closes of the same checkout session
      // converge on one record. "The buyer backed out of this payment" is a
      // single fact about a single session, and unlike a refused callback its
      // repetition carries no information - while this endpoint needs only a
      // transaction id, so without a key anyone could append rows to a
      // financial audit trail at will.
      operationKey: attempt === null ? null : `checkout_dismissed:${attempt.id}`,
      trustedInputs:
        attempt === null
          ? { provider: "RAZORPAY" }
          : {
              paymentAttemptId: attempt.id,
              providerOrderId: attempt.providerOrderId ?? "",
              amountMinor: attempt.amount.toString(),
              currency: attempt.currency,
              provider: "RAZORPAY",
            },
    });
  } catch (error) {
    log.error("could not record a checkout dismissal", {
      transactionId: command.transactionId,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  return {
    kind: "DISMISSAL_RECORDED",
    transactionId: command.transactionId,
    transactionState: transaction.status,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds the attempt a callback is about, refusing any that is not ours.
 *
 * When the client names an attempt it is looked up by id and then checked to
 * belong to the named transaction - so pointing a callback at another
 * transaction's attempt fails here rather than reaching the signature check.
 */
async function loadAttempt(
  deps: CheckoutServiceDeps,
  claim: CheckoutCallbackClaim,
): Promise<PaymentAttempt | null> {
  if (claim.paymentAttemptId !== undefined) {
    const named = await deps.prisma.paymentAttempt.findUnique({
      where: { id: claim.paymentAttemptId },
    });
    return named !== null && named.transactionId === claim.transactionId ? named : null;
  }
  return await deps.prisma.paymentAttempt.findFirst({
    where: { transactionId: claim.transactionId, providerOrderId: { not: null } },
    orderBy: { attemptNumber: "desc" },
  });
}

function toSession(
  attempt: PaymentAttempt,
  providerOrderId: string,
  providerKeyId: string,
  merchantName: string,
  productName: string,
): CheckoutSessionDto {
  return {
    transactionId: attempt.transactionId,
    paymentAttemptId: attempt.id,
    providerOrderId,
    provider: "RAZORPAY",
    providerKeyId,
    amount: toMoneyDto(moneyFromBigInt(attempt.amount, attempt.currency as CurrencyCode)),
    // Already minor units on the row; widened, never multiplied.
    amountMinor: Number(attempt.amount),
    currency: attempt.currency,
    merchantName,
    productName,
  };
}

/**
 * Builds the success answer.
 *
 * `providerPaymentId` is passed in rather than read off `attempt`, because on
 * the freshly-verified path that row was loaded *before* the update that stores
 * it - so reading it there reports an empty string for the payment that was
 * just accepted. The caller always knows the id; the stale row does not.
 */
function verified(
  attempt: PaymentAttempt,
  providerOrderId: string,
  providerPaymentId: string,
  transactionState: TransactionState,
  replayed: boolean,
): CheckoutCallbackResult {
  return {
    kind: "PAYMENT_VERIFIED",
    transactionId: attempt.transactionId,
    paymentAttemptId: attempt.id,
    providerOrderId,
    providerPaymentId,
    amount: toMoneyDto(moneyFromBigInt(attempt.amount, attempt.currency as CurrencyCode)),
    transactionState,
    replayed,
  };
}

function startRefused(
  transactionId: string,
  refusal: CheckoutStartRefusal,
  detail: Readonly<Record<string, string | number | boolean | null>>,
): CheckoutStartResult {
  return { kind: "REFUSED", transactionId, refusal, detail };
}

/**
 * How many refused callbacks are recorded per transaction before the trail
 * stops growing.
 *
 * Refusals deliberately carry no operation key - each one is its own security
 * event, and collapsing them would hide exactly the pattern (somebody trying
 * repeatedly) that makes them worth recording. But this endpoint needs only a
 * transaction id, so "one request, one permanent row" is also an amplification:
 * an unauthenticated caller could flood the audit table with a loop.
 *
 * A cap resolves both. The first few dozen attempts are recorded individually,
 * which is far more than an investigator needs to see a pattern; beyond that the
 * event is logged for operators instead. Nothing already written is ever
 * removed or overwritten.
 */
const MAX_RECORDED_REJECTIONS_PER_TRANSACTION = 25;

/**
 * Refuses a callback and leaves a record of it.
 *
 * The record never contains a signature, expected or received.
 */
async function reject(
  deps: CheckoutServiceDeps,
  correlationId: string | null,
  transactionId: string,
  rejection: CallbackRejection,
  detail: Readonly<Record<string, string | number | boolean | null>>,
  claim: CheckoutCallbackClaim,
): Promise<CheckoutCallbackResult> {
  const trustedInputs: JsonObject = {
    provider: "RAZORPAY",
    refusal: rejection,
    ...(typeof detail["paymentAttemptId"] === "string"
      ? { paymentAttemptId: detail["paymentAttemptId"] }
      : {}),
    // Recorded only when it is the thing that was wrong.
    ...(rejection === "ORDER_ID_MISMATCH" && claim.presentedOrderId !== undefined
      ? { presentedOrderId: claim.presentedOrderId }
      : {}),
  };

  try {
    const alreadyRecorded = await deps.prisma.auditEvent.count({
      where: { transactionId, eventType: "payment_callback_rejected" },
    });
    if (alreadyRecorded >= MAX_RECORDED_REJECTIONS_PER_TRANSACTION) {
      log.warn("further rejected payment callbacks are no longer being audited", {
        transactionId,
        rejection,
        alreadyRecorded,
      });
      return { kind: "REJECTED", transactionId, rejection, detail };
    }

    await recordAuditEvent(deps.prisma, {
      transactionId,
      action: "payment_callback_rejected",
      actor: PAYMENT_ACTOR,
      result: "BLOCKED",
      reasonCode: rejection,
      correlationId,
      trustedInputs,
    });
  } catch (error) {
    log.error("could not record a rejected payment callback", {
      transactionId,
      rejection,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }

  return { kind: "REJECTED", transactionId, rejection, detail };
}
