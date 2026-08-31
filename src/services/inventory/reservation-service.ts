import { assertServerOnly } from "@/lib/server-only";
import { getReservationConfig } from "@/config/env";
import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { readActiveQuote } from "@/services/quote/quote-reader";
import { applyTransactionEventWithin } from "@/services/transaction/transition-service";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { AppError, DomainRuleError, InfrastructureError } from "@/domain/errors";
import type {
  CommitResult,
  ReleaseResult,
  ReservationDto,
  ReservationRefusal,
  ReservationResult,
} from "@/domain/inventory/contracts";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";
import type { TransactionState } from "@/domain/transaction/states";
import type { AuditEventType } from "@/domain/audit-event";
import type { JsonObject } from "@/lib/json";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Holding stock without selling it.
 *
 * Between authorizing a purchase and taking the money there is a window - a
 * checkout page, a bank redirect, a person finding their card - and during that
 * window the last unit must belong to exactly one buyer. That is the whole job.
 *
 * **How overselling is actually prevented.** Not by reading stock and then
 * inserting a row: that pair has a gap, and under two simultaneous requests the
 * gap is where both succeed. Instead a single conditional UPDATE claims the
 * stock:
 *
 *     UPDATE product SET "reservedQuantity" = "reservedQuantity" + n
 *      WHERE id = ... AND "inventory" = <what we read> AND "reservedQuantity" <= <inventory - n>
 *
 * PostgreSQL takes a row lock for that statement and re-evaluates the WHERE
 * clause against the freshly committed row, so of two buyers racing for one
 * unit exactly one matches and the other updates nothing - a clean, reported
 * refusal rather than a second sale. Two CHECK constraints stand behind it, so
 * even a wrong version of this file cannot write more reserved stock than
 * exists.
 *
 * **Why not `SELECT … FOR UPDATE`.** It would be equally correct in principle,
 * but raw SQL naming a table resolves through `search_path`, which in this
 * project's isolated test schema points at `public` - so the lock would be
 * taken on the wrong row, silently. A conditional UPDATE through the ORM is
 * schema-correct everywhere and needs no raw SQL at all.
 */
assertServerOnly("src/services/inventory/reservation-service.ts");

/** The one actor permitted to claim or settle stock. */
const INVENTORY_ACTOR = "inventory_service" as const;

/**
 * The only transaction states that prove money actually moved.
 *
 * Committing a reservation permanently decrements real stock, so it is gated on
 * evidence rather than on a caller's assertion. Nothing in Objectives 1-8 can
 * put a transaction into either state, which is the point: the operation exists
 * for the payment workflow to call later and is unusable until that workflow
 * can honestly prove capture.
 */
const CAPTURED_STATES: readonly TransactionState[] = ["PAYMENT_CAPTURED", "COMPLETED"];

export interface ReservationServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  /** The checkout window, from configuration. Never a literal at a call site. */
  readonly ttlSeconds: number;
}

export function defaultReservationDeps(): ReservationServiceDeps {
  return {
    prisma: getPrismaClient(),
    clock: systemClock,
    ttlSeconds: getReservationConfig().RESERVATION_TTL_SECONDS,
  };
}

/** Raised inside the write transaction so a refusal rolls the whole claim back. */
class ReservationRefusedError extends DomainRuleError {
  readonly refusal: ReservationRefusal;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly reasons: readonly QuoteInvalidationReason[];

  constructor(options: {
    readonly refusal: ReservationRefusal;
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
    readonly reasons?: readonly QuoteInvalidationReason[];
  }) {
    super({
      code: `RESERVATION_${options.refusal}`,
      message: `Stock could not be reserved: ${options.refusal}`,
      publicMessage: "We could not hold this item for you.",
      details: { refusal: options.refusal },
      retryable: options.refusal === "INSUFFICIENT_STOCK",
    });
    this.refusal = options.refusal;
    this.detail = options.detail ?? {};
    this.reasons = options.reasons ?? [];
  }
}

