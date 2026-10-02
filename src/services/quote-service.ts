import { assertServerOnly } from "@/lib/server-only";
import { getQuoteConfig } from "@/config/env";
import { getPrismaClient } from "@/integrations/persistence/client";
import { systemClock, type Clock } from "@/lib/clock";
import { assessQuote, toQuoteDto, type QuoteSnapshot } from "@/domain/quote/rules";
import { applyTransactionEventWithin } from "@/services/transaction/transition-service";
import { recordAuditEvent } from "@/services/audit/audit-service";
import { totalAmountMinor } from "@/domain/product-decision/eligibility";
import {
  QuoteCreationFailureError,
  QuoteProductChangedError,
} from "@/domain/quote/errors";
import type { QuoteValidationResult } from "@/domain/quote/contracts";
import type { CurrencyCode } from "@/domain/money";
import type { PurchaseAuthority } from "@/domain/product-decision/eligibility";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The trusted PurchaseQuote boundary.
 *
 * Everything a quote asserts financially is computed here, from a row this
 * module read out of PostgreSQL moments earlier. No amount, currency, stock
 * level or expiry reaches a quote from a model, a client, or a cached DTO.
 *
 * The two operations are deliberately separate:
 *
 *  - `createTrustedQuote` freezes a price. It re-reads the product inside the
 *    same database transaction that writes the quote and moves the lifecycle,
 *    so what is persisted is one coherent snapshot rather than three reads
 *    stitched together.
 *  - `validateQuoteForUse` asks whether that promise still holds. Objectives
 *    7-10 call it before relying on a quote, and it re-reads the product rather
 *    than trusting the stored status column.
 */
assertServerOnly("src/services/quote/quote-service.ts");

export interface QuoteServiceDeps {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  /** Quote lifetime in seconds. From configuration; never a literal at a call site. */
  readonly ttlSeconds: number;
}

export function defaultQuoteDeps(): QuoteServiceDeps {
  return {
    prisma: getPrismaClient(),
    clock: systemClock,
    ttlSeconds: getQuoteConfig().QUOTE_TTL_SECONDS,
  };
}

/** The authoritative product columns a quote is computed from. */
const QUOTE_SOURCE_COLUMNS = {
  id: true,
  merchantId: true,
  unitAmount: true,
  currency: true,
  inventory: true,
  status: true,
  version: true,
  attributes: true,
  category: true,
} as const;

export interface CreateQuoteCommand {
  readonly transactionId: string;
  readonly productId: string;
  readonly quantity: number;
  /** The shopper's frozen authority. Re-checked against the fresh row. */
  readonly authority: PurchaseAuthority;
  /** Operation identity, so a retried request cannot write a second history row. */
  readonly idempotencyKey: string;
  /**
   * Replace the current active quote rather than returning it.
   *
   * Off by default, so an ordinary retry is idempotent and cannot quietly
   * re-price an order behind the caller. A re-quote is a deliberate act.
   */
  readonly replaceExisting?: boolean;
}

export interface CreatedQuote {
  readonly snapshot: QuoteSnapshot;
  readonly alreadyExisted: boolean;
}

/**
 * Creates the trusted quote and moves the transaction to QUOTE_CREATED, atomically.
 *
 * The whole point of this function is the word *atomically*. Three things have
 * to become true together:
 *
 *   the PurchaseQuote row exists,
 *   the Transaction reads QUOTE_CREATED,
 *   and a TransactionStateTransition records why.
 *
 * A database holding any two of those without the third is a financial record
 * that contradicts itself - a quote nobody can trace to a lifecycle event, or a
 * transaction claiming a quote that was never written. So all three happen in
 * one PostgreSQL transaction, and the state change goes through
 * `applyTransactionEventWithin`: the same state machine, the same matrix, the
 * same actor check, lent to this transaction rather than bypassed.
 *
 * The product is re-read *inside* that transaction, immediately before the
 * quote is computed. Anything the buyer agent observed earlier is treated as a
 * hint about which product to look at, never as the price.
 */
