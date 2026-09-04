import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A decision that lands in the database must also invalidate the page showing
 * it.
 *
 * This is a regression test for a real defect rather than a hypothetical one.
 * Approving a purchase, rejecting it, or holding stock all wrote to the
 * database and returned a success message — and then the transaction page kept
 * rendering the *previous* step until the person pressed F5. The work had
 * happened; the interface simply refused to admit it, which reads as a broken
 * demo rather than a stale cache.
 *
 * The fix has two halves and this covers the server one: every action that
 * genuinely moves a transaction calls `revalidatePath` for that transaction's
 * page. (The client half — `router.refresh()` in `DecisionForm` and
 * `PayButton` — is what turns that invalidation into a visible re-render.)
 *
 * Everything below the action is mocked at the module boundary, because the
 * behaviour under test is "did it revalidate", not "did approval work" — that
 * is `tests/db/approval-and-reservation.test.ts`'s job, against real
 * PostgreSQL.
 */

const { mockRevalidatePath } = vi.hoisted(() => ({ mockRevalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
  revalidateTag: vi.fn(),
}));

const { mockRequestApproval, mockDecideApproval } = vi.hoisted(() => ({
  mockRequestApproval: vi.fn(),
  mockDecideApproval: vi.fn(),
}));

vi.mock("@/services/approval/approval-service", () => ({
  requestApproval: mockRequestApproval,
  decideApproval: mockDecideApproval,
}));

const { mockReserveInventory } = vi.hoisted(() => ({ mockReserveInventory: vi.fn() }));

vi.mock("@/services/inventory/reservation-service", () => ({
  reserveInventory: mockReserveInventory,
}));

const { mockFindUnique } = vi.hoisted(() => ({ mockFindUnique: vi.fn() }));

vi.mock("@/integrations/persistence/client", () => ({
  getPrismaClient: () => ({ transaction: { findUnique: mockFindUnique } }),
}));

const TRANSACTION_ID = "01a068ee-b304-7756-83d6-3e709f3c1c37";

function formDataFor(transactionId: string): FormData {
  const data = new FormData();
  data.set("transactionId", transactionId);
  return data;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("a decision that changes state also invalidates the page rendering it", () => {
  it("revalidates the transaction page when an approval is granted", async () => {
    mockFindUnique.mockResolvedValueOnce({ buyerProfileId: "buyer-1" });
    mockRequestApproval.mockResolvedValueOnce({ kind: "APPROVED", token: "token-1" });
    mockDecideApproval.mockResolvedValueOnce({ kind: "AUTHORIZED" });

    const { approvePurchase } = await import("@/app/actions/purchase");
    const outcome = await approvePurchase({ kind: "IDLE" }, formDataFor(TRANSACTION_ID));

    expect(outcome.kind).toBe("DONE");
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/transaction/${TRANSACTION_ID}`);
  });

  it("revalidates when a purchase is rejected, because that is a state change too", async () => {
    mockFindUnique.mockResolvedValueOnce({ buyerProfileId: "buyer-1" });
    mockRequestApproval.mockResolvedValueOnce({ kind: "APPROVED", token: "token-1" });
    mockDecideApproval.mockResolvedValueOnce({ kind: "REJECTED" });

    const { rejectPurchase } = await import("@/app/actions/purchase");
    const outcome = await rejectPurchase({ kind: "IDLE" }, formDataFor(TRANSACTION_ID));

    expect(outcome.kind).toBe("DONE");
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/transaction/${TRANSACTION_ID}`);
  });

  it("revalidates when stock is successfully held", async () => {
    mockReserveInventory.mockResolvedValueOnce({ kind: "RESERVED" });

    const { reserveStock } = await import("@/app/actions/purchase");
    const outcome = await reserveStock({ kind: "IDLE" }, formDataFor(TRANSACTION_ID));

    expect(outcome.kind).toBe("DONE");
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/transaction/${TRANSACTION_ID}`);
  });

  it("does not revalidate when nothing moved, so a refusal cannot masquerade as progress", async () => {
    // The hold was refused: the transaction is exactly where it was, and
    // invalidating the page would suggest otherwise.
    mockReserveInventory.mockResolvedValueOnce({ kind: "UNAVAILABLE" });

    const { reserveStock } = await import("@/app/actions/purchase");
    const outcome = await reserveStock({ kind: "IDLE" }, formDataFor(TRANSACTION_ID));

    expect(outcome.kind).toBe("ERROR");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("does not revalidate for an unparseable transaction id", async () => {
    const { reserveStock } = await import("@/app/actions/purchase");
    const outcome = await reserveStock({ kind: "IDLE" }, formDataFor("not-a-uuid"));

    expect(outcome.kind).toBe("ERROR");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