class ReservationPersistenceError extends InfrastructureError {
  constructor(reason: string, cause?: unknown) {
    super({
      code: "RESERVATION_PERSISTENCE_FAILED",
      message: `The reservation could not be committed: ${reason}`,
      publicMessage: "We could not hold this item for you. Please try again.",
      details: { reason },
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export interface ReserveInventoryCommand {
  readonly transactionId: string;
  readonly operationId: string;
}

/**
 * Claims stock for an authorized transaction, and moves it to INVENTORY_RESERVED.
 *
 * Both of those, or neither. The availability check, the reservation row, the
 * lifecycle move and its history row are one PostgreSQL transaction, because
 * every partial outcome is a lie the database would then tell forever: a
 * transaction reading INVENTORY_RESERVED while holding no stock would send a
 * buyer to pay for a unit nobody set aside, and a reservation whose transaction
 * never moved would hold stock away from real buyers with nothing to release it.
 */
export async function reserveInventory(
  command: ReserveInventoryCommand,
  deps: ReservationServiceDeps = defaultReservationDeps(),
): Promise<ReservationResult> {
  const now = deps.clock.now();

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { id: command.transactionId },
        select: { id: true, status: true, correlationId: true },
      });

      if (transaction === null) {
        throw new ReservationRefusedError({
          refusal: "NOT_AUTHORIZED",
          detail: { state: "UNKNOWN" },
        });
      }

      // A retry of a claim that already succeeded. Narrowed to exactly one
      // state on purpose: releasing is a separate operation, so a transaction
      // that was cancelled, expired or failed payment *after* reserving still
      // owns an ACTIVE row. Answering RESERVED for one of those would report
      // that stock is legitimately held for a purchase that is over - a green
      // light read off a dead transaction.
      if (transaction.status === "INVENTORY_RESERVED") {
        const existing = await tx.inventoryReservation.findFirst({
          where: { transactionId: command.transactionId, status: "ACTIVE" },
        });
        if (existing !== null && !hasLapsed(existing.expiresAt, now)) {
          return {
            kind: "RESERVED" as const,
            reservation: toReservationDto(existing),
            transactionState: transaction.status,
            replayed: true,
          };
        }
      }

      // Authority first. Waiting for approval, blocked, cancelled or already
      // paying are all states in which holding stock would be wrong - as is an
      // INVENTORY_RESERVED transaction whose hold has since lapsed, which needs
      // a fresh authorization rather than a silent re-claim.
      if (transaction.status !== "AUTHORIZED") {
        throw new ReservationRefusedError({
          refusal: "NOT_AUTHORIZED",
          detail: { state: transaction.status },
        });
      }

      const quote = await readActiveQuote(tx, command.transactionId, now);
      if (quote === null) {
        throw new ReservationRefusedError({ refusal: "NO_ACTIVE_QUOTE" });
      }
      if (quote.usability.kind !== "VALID") {
        // Stock is never held against a price that has stopped being true.
        throw new ReservationRefusedError({
          refusal: "QUOTE_NOT_USABLE",
          detail: { usability: quote.usability.kind },
          reasons: quote.usability.kind === "INVALIDATED" ? quote.usability.reasons : [],
        });
      }

      const { productId, quantity, quoteId } = {
        productId: quote.snapshot.productId,
        quantity: quote.snapshot.quantity,
        quoteId: quote.snapshot.quoteId,
      };

      // Lapsed claims release their hold before anyone measures what is left,
      // so an abandoned checkout cannot permanently consume availability.
      await releaseLapsedReservations(tx, productId, now);

      // Read *after* the sweep above, so the figures reflect stock that lapsed
      // holds have just given back. The quote reader saw this product a moment
      // earlier, before that release, and reporting its numbers would tell a
      // refused buyer that stock is held which is in fact free.
      const product = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { inventory: true, reservedQuantity: true, status: true },
      });

