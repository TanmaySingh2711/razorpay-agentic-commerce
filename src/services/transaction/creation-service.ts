import { assertServerOnly } from "@/lib/server-only";
import { getPrismaClient } from "@/integrations/persistence/client";
import {
  INITIAL_TRANSACTION_STATE,
  type InitialTransactionState,
} from "@/domain/transaction/states";
import { TransactionCreationFailureError } from "@/domain/transaction/errors";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The ONLY sanctioned way to bring a transaction into existence.
 *
 * The transition matrix governs every change *after* a transaction exists, but
 * it cannot govern creation: there is no prior state to transition from, so
 * there is no edge to check. Creation is therefore its own boundary, and this
 * module is it.
 *
 * The two rules it exists to make unavoidable:
 *
 *  1. **A transaction is always born at `INTENT_RECEIVED`.** The status is
 *     written here as a constant, and the command type has no status field at
 *     all - so no caller, and no AI-produced payload deserialized into a
 *     command, can start a transaction part-way down the lifecycle and skip the
 *     controls in between. Starting at `AUTHORIZED` would be a complete bypass
 *     of policy evaluation, approval and quoting in a single object literal.
 *
 *  2. **Nothing financial is set at creation.** Product, authorized amount and
 *     currency are deliberately absent from the command. Those facts are
 *     established later by the services that verify them, and they are written
 *     as part of the transition that establishes them - never smuggled in at
 *     birth alongside an unverified agent claim.
 *
 * Lifecycle changes from here on belong to `applyTransactionEvent()` in
 * `./transition-service`. Both boundaries are enforced by ESLint, not by
 * convention - see `eslint.config.mjs` and docs/17-transaction-state-machine.md.
 *
 * Server-only: it asserts on import, and it depends on the persistence client,
 * which asserts as well.
 */
assertServerOnly("src/services/transaction/creation-service.ts");

/**
 * Everything needed to open a transaction, and nothing more.
 *
 * Note what is *not* here: `status`, `productId`, `authorizedAmount`,
 * `currency`, `completedAt`. Their absence is the control.
 */
export interface CreateTransactionCommand {
  readonly buyerProfileId: string;
  readonly merchantId: string;
  /** Ties every later log line, audit event and decision to one logical request. */
  readonly correlationId?: string;
}

export interface CreatedTransaction {
  readonly id: string;
  /** Always the initial state. Typed as such so a caller cannot assume otherwise. */
  readonly status: InitialTransactionState;
  readonly createdAt: Date;
}

export interface TransactionCreationDeps {
  readonly prisma: PrismaClient;
}

function defaultDeps(): TransactionCreationDeps {
  return { prisma: getPrismaClient() };
}

/**
 * Opens a new transaction in `INTENT_RECEIVED`.
 *
 * A missing buyer or merchant is rejected by the database's foreign keys rather
 * than by a pre-flight read: the check-then-insert version has a race, and the
 * constraint does not.
 */
export async function createTransaction(
  command: CreateTransactionCommand,
  deps: TransactionCreationDeps = defaultDeps(),
): Promise<CreatedTransaction> {
  const { buyerProfileId, merchantId, correlationId } = command;

  try {
    const created = await deps.prisma.transaction.create({
      data: {
        buyerProfileId,
        merchantId,
        // Written explicitly rather than left to the column default: the
        // guarantee should hold even if the schema default is ever changed.
        status: INITIAL_TRANSACTION_STATE,
        ...(correlationId === undefined ? {} : { correlationId }),
      },
      select: { id: true, status: true, createdAt: true },
    });

    return {
      id: created.id,
      status: INITIAL_TRANSACTION_STATE,
      createdAt: created.createdAt,
    };
  } catch (error) {
    throw new TransactionCreationFailureError({
      buyerProfileId,
      merchantId,
      cause: error,
    });
  }
}