export async function createTrustedQuote(
  command: CreateQuoteCommand,
  deps: QuoteServiceDeps = defaultQuoteDeps(),
): Promise<CreatedQuote> {
  const { transactionId, productId, quantity, authority } = command;
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + deps.ttlSeconds * 1000);

  try {
    return await deps.prisma.$transaction(async (tx) => {
      // --- The authoritative read. Everything financial comes from this row. ---
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: QUOTE_SOURCE_COLUMNS,
      });
      if (product === null) {
        throw new QuoteProductChangedError(["PRODUCT_UNAVAILABLE"]);
      }

      // Re-verified here, not merely earlier: between the candidate filter and
      // this line the product may have changed, and this row is the one the
      // quote will claim.
      const changed = detectDisqualifyingChange(product, quantity, authority);
      if (changed.length > 0) {
        throw new QuoteProductChangedError(changed);
      }

      const unitAmountMinor = product.unitAmount;
      const total = totalAmountMinor(unitAmountMinor, quantity);

      const existing = await tx.purchaseQuote.findFirst({
        where: { transactionId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      });

      if (existing !== null && command.replaceExisting !== true) {
        // An ordinary retry. Returning the existing quote is what makes this
        // operation idempotent - and what stops a repeated request quietly
        // re-pricing an order the shopper is already looking at.
        return { snapshot: toSnapshot(existing), alreadyExisted: true };
      }

      if (existing !== null) {
        // A deliberate re-quote. The old row is retired, never edited: its
        // amounts are a record of a price the merchant once stood behind.
        // Superseding first is also what satisfies the partial unique index,
        // which permits only one ACTIVE quote per transaction.
        await supersedeActiveQuotes(tx, transactionId, now);
      }

      const created = await tx.purchaseQuote.create({
        data: {
          transactionId,
          productId,
          quantity,
          unitAmount: unitAmountMinor,
          totalAmount: total,
          currency: product.currency,
          productVersion: product.version,
          status: "ACTIVE",
          // Both ends of the quote's life come from the same clock. Letting
          // `createdAt` fall through to the database default would measure the
          // TTL between two different time sources - the database's and the
          // application's - and any drift between them would silently lengthen
          // or shorten every quote. The CHECK constraint requiring
          // `expiresAt > createdAt` is what surfaced this.
          createdAt: now,
          expiresAt,
        },
      });

      // The audit record joins the quote row and the lifecycle move in one
      // commit. A quote that exists with no record of being made is a price
      // nobody can explain later.
      await recordAuditEvent(tx, {
        transactionId,
        action: existing === null ? "quote_created" : "quote_reissued",
        actor: "quote_service",
        result: "SUCCESS",
        reasonCode: existing === null ? "QUOTE_ISSUED" : "QUOTE_REISSUED",
        trustedInputs: {
          quoteId: created.id,
          productId,
          quantity,
          unitAmountMinor: unitAmountMinor.toString(),
          totalAmountMinor: total.toString(),
          currency: product.currency,
          productVersion: product.version,
          expiresAt: created.expiresAt.toISOString(),
          replacedQuoteId: existing?.id ?? null,
        },
        operationKey: `quote:${created.id}`,
      });

      // The lifecycle move, through the state machine, in this transaction. If
      // it refuses - wrong state, terminal, actor not permitted - the quote row
      // above is rolled back with it.
      const outcome = await applyTransactionEventWithin(tx as TransactionCapableClient, {
        transactionId,
        event: "QUOTE_ISSUED",
        actor: "quote_service",
        idempotencyKey: command.idempotencyKey,
        details: {
          quoteId: created.id,
          productId,
          quantity,
          unitAmountMinor: unitAmountMinor.toString(),
          totalAmountMinor: total.toString(),
          currency: product.currency,
          productVersion: product.version,
        },
      });

      if (outcome.kind !== "APPLIED") {
        // The quote was written but the lifecycle did not move. Refusing here
        // rolls both back rather than leaving them disagreeing.
        throw new QuoteCreationFailureError(
          `the QUOTE_ISSUED transition resolved to ${outcome.kind}`,
        );
      }

      return { snapshot: toSnapshot(created), alreadyExisted: false };
    });
  } catch (error) {
    if (
      error instanceof QuoteProductChangedError ||
      error instanceof QuoteCreationFailureError
    ) {
      throw error;
    }
    throw new QuoteCreationFailureError("the quote could not be committed", error);
  }
}

interface ProductRow {
  readonly unitAmount: bigint;
  readonly currency: string;
  readonly inventory: number;
  readonly status: string;
  readonly version: number;
}

/**
 * What about this row makes it unquotable right now.
 *
 * Mirrors the candidate filter, but against the row inside the write
 * transaction. The duplication is deliberate: the earlier check decides who is
 * a candidate, this one decides what is true at the instant of committing, and
 * collapsing them would mean quoting from a read that is already history.
 */
function detectDisqualifyingChange(
  product: ProductRow,
  quantity: number,
  authority: PurchaseAuthority,
): readonly (
  "PRICE_CHANGED" | "CURRENCY_CHANGED" | "INSUFFICIENT_STOCK" | "PRODUCT_UNAVAILABLE"
)[] {
  const reasons: (
    "PRICE_CHANGED" | "CURRENCY_CHANGED" | "INSUFFICIENT_STOCK" | "PRODUCT_UNAVAILABLE"
  )[] = [];

  if (authority.currency !== null && product.currency !== authority.currency) {
    reasons.push("CURRENCY_CHANGED");
  }
  if (product.status !== "AVAILABLE" || product.inventory <= 0) {
    reasons.push("PRODUCT_UNAVAILABLE");
  } else if (product.inventory < quantity) {
    reasons.push("INSUFFICIENT_STOCK");
  }
  if (authority.maxAmountMinor !== null && authority.currency !== null) {
    const scope = authority.budgetScope ?? (quantity === 1 ? "PER_UNIT" : "TOTAL");
    const compared =
      scope === "PER_UNIT"
        ? product.unitAmount
        : totalAmountMinor(product.unitAmount, quantity);
    if (compared > authority.maxAmountMinor) {
      // The fresh price no longer fits the shopper's stated limit. The limit is
      // the thing that does not move.
      reasons.push("PRICE_CHANGED");
    }
  }
  return reasons;
}

