"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadPurchaseHistory } from "@/app/actions";
import { describeState, formatDateTime, formatMoney } from "@/domain/journey";
import { describeRefundStatus, type RefundStatus } from "@/domain/refund";
import { purchasePath } from "@/lib/routes";
import {
  forgetPurchase,
  historyGroup,
  loadStoredHistory,
  saveStoredHistory,
  type HistoryEntry,
  type HistoryGroup,
} from "@/lib/purchase-history";
import type { PurchaseSummary } from "@/services/purchase-history-service";

/**
 * The purchases this browser has opened, with where each one stands now.
 *
 * The ids come from browser storage; everything shown about them comes from
 * the server, through `loadPurchaseHistory`. Clearing forgets the ids here
 * and nothing else - the purchases themselves, and their audit trail, stay on
 * the server, which this component says in so many words.
 */

type Phase =
  | { readonly kind: "LOADING" }
  | { readonly kind: "READY" }
  | { readonly kind: "ERROR"; readonly message: string };

const FILTERS: readonly {
  readonly value: HistoryGroup | "all";
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "open", label: "In progress" },
  { value: "refunded", label: "Refunded" },
  { value: "stopped", label: "Stopped" },
];

const TONE_CLASS = {
  POSITIVE: "positive",
  NEUTRAL: "neutral",
  WARNING: "warning",
  NEGATIVE: "negative",
} as const;

function refundTone(status: RefundStatus): "positive" | "warning" | "negative" {
  if (status === "PROCESSED") return "positive";
  if (status === "FAILED") return "negative";
  return "warning";
}

/** What was paid and kept: completed purchases, less anything refunded. */
function paidMinor(purchases: readonly PurchaseSummary[]): bigint {
  return purchases.reduce((total, purchase) => {
    if (purchase.total === null) return total;
    return historyGroup(purchase.state, purchase.refund) === "completed"
      ? total + BigInt(purchase.total.amountMinor)
      : total;
  }, 0n);
}