      // --- The atomic claim. Everything above was preparation. ---------------
      const claimed = await tx.product.updateMany({
        where: {
          id: productId,
          status: "AVAILABLE",
          // Re-assert the on-hand figure we measured against, so a concurrent
          // commit that sold a unit invalidates this claim rather than being
          // silently overwritten by it.
          inventory: product.inventory,
          reservedQuantity: { lte: product.inventory - quantity },
        },
        data: { reservedQuantity: { increment: quantity } },
      });
      if (claimed.count !== 1) {
        throw new ReservationRefusedError({
          refusal: "INSUFFICIENT_STOCK",
          detail: {
            requested: quantity,
            onHand: product.inventory,
            heldByOthers: product.reservedQuantity,
          },
        });
      }

      const reservation = await tx.inventoryReservation.create({
        data: {
          transactionId: command.transactionId,
          purchaseQuoteId: quoteId,
          productId,
          quantity,
          status: "ACTIVE",
          createdAt: now,
          expiresAt: new Date(now.getTime() + deps.ttlSeconds * 1000),
        },
      });

      await writeInventoryEvent(tx, {
        transactionId: command.transactionId,
        eventType: "inventory_reserved",
        result: "SUCCESS",
        reasonCode: "INVENTORY_RESERVED",
        correlationId: transaction.correlationId,
        operationKey: `reservation:${command.transactionId}:${command.operationId}`,
        metadata: {
          reservationId: reservation.id,
          quoteId,
          productId,
          quantity,
          amountMinor: quote.snapshot.totalAmountMinor.toString(),
          currency: quote.snapshot.currency,
          expiresAt: reservation.expiresAt.toISOString(),
          operationId: command.operationId,
        },
      });

      const outcome = await applyTransactionEventWithin(tx, {
        transactionId: command.transactionId,
        event: "INVENTORY_RESERVED",
        actor: INVENTORY_ACTOR,
        idempotencyKey: `reservation:${command.operationId}`,
        details: {
          reservationId: reservation.id,
          quoteId,
          productId,
          quantity,
          expiresAt: reservation.expiresAt.toISOString(),
        },
      });

      return {
        kind: "RESERVED" as const,
        reservation: toReservationDto(reservation),
        transactionState: stateOf(outcome) ?? "INVENTORY_RESERVED",
        replayed: false,
      };
    });
  } catch (error) {
    if (error instanceof ReservationRefusedError) {
      return {
        kind: "REFUSED",
        transactionId: command.transactionId,
        refusal: error.refusal,
        detail: error.detail,
        reasons: error.reasons,
      };
    }
    if (error instanceof AppError) throw error;
    throw new ReservationPersistenceError("the claim could not be committed", error);
  }
}

export interface ReleaseReservationCommand {
  readonly reservationId: string;
  /** Why the hold ended. A closed vocabulary in the caller's own terms. */
  readonly reasonCode: string;
}

/**
 * Gives held stock back.
 *
 * The conditional UPDATE is what makes this idempotent *and* concurrency-safe
 * at once: only a transition that actually moved the row from ACTIVE returns a
 * count of one, so the stock counter is decremented exactly once no matter how
 * many callers release the same reservation simultaneously. A second call finds
 * nothing to do and says so, which is a success.
 *
 * A COMMITTED reservation is not releasable, and this is where that holds: it
 * is no longer ACTIVE, so nothing matches and the sold stock cannot be handed
 * back into availability.
 */
