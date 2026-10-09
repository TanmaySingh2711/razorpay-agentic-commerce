/**
 * The list of purchases this browser has opened.
 *
 * There is no login in this application - every visitor is the same demo
 * buyer - so a history read from the database would show each visitor every
 * other visitor's purchases. The history is kept in the browser instead: each
 * purchase page a person opens adds its id here, and the history page asks the
 * server for the current state of exactly those ids.
 *
 * Only ids and the time they were saved are stored. Product names, prices and
 * states are always read fresh from the server, so a stored entry can never
 * show a price or a status the server does not agree with.
 *
 * Clearing the history forgets the ids in this browser. It does not delete
 * anything on the server: purchase records and their audit trail are
 * permanent, which is the point of keeping them.
 */

export const HISTORY_STORAGE_KEY = "rac:purchase-history:v1";

/** Older entries fall off the end; a history page is not an archive. */
export const MAX_HISTORY_ENTRIES = 50;

export interface HistoryEntry {
  readonly transactionId: string;
  /** ISO timestamp of the first time this browser opened the purchase. */
  readonly savedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTransactionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Reads a stored list, keeping only well-formed entries.
 *
 * Browser storage is written by whatever ran on this origin before, including
 * an older version of this code, so nothing about it is trusted: anything
 * that is not exactly an entry is dropped rather than repaired.
 */
export function parseHistory(raw: string | null): HistoryEntry[] {
  if (raw === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  for (const item of data as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { transactionId, savedAt } = item as Record<string, unknown>;
    if (!isTransactionId(transactionId) || typeof savedAt !== "string") continue;
    if (Number.isNaN(Date.parse(savedAt))) continue;
    const id = transactionId.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ transactionId: id, savedAt });
    if (entries.length === MAX_HISTORY_ENTRIES) break;
  }
  return entries;
}

/**
 * Adds a purchase to the front of the list.
 *
 * A purchase that is already there keeps its place and its original time:
 * opening the same purchase page again is not a new purchase.
 */
export function rememberPurchase(
  entries: readonly HistoryEntry[],
  transactionId: string,
  now: Date,
): HistoryEntry[] {
  if (!isTransactionId(transactionId)) return [...entries];
  const id = transactionId.toLowerCase();
  if (entries.some((entry) => entry.transactionId === id)) return [...entries];
  return [{ transactionId: id, savedAt: now.toISOString() }, ...entries].slice(
    0,
    MAX_HISTORY_ENTRIES,
  );
}

/** How the history page groups a purchase for its filter. */
export type HistoryGroup = "completed" | "refunded" | "open" | "stopped";

const STOPPED_STATES: ReadonlySet<string> = new Set([
  "PAYMENT_FAILED",
  "BLOCKED",
  "CANCELLED",
  "EXPIRED",
]);
const PAID_STATES: ReadonlySet<string> = new Set(["COMPLETED", "PAYMENT_CAPTURED"]);

/**
 * A refund that went through outranks everything else about a purchase; then
 * paid, then stopped; anything left is still under way. A failed payment can
 * still be retried, but until it is, nothing is moving, so it counts as
 * stopped.
 */
export function historyGroup(state: string, refund: string | null): HistoryGroup {
  if (refund === "PROCESSED") return "refunded";
  if (PAID_STATES.has(state)) return "completed";
  if (STOPPED_STATES.has(state)) return "stopped";
  return "open";
}

export function forgetPurchase(
  entries: readonly HistoryEntry[],
  transactionId: string,
): HistoryEntry[] {
  return entries.filter((entry) => entry.transactionId !== transactionId);
}

/**
 * The browser-storage half, kept apart so the rules above stay pure.
 *
 * Every access is guarded: storage can be missing (server render), disabled
 * (some private windows) or full, and a purchase page must work regardless.
 */
export function loadStoredHistory(): HistoryEntry[] {
  try {
    return parseHistory(window.localStorage.getItem(HISTORY_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveStoredHistory(entries: readonly HistoryEntry[]): boolean {
  try {
    if (entries.length === 0) window.localStorage.removeItem(HISTORY_STORAGE_KEY);
    else window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}