function Row({
  purchase,
  onRemove,
}: {
  readonly purchase: PurchaseSummary;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const narrative = describeState(purchase.state);
  const name = purchase.productName ?? "No product chosen yet";
  return (
    <li className="history-row">
      <div className="history-main">
        <span className="history-product">
          {name}
          {purchase.quantity !== null && purchase.quantity > 1 ? (
            <span className="history-qty"> × {purchase.quantity}</span>
          ) : null}
        </span>
        <span className="history-meta">Opened {formatDateTime(purchase.createdAt)}</span>
      </div>
      <span className="history-amount">
        {purchase.total === null ? "Not priced" : formatMoney(purchase.total)}
      </span>
      <span className="history-status">
        <span className={`badge ${TONE_CLASS[narrative.tone]}`}>{narrative.label}</span>
        {purchase.refund === null ? null : (
          <span className={`badge ${refundTone(purchase.refund)}`}>
            {describeRefundStatus(purchase.refund)}
          </span>
        )}
      </span>
      <span className="history-actions">
        <Link href={purchasePath(purchase.transactionId)} className="history-open">
          Open<span className="visually-hidden"> {name}</span>
        </Link>
        <button type="button" className="link-button" onClick={onRemove}>
          Remove<span className="visually-hidden"> {name} from history</span>
        </button>
      </span>
    </li>
  );
}

export function PurchaseHistory(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "LOADING" });
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [purchases, setPurchases] = useState<PurchaseSummary[]>([]);
  const [filter, setFilter] = useState<HistoryGroup | "all">("all");
  const [confirming, setConfirming] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    const stored = loadStoredHistory();
    if (stored.length === 0) {
      setEntries([]);
      setPurchases([]);
      setPhase({ kind: "READY" });
      return;
    }
    setPhase({ kind: "LOADING" });
    const result = await loadPurchaseHistory(stored.map((entry) => entry.transactionId));
    if (result.kind === "ERROR") {
      setEntries(stored);
      setPhase({ kind: "ERROR", message: result.message });
      return;
    }
    // An id this server has never heard of (saved against another database)
    // is dropped for good: there is nothing it could ever show.
    const known = new Set(result.purchases.map((purchase) => purchase.transactionId));
    const kept = stored.filter((entry) => known.has(entry.transactionId));
    if (kept.length !== stored.length) saveStoredHistory(kept);
    setEntries(kept);
    setPurchases([...result.purchases]);
    setPhase({ kind: "READY" });
  }, []);

  useEffect(() => {
    // Browser storage only exists after hydration, so the first render is
    // always the loading state and this fills it in.
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [refresh]);

  const order = useMemo(
    () => new Map(entries.map((entry, index) => [entry.transactionId, index])),
    [entries],
  );

  // Most recently saved first - the order the browser remembered them in.
  const visible = purchases
    .filter(
      (purchase) =>
        filter === "all" || historyGroup(purchase.state, purchase.refund) === filter,
    )
    .sort(
      (left, right) =>
        (order.get(left.transactionId) ?? 0) - (order.get(right.transactionId) ?? 0),
    );
  const completed = purchases.filter(
    (purchase) => historyGroup(purchase.state, purchase.refund) === "completed",
  ).length;

  const remove = (transactionId: string): void => {
    const next = forgetPurchase(entries, transactionId);
    saveStoredHistory(next);
    setEntries(next);
    setPurchases((current) =>
      current.filter((purchase) => purchase.transactionId !== transactionId),
    );
    setAnnouncement("Removed from history.");
  };

  const clearAll = (): void => {
    saveStoredHistory([]);
    setEntries([]);
    setPurchases([]);
    setConfirming(false);
    setFilter("all");
    setAnnouncement("History cleared.");
  };

  return (
    <section
      className="history"
      aria-labelledby="history-heading"
      aria-busy={phase.kind === "LOADING"}
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <dl className="history-summary">
        <div>
          <dt>Saved here</dt>
          <dd>{purchases.length}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{completed}</dd>
        </div>
        <div>
          <dt>Paid and kept</dt>
          <dd>
            {formatMoney({
              amountMinor: paidMinor(purchases).toString(),
              currency: "INR",
            })}
          </dd>
        </div>
      </dl>

      <div className="history-toolbar">
        <h2 id="history-heading">Purchases</h2>
        <div className="history-filters" role="group" aria-label="Show">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="filter"
              aria-pressed={filter === option.value}
              onClick={() => {
                setFilter(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {purchases.length === 0 || confirming ? null : (
          <button
            type="button"
            className="secondary clear-button"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Clear history
          </button>
        )}
      </div>

      {confirming ? (
        <div
          className="clear-confirm"
          role="alertdialog"
          aria-labelledby="clear-question"
        >
          <p id="clear-question">
            Forget all {purchases.length} purchases in this browser? The purchases
            themselves, and their records, stay on the server.
          </p>
          <div className="clear-confirm-actions">
            <button type="button" className="danger" onClick={clearAll}>
              Yes, clear history
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === "LOADING" ? (
        <ul className="history-list" aria-label="Loading purchases">
          {[0, 1, 2].map((index) => (
            <li key={index} className="history-row skeleton" aria-hidden="true" />
          ))}
        </ul>
      ) : phase.kind === "ERROR" ? (
        <div className="notice negative" role="alert">
          <strong>That did not load</strong>
          <p>{phase.message}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void refresh();
            }}
          >
            Try again
          </button>
        </div>
      ) : purchases.length === 0 ? (
        <div className="history-empty">
          <p className="history-empty-title">Nothing here yet.</p>
          <p className="hint">
            Every purchase you open is saved here automatically, in this browser only.
          </p>
          <Link href="/shop" className="primary">
            Start a purchase
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <p className="hint history-none">No purchases in this group.</p>
      ) : (
        <ol className="history-list">
          {visible.map((purchase) => (
            <Row
              key={purchase.transactionId}
              purchase={purchase}
              onRemove={() => {
                remove(purchase.transactionId);
              }}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
