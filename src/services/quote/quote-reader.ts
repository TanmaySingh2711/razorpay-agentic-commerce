import { assertServerOnly } from "@/lib/server-only";
import {
  assessQuote,
  type QuoteSnapshot,
  type QuoteUsability,
} from "@/domain/quote/rules";
import type { CurrencyCode } from "@/domain/money";
import type { TransactionCapableClient } from "@/services/transaction/transition-service";

/**
 * Reading a quote and judging it, inside somebody else's transaction.
 *
 * `validateQuoteForUse` in the quote service is the public boundary: it owns
 * its own connection and records that a quote stopped being usable. That makes
 * it the wrong tool inside a write transaction, where the whole point is that
 * the rows cannot move under the decision before it commits, and where a side
 * effect would be committed along with everything else.
 *
 * So this is the read-only half: fetch the quote and its product with the
 * caller's transaction client, and hand both to the same pure `assessQuote`
 * rules. One implementation, so the approval gate and the reservation service
 * cannot drift apart about what "still usable" means.
 */
assertServerOnly("src/services/quote/quote-reader.ts");

/** The authoritative columns a usability judgement is made from. */
const QUOTE_PRODUCT_COLUMNS = {
  unitAmount: true,
  currency: true,
  inventory: true,
  status: true,
  version: true,
} as const;

export interface ReadQuote {
  readonly snapshot: QuoteSnapshot;
  readonly usability: QuoteUsability;
}

/** The transaction's one live quote, judged as of `now`. Null when there is none. */
export async function readActiveQuote(
  tx: TransactionCapableClient,
  transactionId: string,
  now: Date,
): Promise<ReadQuote | null> {
  const row = await tx.purchaseQuote.findFirst({
    where: { transactionId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    include: { product: { select: QUOTE_PRODUCT_COLUMNS } },
  });
  return row === null ? null : judge(row, now);
}

interface QuoteRow {
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
  readonly product: {
    readonly unitAmount: bigint;
    readonly currency: string;
    readonly inventory: number;
    readonly status: string;
    readonly version: number;
  };
}

function judge(row: QuoteRow, now: Date): ReadQuote {
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

  const purchasable = row.product.status === "AVAILABLE" && row.product.inventory > 0;

  return {
    snapshot,
    // Stock is judged against on-hand inventory here, not against reservable
    // stock. A quote is a statement about a price, and it does not stop being
    // an honest price because somebody else is mid-checkout. Whether *this*
    // buyer can still have a unit is the reservation service's question, and it
    // is answered atomically at the moment stock is claimed.
    usability: assessQuote(
      snapshot,
      {
        unitAmountMinor: row.product.unitAmount,
        currency: row.product.currency,
        availableQuantity: row.product.inventory,
        purchasable,
        version: row.product.version,
      },
      now,
    ),
  };
}
