import type { MoneyDto } from "@/domain/money";
import type { QuoteInvalidationReason } from "@/domain/quote/rules";
import type { PolicyDecisionDto } from "@/domain/policy/decision";
import type { TransactionState } from "@/domain/transaction/states";

/**
 * What the approval gate answers.
 *
 * The refusals matter more than the success, and they are enumerated rather
 * than collapsed into a boolean because they mean genuinely different things to
 * whoever is waiting: "your token is wrong" is a security event, "the price
 * moved" is an ordinary shopping event that a fresh quote fixes, and "your
 * policy now forbids this" is neither.
 */

/** Why an approval could not be created. */
export const APPROVAL_REQUEST_REFUSALS = [
  /** The transaction is not awaiting a human. Nothing to approve. */
  "NOT_AWAITING_APPROVAL",
  /** No policy evaluation is on record, so nothing established that a human was needed. */
  "NO_RECORDED_EVALUATION",
  /** The transaction has no live quote, so there is no amount to bind to. */
  "NO_ACTIVE_QUOTE",
  /** The quote lapsed or the product moved. Re-quote before asking a person. */
  "QUOTE_NOT_USABLE",
] as const;

export type ApprovalRequestRefusal = (typeof APPROVAL_REQUEST_REFUSALS)[number];

/** Why a presented approval did not authorize anything. */
export const APPROVAL_DECISION_REFUSALS = [
  /** No approval matches this token. Includes a forged or mistyped one. */
  "UNKNOWN_TOKEN",
  /** The approval was already consumed, rejected or expired. Single use means single use. */
  "ALREADY_SETTLED",
  /** The window closed before the person answered. */
  "EXPIRED",
  /** The approval names a quote that is no longer the transaction's live one. */
  "QUOTE_MISMATCH",
  /** The live quote no longer matches the amount or currency a human agreed to. */
  "AMOUNT_MISMATCH",
  /** The quote lapsed, was re-priced, or its product became unavailable. */
  "QUOTE_NOT_USABLE",
  /** Re-evaluated now, policy refuses this purchase outright. A person cannot override that. */
  "POLICY_NOW_BLOCKS",
  /** The buyer's policy was revised after the approval was issued. */
  "POLICY_VERSION_CHANGED",
  /** The transaction left APPROVAL_REQUIRED while the question was open. */
  "TRANSACTION_NOT_AWAITING_APPROVAL",
  /** Someone other than the buyer the approval was issued to presented it. */
  "NOT_THE_BUYER",
] as const;

export type ApprovalDecisionRefusal = (typeof APPROVAL_DECISION_REFUSALS)[number];

/**
 * An approval as it is safe to show a person.
 *
 * Note what is absent: the token. Nothing that reads an approval back ever
 * returns the credential, so no logging middleware, error serializer or debug
 * endpoint can leak it by accident.
 */
export interface ApprovalRequestDto {
  readonly id: string;
  readonly transactionId: string;
  readonly quoteId: string;
  /**
   * The exact total a person is being asked to agree to.
   *
   * There is deliberately no `quantity` here. An ApprovalRequest binds to the
   * total, not to a line count, and the quantity lives on the quote this names
   * - so reporting one would mean either an extra join or, worse, a number
   * invented to fill the field.
   */
  readonly requestedAmount: MoneyDto;
  readonly policyVersion: number;
  readonly policyLimit: MoneyDto;
  readonly reasonCode: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type ApprovalRequestResult =
  | {
      readonly kind: "APPROVAL_REQUESTED";
      readonly approval: ApprovalRequestDto;
      /**
       * The plaintext token, returned exactly once.
       *
       * The only moment it exists outside the human's hands. It is never
       * persisted, never logged, and never returned by any other operation.
       */
      readonly token: string;
    }
  | {
      /**
       * A live approval is already awaiting this person's answer.
       *
       * Not an error, and deliberately not a token re-issue: the plaintext is
       * never stored, so it cannot be handed out twice, and minting a
       * replacement would silently invalidate the one already sent to the
       * human - letting any repeated call cancel a pending approval.
       */
      readonly kind: "APPROVAL_ALREADY_PENDING";
      readonly approval: ApprovalRequestDto;
    }
  | {
      readonly kind: "APPROVAL_NOT_REQUIRED";
      readonly transactionId: string;
      readonly refusal: ApprovalRequestRefusal;
      readonly transactionState: TransactionState;
      readonly reasons: readonly QuoteInvalidationReason[];
    };

export type ApprovalDecisionResult =
  | {
      readonly kind: "AUTHORIZED";
      readonly transactionId: string;
      readonly approvalId: string;
      readonly quoteId: string;
      readonly authorizedAmount: MoneyDto;
      /** The freshly re-derived policy decision the authorization rests on. */
      readonly policy: PolicyDecisionDto;
      readonly transactionState: TransactionState;
    }
  | {
      readonly kind: "REJECTED";
      readonly transactionId: string;
      readonly approvalId: string;
      readonly transactionState: TransactionState;
    }
  | {
      readonly kind: "REFUSED";
      readonly transactionId: string | null;
      readonly approvalId: string | null;
      readonly refusal: ApprovalDecisionRefusal;
      /** Structured context. Never a token, never SQL, never provider detail. */
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
      readonly reasons: readonly QuoteInvalidationReason[];
    };
