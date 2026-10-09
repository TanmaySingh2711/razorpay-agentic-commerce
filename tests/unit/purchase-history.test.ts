import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_STORAGE_KEY,
  MAX_HISTORY_ENTRIES,
  forgetPurchase,
  historyGroup,
  isTransactionId,
  loadStoredHistory,
  parseHistory,
  rememberPurchase,
  saveStoredHistory,
  type HistoryEntry,
} from "@/lib/purchase-history";

/**
 * The rules for the browser-side purchase history.
 *
 * Browser storage is written by whatever ran on this origin before, so the
 * reader trusts nothing in it. Opening the same purchase twice is not two
 * purchases. And storage that is missing or broken must never break a page.
 */

const ID_A = "01a068ee-b304-7756-83d6-3e709f3c1c37";
const ID_B = "01a068ee-b304-7756-83d6-3e709f3c1c38";
const T0 = new Date("2026-10-01T10:00:00.000Z");

describe("reading what was stored", () => {
  it("accepts a well-formed list", () => {
    const raw = JSON.stringify([{ transactionId: ID_A, savedAt: T0.toISOString() }]);
    expect(parseHistory(raw)).toEqual([
      { transactionId: ID_A, savedAt: T0.toISOString() },
    ]);
  });

  it.each([
    ["nothing stored", null],
    ["not JSON", "{oops"],
    ["not a list", JSON.stringify({ transactionId: ID_A })],
  ])("returns an empty history for %s", (_label, raw) => {
    expect(parseHistory(raw)).toEqual([]);
  });

  it("drops anything that is not exactly an entry, keeping the rest", () => {
    const raw = JSON.stringify([
      { transactionId: ID_A, savedAt: T0.toISOString() },
      { transactionId: "not-a-uuid", savedAt: T0.toISOString() },
      { transactionId: ID_B, savedAt: "yesterday-ish" },
      { transactionId: ID_B },
      "a string",
      null,
      { transactionId: ID_B, savedAt: T0.toISOString(), price: "₹1" },
    ]);
    // Extra fields on a valid entry are simply not carried over.
    expect(parseHistory(raw)).toEqual([
      { transactionId: ID_A, savedAt: T0.toISOString() },
      { transactionId: ID_B, savedAt: T0.toISOString() },
    ]);
  });

  it("removes duplicates, case-insensitively, keeping the first", () => {
    const raw = JSON.stringify([
      { transactionId: ID_A.toUpperCase(), savedAt: T0.toISOString() },
      { transactionId: ID_A, savedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    expect(parseHistory(raw)).toEqual([
      { transactionId: ID_A, savedAt: T0.toISOString() },
    ]);
  });

  it("never returns more than the cap", () => {
    const many = Array.from({ length: MAX_HISTORY_ENTRIES + 10 }, (_, index) => ({
      transactionId: `01a068ee-b304-7756-83d6-${index.toString().padStart(12, "0")}`,
      savedAt: T0.toISOString(),
    }));
    expect(parseHistory(JSON.stringify(many))).toHaveLength(MAX_HISTORY_ENTRIES);
  });
});

describe("remembering and forgetting", () => {
  it("puts a new purchase first", () => {
    const first = rememberPurchase([], ID_A, T0);
    const second = rememberPurchase(first, ID_B, new Date("2026-10-01T11:00:00.000Z"));
    expect(second.map((entry) => entry.transactionId)).toEqual([ID_B, ID_A]);
  });

  it("does not move or re-date a purchase opened again", () => {
    const history = rememberPurchase(rememberPurchase([], ID_A, T0), ID_B, T0);
    const again = rememberPurchase(history, ID_A, new Date("2026-12-31T00:00:00.000Z"));
    expect(again).toEqual(history);
  });

  it("ignores an id that is not a transaction id", () => {
    expect(rememberPurchase([], "../../etc/passwd", T0)).toEqual([]);
  });

  it("drops the oldest once the cap is reached", () => {
    let history: HistoryEntry[] = [];
    for (let index = 0; index <= MAX_HISTORY_ENTRIES; index += 1) {
      const id = `01a068ee-b304-7756-83d6-${index.toString().padStart(12, "0")}`;
      history = rememberPurchase(history, id, T0);
    }
    expect(history).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(history.at(-1)?.transactionId).toBe("01a068ee-b304-7756-83d6-000000000001");
  });

  it("forgets one purchase and keeps the others in order", () => {
    const history = rememberPurchase(rememberPurchase([], ID_A, T0), ID_B, T0);
    expect(forgetPurchase(history, ID_B)).toEqual([
      { transactionId: ID_A, savedAt: T0.toISOString() },
    ]);
  });

  it("recognises transaction ids and nothing else", () => {
    expect(isTransactionId(ID_A)).toBe(true);
    expect(isTransactionId(`${ID_A} `)).toBe(false);
    expect(isTransactionId(42)).toBe(false);
  });
});

describe("grouping for the filter", () => {
  it.each([
    ["COMPLETED", null, "completed"],
    ["PAYMENT_CAPTURED", null, "completed"],
    ["COMPLETED", "PENDING", "completed"],
    ["COMPLETED", "PROCESSED", "refunded"],
    ["PAYMENT_FAILED", null, "stopped"],
    ["BLOCKED", null, "stopped"],
    ["EXPIRED", null, "stopped"],
    ["CANCELLED", null, "stopped"],
    ["APPROVAL_REQUIRED", null, "open"],
    ["PAYMENT_VERIFIED", null, "open"],
  ] as const)("puts %s with refund %s under %s", (state, refund, group) => {
    expect(historyGroup(state, refund)).toBe(group);
  });
});

describe("browser storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeStorage() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
  }

  it("round-trips a history through storage", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const history = rememberPurchase([], ID_A, T0);

    expect(saveStoredHistory(history)).toBe(true);
    expect(loadStoredHistory()).toEqual(history);
  });

  it("removes the key entirely when the history is cleared", () => {
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveStoredHistory(rememberPurchase([], ID_A, T0));

    saveStoredHistory([]);

    expect(storage.data.has(HISTORY_STORAGE_KEY)).toBe(false);
  });

  it("works without storage at all: empty on read, false on write", () => {
    vi.stubGlobal("window", {
      get localStorage(): never {
        throw new Error("SecurityError: storage is disabled");
      },
    });
    expect(loadStoredHistory()).toEqual([]);
    expect(saveStoredHistory(rememberPurchase([], ID_A, T0))).toBe(false);
  });
});
