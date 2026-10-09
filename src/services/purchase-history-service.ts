import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/prisma-client";
import { isTransactionId, MAX_HISTORY_ENTRIES } from "@/lib/purchase-history";
import { currencyCodeSchema, type MoneyDto } from "@/domain/money";
import type { RefundStatus } from "@/domain/refund";
import type { TransactionState } from "@/domain/transaction/states";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The current state of the purchases a browser remembers.
 *
 * The browser sends only ids (see `src/lib/purchase-history.ts`); everything a
 * history row shows - the product, the amount, where the purchase stands, any
 * refund - is read here, from the same rows the purchase page reads. So a
 * history row can never disagree with the page it links to.
 *
 * Read-only, and bounded: at most `MAX_HISTORY_ENTRIES` ids, each checked to
 * be a UUID before it reaches the query. It returns nothing a person could not
 * already see by opening each purchase page, which is all an id grants.
 */
assertServerOnly("src/services/purchase-history-service.ts");

export interface PurchaseSummary {
  readonly transactionId: string;
  readonly state: TransactionState;
  readonly createdAt: string;
  /** `null` until a product has been chosen and priced. */
  readonly productName: string | null;
  readonly quantity: number | null;
  /** The quoted total: the only amount this purchase could ever charge. */
  readonly total: MoneyDto | null;
  readonly refund: RefundStatus | null;
}

export interface PurchaseHistoryDeps {
  readonly prisma: PrismaClient;
}

export function defaultPurchaseHistoryDeps(): PurchaseHistoryDeps {
  return { prisma: getPrismaClient() };
}

/**
 * Summaries for the given ids, in the order they were given.
 *
 * Ids that are malformed or unknown are skipped rather than reported: an entry
 * from another database (a local run, then the hosted demo) is simply not
 * here, and that is not an error.
 */
export async function loadPurchaseSummaries(
  ids: readonly string[],
  deps: PurchaseHistoryDeps = defaultPurchaseHistoryDeps(),
): Promise<PurchaseSummary[]> {
  const wanted = [...new Set(ids.filter(isTransactionId).map((id) => id.toLowerCase()))];
  const bounded = wanted.slice(0, MAX_HISTORY_ENTRIES);
  if (bounded.length === 0) return [];

  const rows = await deps.prisma.transaction.findMany({
    where: { id: { in: bounded } },
    select: {
      id: true,
      status: true,
      createdAt: true,
      quotes: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          quantity: true,
          totalAmount: true,
          currency: true,
          product: { select: { name: true } },
        },
      },
      refunds: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  return bounded.flatMap((id) => {
    const row = byId.get(id);
    if (row === undefined) return [];
    const quote = row.quotes[0];
    // The column is CHAR(3); only a currency this application supports is
    // shown as money. Anything else shows no amount rather than a wrong one.
    const currency = currencyCodeSchema.safeParse(quote?.currency);
    return [
      {
        transactionId: row.id,
        state: row.status,
        createdAt: row.createdAt.toISOString(),
        productName: quote?.product.name ?? null,
        quantity: quote?.quantity ?? null,
        total:
          quote === undefined || !currency.success
            ? null
            : { amountMinor: quote.totalAmount.toString(), currency: currency.data },
        refund: row.refunds[0]?.status ?? null,
      },
    ];
  });
}