export async function releaseReservation(
  command: ReleaseReservationCommand,
  deps: ReservationServiceDeps = defaultReservationDeps(),
): Promise<ReleaseResult> {
  const now = deps.clock.now();

  return deps.prisma.$transaction(async (tx) => {
    const reservation = await tx.inventoryReservation.findUnique({
      where: { id: command.reservationId },
      include: { transaction: { select: { correlationId: true } } },
    });
    if (reservation === null) {
      return { kind: "NOT_FOUND" as const, reservationId: command.reservationId };
    }

    const released = await tx.inventoryReservation.updateMany({
      where: { id: command.reservationId, status: "ACTIVE" },
      data: { status: "RELEASED", releasedAt: now },
    });
    if (released.count !== 1) {
      return {
        kind: "ALREADY_SETTLED" as const,
        reservationId: command.reservationId,
        status: reservation.status,
      };
    }

    await tx.product.update({
      where: { id: reservation.productId },
      data: { reservedQuantity: { decrement: reservation.quantity } },
    });

    await writeInventoryEvent(tx, {
      transactionId: reservation.transactionId,
      eventType: "inventory_released",
      result: "SUCCESS",
      reasonCode: command.reasonCode,
      correlationId: reservation.transaction.correlationId,
      operationKey: `reservation-release:${command.reservationId}`,
      metadata: {
        reservationId: command.reservationId,
        productId: reservation.productId,
        quantity: reservation.quantity,
        releasedAt: now.toISOString(),
      },
    });

    return {
      kind: "RELEASED" as const,
      reservationId: command.reservationId,
      quantity: reservation.quantity,
    };
  });
}

/**
 * Turns a claim into a sale, permanently.
 *
 * The only operation in the system that decrements real stock, and the only one
 * whose precondition is evidence of money. It is written now so the payment
 * workflow has something correct to call, and it is deliberately called by
 * nothing yet: no route, no tool, no service. A browser cannot reach it and
 * Gemini has no tool for it.
 *
 * Exactly-once is structural. The conditional UPDATE from ACTIVE is what
 * authorizes the decrement, so a replayed commit decrements nothing.
 */
export async function commitReservation(
  reservationId: string,
  deps: ReservationServiceDeps = defaultReservationDeps(),
): Promise<CommitResult> {
  const now = deps.clock.now();

  return deps.prisma.$transaction(async (tx) => {
    const reservation = await tx.inventoryReservation.findUnique({
      where: { id: reservationId },
      include: {
        transaction: { select: { status: true, correlationId: true } },
      },
    });
    if (reservation === null) {
      return {
        kind: "REFUSED" as const,
        reservationId,
        refusal: "NOT_FOUND",
        detail: {},
      };
    }
    if (!CAPTURED_STATES.includes(reservation.transaction.status)) {
      // No captured payment, no sale. Checked before the conditional update so
      // an unproven commit cannot even burn the claim.
      return {
        kind: "REFUSED" as const,
        reservationId,
        refusal: "PAYMENT_NOT_CAPTURED",
        detail: { state: reservation.transaction.status },
      };
    }

    const committed = await tx.inventoryReservation.updateMany({
      where: { id: reservationId, status: "ACTIVE" },
      data: { status: "COMMITTED", committedAt: now },
    });
    if (committed.count !== 1) {
      return {
        kind: "REFUSED" as const,
        reservationId,
        refusal: "NOT_ACTIVE",
        detail: { status: reservation.status },
      };
    }

    // On-hand stock falls and the hold is lifted together: the unit left the
    // warehouse, so it is no longer reserved, it is gone.
    const product = await tx.product.update({
      where: { id: reservation.productId },
      data: {
        inventory: { decrement: reservation.quantity },
        reservedQuantity: { decrement: reservation.quantity },
      },
      select: { inventory: true },
    });

    await writeInventoryEvent(tx, {
      transactionId: reservation.transactionId,
      eventType: "inventory_committed",
      result: "SUCCESS",
      reasonCode: "INVENTORY_COMMITTED",
      correlationId: reservation.transaction.correlationId,
      operationKey: `reservation-commit:${reservationId}`,
      metadata: {
        reservationId,
        productId: reservation.productId,
        quantity: reservation.quantity,
        remainingInventory: product.inventory,
        committedAt: now.toISOString(),
      },
    });

    return {
      kind: "COMMITTED" as const,
      reservationId,
      quantity: reservation.quantity,
      remainingInventory: product.inventory,
    };
  });
}