interface PersistedQuote {
  readonly id: string;
  readonly transactionId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitAmount: bigint;
  readonly totalAmount: bigint;
  readonly currency: string;
  readonly productVersion: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

function toSnapshot(row: PersistedQuote): QuoteSnapshot {
  return {
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
}

/**
 * Whether a quote may still be relied upon, right now.
 *
 * The entry point Objectives 7-10 call before acting on a quote. It re-reads
 * the product every time: a status column says only what was true when
 * something last wrote it, and there is no background job here keeping those
 * columns honest - deliberately, because a payment path must not depend on a
 * scheduler having run.
 *
 * Read-only with one exception: an expired or invalidated quote is marked as
 * such, so history records when it stopped being usable. It never mutates the
 * quote's financial fields, and it never touches inventory - reserving stock is
 * Objective 8's job, not a side effect of looking at a quote.
 */
export async function validateQuoteForUse(
  quoteId: string,
  deps: QuoteServiceDeps = defaultQuoteDeps(),
): Promise<QuoteValidationResult> {
  const row = await deps.prisma.purchaseQuote.findUnique({
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
    },
  });

  if (row === null) {
    return { kind: "NOT_FOUND", quoteId };
  }

  const snapshot = toSnapshot(row);
  const verdict = assessQuote(
    snapshot,
    {
      unitAmountMinor: row.product.unitAmount,
      currency: row.product.currency,
      availableQuantity: row.product.inventory,
      purchasable: row.product.status === "AVAILABLE" && row.product.inventory > 0,
      version: row.product.version,
    },
    deps.clock.now(),
  );

  if (verdict.kind === "VALID") {
    return { kind: "VALID", quote: toQuoteDto(snapshot) };
  }

  // Record *that* it stopped being usable. The amounts are never rewritten.
  //
  // The status write and its audit record go in one transaction: a quote that
  // silently stopped being payable, with nothing saying why, is precisely the
  // gap a shopper would later ask about.
  const nextStatus = verdict.kind === "EXPIRED" ? "EXPIRED" : "INVALIDATED";
  if (row.status === "ACTIVE") {
    const settledAt = deps.clock.now();
    await deps.prisma.$transaction(async (tx) => {
      await tx.purchaseQuote.update({
        where: { id: quoteId },
        data: { status: nextStatus, invalidatedAt: settledAt },
      });
      await recordAuditEvent(tx, {
        transactionId: row.transactionId,
        action: verdict.kind === "EXPIRED" ? "quote_expired" : "quote_invalidated",
        actor: "quote_service",
        result: "FAILURE",
        reasonCode: verdict.kind === "EXPIRED" ? "QUOTE_EXPIRED" : "QUOTE_INVALIDATED",
        trustedInputs: {
          quoteId,
          totalAmountMinor: row.totalAmount.toString(),
          currency: row.currency,
          ...(verdict.kind === "INVALIDATED" ? { reasons: [...verdict.reasons] } : {}),
          ...(verdict.kind === "EXPIRED" ? { expiredAt: settledAt.toISOString() } : {}),
        },
        // One settlement per quote, however many callers notice at once.
        operationKey: `quote-settled:${quoteId}`,
      });
    });
  }

  const settled = { ...snapshot, status: nextStatus };
  return verdict.kind === "EXPIRED"
    ? { kind: "EXPIRED", quote: toQuoteDto(settled) }
    : { kind: "INVALIDATED", quote: toQuoteDto(settled), reasons: verdict.reasons };
}

/**
 * Retires the active quotes on a transaction so a replacement can be issued.
 *
 * Supersede rather than overwrite. The old quote's amounts stay exactly as they
 * were - it is a record of a price the merchant once stood behind, and rewriting
 * it would destroy the history that makes a disputed charge explicable. Only its
 * status changes, and only to say it is no longer the one to pay.
 */
export async function supersedeActiveQuotes(
  tx: TransactionCapableClient,
  transactionId: string,
  now: Date,
): Promise<number> {
  const result = await tx.purchaseQuote.updateMany({
    where: { transactionId, status: "ACTIVE" },
    data: { status: "SUPERSEDED", invalidatedAt: now },
  });
  return result.count;
}
