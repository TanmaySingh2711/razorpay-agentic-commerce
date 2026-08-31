import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConcurrentTransitionConflictError,
  DuplicateTransitionConflictError,
  InvalidTransitionError,
  TerminalStateViolationError,
  TransactionNotFoundError,
} from "@/domain/transaction/errors";
import type { TransactionActor } from "@/domain/transaction/states";
import type { TransactionEvent } from "@/domain/transaction/events";
import {
  applyTransactionEvent,
  getTransactionHistory,
  type TransitionServiceDeps,
} from "@/services/transaction/transition-service";
import {
  createBaseFixture,
  createTransaction,
  databaseConfigured,
  disconnectTestDb,
  freshTestClient,
  resetTestData,
  testDb,
  uid,
  type BaseFixture,
} from "./harness";

/**
 * The transition service against real PostgreSQL.
 *
 * The pure machine is tested separately; what these tests prove is the part
 * that can only be proven against a database: that state and history commit
 * together, that concurrent writers cannot both win, and that a retry does not
 * duplicate financial history.
 */
describe.skipIf(!databaseConfigured)("transition service", () => {
  let fixture: BaseFixture;
  let deps: TransitionServiceDeps;

  beforeEach(async () => {
    await resetTestData();
    fixture = await createBaseFixture();
    deps = { prisma: testDb() };
  });

  afterAll(async () => {
    await resetTestData();
    await disconnectTestDb();
  });

  const advance = async (
    transactionId: string,
    event: TransactionEvent,
    actor: TransactionActor,
    idempotencyKey?: string,
  ) =>
    applyTransactionEvent(
      {
        transactionId,
        event,
        actor,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
      deps,
    );

  /** Drives a transaction to a given state through the real service. */
  const driveTo = async (transactionId: string, target: string): Promise<void> => {
    const script: ReadonlyArray<[TransactionEvent, TransactionActor, string]> = [
      ["PRODUCT_SELECTION_CONFIRMED", "buyer_agent", "PRODUCT_SELECTED"],
      ["PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service", "PRODUCT_VERIFIED"],
      ["QUOTE_ISSUED", "quote_service", "QUOTE_CREATED"],
      ["POLICY_EVALUATION_COMPLETED", "policy_engine", "POLICY_EVALUATED"],
      ["POLICY_ALLOWED", "policy_engine", "AUTHORIZED"],
      ["INVENTORY_RESERVED", "inventory_service", "INVENTORY_RESERVED"],
      ["PAYMENT_ORDER_CREATED", "payment_provider", "PAYMENT_ORDER_CREATED"],
      ["PAYMENT_STARTED", "payment_provider", "PAYMENT_PENDING"],
      ["PAYMENT_CALLBACK_VERIFIED", "payment_provider", "PAYMENT_VERIFIED"],
      ["PAYMENT_CAPTURE_CONFIRMED", "payment_webhook", "PAYMENT_CAPTURED"],
      ["TRANSACTION_COMPLETED", "transaction_service", "COMPLETED"],
    ];
    for (const [event, actor, reached] of script) {
      await advance(transactionId, event, actor);
      if (reached === target) return;
    }
  };

  describe("canonical lifecycle", () => {
    it("persists intent through completion, with history matching state", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "COMPLETED");

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      const history = await getTransactionHistory(transactionId, deps);

      expect(transaction.status).toBe("COMPLETED");
      expect(transaction.completedAt).toBeInstanceOf(Date);
      expect(history).toHaveLength(11);

      // Sequence is dense, ordered, and each row's `from` chains to the previous `to`.
      expect(history.map((h) => h.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      for (let i = 1; i < history.length; i++) {
        expect(history[i]?.fromStatus).toBe(history[i - 1]?.toStatus);
      }
      // The invariant that makes the history authoritative.
      expect(history.at(-1)?.toStatus).toBe(transaction.status);
    });

    it("records actor, reason code and timestamp on every transition", async () => {
      const transactionId = await createTransaction(fixture);
      await advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent");
      await advance(transactionId, "PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service");

      const history = await getTransactionHistory(transactionId, deps);
      expect(history[0]).toMatchObject({
        fromStatus: "INTENT_RECEIVED",
        toStatus: "PRODUCT_SELECTED",
        actor: "buyer_agent",
        trigger: "PRODUCT_SELECTION_CONFIRMED",
        reasonCode: "PRODUCT_SELECTED",
      });
      expect(history[1]).toMatchObject({
        actor: "merchant_service",
        reasonCode: "PRODUCT_VERIFIED",
      });
      expect(history[0]?.createdAt).toBeInstanceOf(Date);
    });

    it("verifies the product before a quote can be issued", async () => {
      const transactionId = await createTransaction(fixture);
      await advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent");

      await expect(
        advance(transactionId, "QUOTE_ISSUED", "quote_service"),
      ).rejects.toThrow(InvalidTransitionError);

      // Nothing was written by the refused command.
      const history = await getTransactionHistory(transactionId, deps);
      expect(history).toHaveLength(1);
    });
  });

  describe("approval and blocked branches", () => {
    it("routes through approval and back into the authorized flow", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "QUOTE_CREATED");
      await advance(transactionId, "POLICY_EVALUATION_COMPLETED", "policy_engine");
      await advance(transactionId, "POLICY_REQUIRES_APPROVAL", "policy_engine");

      let transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("APPROVAL_REQUIRED");

      await advance(transactionId, "APPROVAL_GRANTED", "approval_gate");
      transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("AUTHORIZED");
    });

    it("blocks on policy refusal and then refuses everything", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "QUOTE_CREATED");
      await advance(transactionId, "POLICY_EVALUATION_COMPLETED", "policy_engine");
      await advance(transactionId, "POLICY_BLOCKED", "policy_engine");

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("BLOCKED");

      await expect(
        advance(transactionId, "PAYMENT_ORDER_CREATED", "payment_provider"),
      ).rejects.toThrow(TerminalStateViolationError);
    });
  });

  describe("terminal protection", () => {
    it("refuses ordinary commands against a completed transaction", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "COMPLETED");

      await expect(
        advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent"),
      ).rejects.toThrow(TerminalStateViolationError);

      const history = await getTransactionHistory(transactionId, deps);
      expect(history).toHaveLength(11);
    });

    it("raises a precise error for an unknown transaction", async () => {
      await expect(
        advance(
          "01930000-0000-7000-8000-0000000000ff",
          "TRANSACTION_CANCELLED",
          "human_user",
        ),
      ).rejects.toThrow(TransactionNotFoundError);
    });
  });

  describe("idempotency", () => {
    it("treats a replayed command with the same key as already applied", async () => {
      const transactionId = await createTransaction(fixture);
      await advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent");
      await advance(transactionId, "PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service");
      await advance(transactionId, "QUOTE_ISSUED", "quote_service");
      await advance(transactionId, "POLICY_EVALUATION_COMPLETED", "policy_engine");
      await advance(transactionId, "POLICY_ALLOWED", "policy_engine");
      await advance(transactionId, "INVENTORY_RESERVED", "inventory_service");
      await advance(transactionId, "PAYMENT_ORDER_CREATED", "payment_provider");
      await advance(transactionId, "PAYMENT_STARTED", "payment_provider");

      const key = uid("op");
      const first = await advance(
        transactionId,
        "PAYMENT_CALLBACK_VERIFIED",
        "payment_provider",
        key,
      );
      expect(first.kind).toBe("APPLIED");

      const historyAfterFirst = await getTransactionHistory(transactionId, deps);

      // The caller lost the response and retried the identical operation.
      const replay = await advance(
        transactionId,
        "PAYMENT_CALLBACK_VERIFIED",
        "payment_provider",
        key,
      );
      expect(replay.kind).toBe("ALREADY_APPLIED");

      const historyAfterReplay = await getTransactionHistory(transactionId, deps);
      expect(historyAfterReplay).toHaveLength(historyAfterFirst.length);
      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.status).toBe("PAYMENT_VERIFIED");
    });

    it("refuses to reuse one operation key for a different event", async () => {
      const transactionId = await createTransaction(fixture);
      const key = uid("op");
      await advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent", key);

      await expect(
        advance(transactionId, "PRODUCT_VERIFICATION_SUCCEEDED", "merchant_service", key),
      ).rejects.toThrow(DuplicateTransitionConflictError);
    });

    it("judges a resubmitted event by actual state, not by a fresh key", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "PAYMENT_CAPTURED");

      // Same event, brand-new identity. A caller must not defeat idempotency by
      // minting a new key: the real current state governs.
      const replay = await advance(
        transactionId,
        "PAYMENT_CAPTURE_CONFIRMED",
        "payment_webhook",
        uid("fresh"),
      );
      expect(replay.kind).toBe("ALREADY_APPLIED");

      const history = await getTransactionHistory(transactionId, deps);
      expect(history.filter((h) => h.toStatus === "PAYMENT_CAPTURED")).toHaveLength(1);
    });
  });

  describe("late external events", () => {
    it("holds a capture that arrives after cancellation, changing nothing", async () => {
      const transactionId = await createTransaction(fixture);
      await advance(transactionId, "TRANSACTION_CANCELLED", "human_user");

      const outcome = await advance(
        transactionId,
        "PAYMENT_CAPTURE_CONFIRMED",
        "payment_webhook",
        uid("evt"),
      );
      expect(outcome.kind).toBe("LATE_EVENT_HELD");

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      // Held, not applied: the transaction is not resurrected...
      expect(transaction.status).toBe("CANCELLED");
      const history = await getTransactionHistory(transactionId, deps);
      // ...and no history row was fabricated for a transition that never happened.
      expect(history).toHaveLength(1);

      // No reconciliation, no audit trail, no side effect of any kind. Holding
      // the event is the whole behaviour: deciding what a held event *means* is
      // the reconciliation objective's job, and it must find a clean slate.
      const auditEvents = await testDb().auditEvent.count({ where: { transactionId } });
      expect(auditEvents).toBe(0);
    });

    it("applies a verified late capture to a failed payment", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "PAYMENT_PENDING");
      await advance(transactionId, "PAYMENT_FAILED", "payment_webhook");

      const outcome = await advance(
        transactionId,
        "PAYMENT_CAPTURE_CONFIRMED",
        "payment_webhook",
        uid("evt"),
      );
      expect(outcome.kind).toBe("APPLIED");

      const history = await getTransactionHistory(transactionId, deps);
      expect(history.at(-1)).toMatchObject({
        fromStatus: "PAYMENT_FAILED",
        toStatus: "PAYMENT_CAPTURED",
        reasonCode: "LATE_CAPTURE_RECONCILED",
      });
    });
  });

  describe("concurrency", () => {
    /**
     * Two events racing from the same state.
     *
     * There are exactly two safe outcomes, and which one occurs depends on
     * whether the two database transactions genuinely overlap:
     *
     *  - They overlap. Both decide from PAYMENT_PENDING; the second blocks on
     *    the row lock, PostgreSQL re-evaluates its WHERE clause against the
     *    committed row, no rows match, and it is refused with a conflict.
     *  - They do not overlap. The second reads the state the first produced and
     *    is adjudicated against *that* - which may legitimately apply, because
     *    a late failure after a verified payment is a real scenario the matrix
     *    models.
     *
     * Both are correct. What must never happen is two transitions leaving the
     * same state, so that is what this asserts - the invariant, not whichever
     * of the two safe paths the scheduler happened to take.
     */
    it("never lets two transitions leave the same state", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "PAYMENT_PENDING");

      const results = await Promise.allSettled([
        advance(transactionId, "PAYMENT_CALLBACK_VERIFIED", "payment_provider"),
        advance(transactionId, "PAYMENT_FAILED", "payment_webhook"),
      ]);

      // Whatever happened, at least one had to succeed.
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);

      // And any failure is the controlled conflict, never a raw database error.
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ConcurrentTransitionConflictError);
        }
      }

      const transaction = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      const history = await getTransactionHistory(transactionId, deps);

      // THE invariant: one departure from PAYMENT_PENDING. Two would mean a
      // lost update - one writer overwriting a state another had already moved.
      expect(history.filter((h) => h.fromStatus === "PAYMENT_PENDING")).toHaveLength(1);

      // History and state agree, and every step is uniquely ordered.
      expect(history.at(-1)?.toStatus).toBe(transaction.status);
      expect(new Set(history.map((h) => h.sequence)).size).toBe(history.length);

      // Every recorded step is a legal edge, in order.
      for (let i = 1; i < history.length; i += 1) {
        expect(history[i]?.fromStatus).toBe(history[i - 1]?.toStatus);
      }
    });

    it("applies the same transition exactly once under five concurrent attempts", async () => {
      const transactionId = await createTransaction(fixture);

      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent"),
        ),
      );

      // Losers are either refused with a conflict or told it was already done.
      // Both are safe; neither writes a second row.
      const applied = attempts.filter(
        (r) => r.status === "fulfilled" && r.value.kind === "APPLIED",
      );
      expect(applied).toHaveLength(1);

      const history = await getTransactionHistory(transactionId, deps);
      expect(history).toHaveLength(1);
      expect(history[0]?.sequence).toBe(1);
    });
  });

  describe("atomicity", () => {
    it("rolls back the status when the history insert fails", async () => {
      const transactionId = await createTransaction(fixture);
      await advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent");

      const before = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      const historyBefore = await getTransactionHistory(transactionId, deps);
      expect(before.status).toBe("PRODUCT_SELECTED");

      // A genuine database failure, injected through the public API rather than
      // a mock: idempotencyKey is VARCHAR(128), so an over-long key passes every
      // application check and then fails on INSERT - after the status UPDATE has
      // already executed inside the same transaction. If the two writes were not
      // atomic, the transaction would be left advanced with no history row.
      await expect(
        advance(
          transactionId,
          "PRODUCT_VERIFICATION_SUCCEEDED",
          "merchant_service",
          "x".repeat(200),
        ),
      ).rejects.toThrow();

      const after = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      const historyAfter = await getTransactionHistory(transactionId, deps);

      // PostgreSQL rolled the whole thing back: status unchanged...
      expect(after.status).toBe("PRODUCT_SELECTED");
      // ...and no orphan history row.
      expect(historyAfter).toHaveLength(historyBefore.length);
      expect(
        historyAfter.filter((h) => h.trigger === "PRODUCT_VERIFICATION_SUCCEEDED"),
      ).toHaveLength(0);
      // The invariant still holds after a failed transition.
      expect(historyAfter.at(-1)?.toStatus).toBe(after.status);
    });

    it("still accepts the same transition once the fault is removed", async () => {
      const transactionId = await createTransaction(fixture);
      await advance(transactionId, "PRODUCT_SELECTION_CONFIRMED", "buyer_agent");
      await expect(
        advance(
          transactionId,
          "PRODUCT_VERIFICATION_SUCCEEDED",
          "merchant_service",
          "y".repeat(200),
        ),
      ).rejects.toThrow();

      // The rollback left the transaction in a state that can still move on.
      const outcome = await advance(
        transactionId,
        "PRODUCT_VERIFICATION_SUCCEEDED",
        "merchant_service",
      );
      expect(outcome.kind).toBe("APPLIED");

      const after = await testDb().transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(after.status).toBe("PRODUCT_VERIFIED");
      const history = await getTransactionHistory(transactionId, deps);
      expect(history).toHaveLength(2);
      expect(history.map((h) => h.sequence)).toEqual([1, 2]);
    });
  });

  describe("persistence across a reconnect", () => {
    it("returns the same state and history from a brand-new connection", async () => {
      const transactionId = await createTransaction(fixture);
      await driveTo(transactionId, "AUTHORIZED");

      await disconnectTestDb();

      const reconnected = freshTestClient();
      try {
        const transaction = await reconnected.transaction.findUniqueOrThrow({
          where: { id: transactionId },
        });
        const history = await getTransactionHistory(transactionId, {
          prisma: reconnected,
        });

        expect(transaction.status).toBe("AUTHORIZED");
        expect(history).toHaveLength(5);
        expect(history.map((h) => h.toStatus)).toEqual([
          "PRODUCT_SELECTED",
          "PRODUCT_VERIFIED",
          "QUOTE_CREATED",
          "POLICY_EVALUATED",
          "AUTHORIZED",
        ]);
        expect(history.at(-1)?.toStatus).toBe(transaction.status);
      } finally {
        await reconnected.$disconnect();
      }
    });
  });
});