/** Reservable stock for a product, right now. Read-only; used by callers and tests. */
export async function readReservableStock(
  productId: string,
  deps: ReservationServiceDeps = defaultReservationDeps(),
): Promise<{ inventory: number; reserved: number; reservable: number }> {
  const product = await deps.prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: { inventory: true, reservedQuantity: true },
  });
  return {
    inventory: product.inventory,
    reserved: product.reservedQuantity,
    reservable: Math.max(0, product.inventory - product.reservedQuantity),
  };
}

/**
 * Frees stock whose hold has lapsed, before availability is measured.
 *
 * Lazy rather than scheduled. A background worker that is late would leave
 * abandoned checkouts holding stock away from real buyers, and correctness here
 * must not depend on a job having run. Each release is its own conditional
 * UPDATE, so two callers expiring the same reservation at the same instant
 * cannot both give the stock back.
 */
export async function releaseLapsedReservations(
  tx: TransactionCapableClient,
  productId: string,
  now: Date,
): Promise<number> {
  const lapsed = await tx.inventoryReservation.findMany({
    where: { productId, status: "ACTIVE", expiresAt: { lte: now } },
    select: {
      id: true,
      quantity: true,
      transactionId: true,
      // Each lapsed hold belongs to its own transaction, and its event must
      // carry that transaction's correlation id. Stamping the id of whoever
      // happened to trigger the sweep would file one buyer's expiry under
      // another buyer's request.
      transaction: { select: { correlationId: true } },
    },
  });

  let freed = 0;
  for (const reservation of lapsed) {
    const marked = await tx.inventoryReservation.updateMany({
      where: { id: reservation.id, status: "ACTIVE" },
      data: { status: "EXPIRED", releasedAt: now },
    });
    if (marked.count !== 1) continue;

    await tx.product.update({
      where: { id: productId },
      data: { reservedQuantity: { decrement: reservation.quantity } },
    });
    freed += reservation.quantity;

    await writeInventoryEvent(tx, {
      transactionId: reservation.transactionId,
      eventType: "inventory_reservation_expired",
      result: "FAILURE",
      reasonCode: "RESERVATION_EXPIRED",
      correlationId: reservation.transaction.correlationId,
      operationKey: `reservation-expiry:${reservation.id}`,
      metadata: {
        reservationId: reservation.id,
        productId,
        quantity: reservation.quantity,
        expiredAt: now.toISOString(),
      },
    });
  }
  return freed;
}

function hasLapsed(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

interface InventoryEvent {
  readonly transactionId: string;
  readonly eventType: AuditEventType;
  readonly result: "SUCCESS" | "FAILURE" | "BLOCKED" | "PENDING";
  readonly reasonCode: string;
  readonly correlationId: string | null;
  readonly operationKey: string;
  readonly metadata: JsonObject;
}

/**
 * Writes one inventory event through the central audit boundary.
 *
 * A thin adapter, so idempotency, the trusted-input allow-list and the secret
 * scan all live in one place rather than being re-implemented per service.
 */
async function writeInventoryEvent(
  tx: TransactionCapableClient,
  event: InventoryEvent,
): Promise<void> {
  await recordAuditEvent(tx, {
    transactionId: event.transactionId,
    action: event.eventType,
    actor: INVENTORY_ACTOR,
    result: event.result,
    reasonCode: event.reasonCode,
    trustedInputs: event.metadata,
    correlationId: event.correlationId,
    operationKey: event.operationKey,
  });
}

interface ReservationRow {
  readonly id: string;
  readonly transactionId: string;
  readonly purchaseQuoteId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

function toReservationDto(row: ReservationRow): ReservationDto {
  return {
    id: row.id,
    transactionId: row.transactionId,
    quoteId: row.purchaseQuoteId,
    productId: row.productId,
    quantity: row.quantity,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function stateOf(outcome: {
  readonly to?: TransactionState;
  readonly currentState?: TransactionState;
}): TransactionState | null {
  return outcome.to ?? outcome.currentState ?? null;
}
