import { z } from "zod";
import { ValidationError } from "@/domain/errors";

/**
 * Branded identifier types.
 *
 * Every entity in this system is keyed by a string, which means a plain
 * `string` signature happily accepts the wrong id. In a payment path that
 * matters: passing a product id where a transaction id belongs would attach a
 * payment to the wrong record. Brands make that a compile error at zero
 * runtime cost.
 */
declare const idBrand: unique symbol;

type Branded<TBrand extends string> = string & { readonly [idBrand]: TBrand };

export type UserId = Branded<"UserId">;
export type MerchantId = Branded<"MerchantId">;
export type ProductId = Branded<"ProductId">;
export type PolicyId = Branded<"PolicyId">;
export type TransactionId = Branded<"TransactionId">;
export type PurchaseQuoteId = Branded<"PurchaseQuoteId">;
export type InventoryReservationId = Branded<"InventoryReservationId">;
export type StateTransitionId = Branded<"StateTransitionId">;
export type PaymentAttemptId = Branded<"PaymentAttemptId">;
export type ApprovalRequestId = Branded<"ApprovalRequestId">;
export type AuditEventId = Branded<"AuditEventId">;
export type DecisionId = Branded<"DecisionId">;
export type WebhookEventId = Branded<"WebhookEventId">;
export type IdempotencyKey = Branded<"IdempotencyKey">;

/** Correlates every log line, decision and audit event of one logical request. */
export type CorrelationId = Branded<"CorrelationId">;

const identifierSchema = z.string().min(1).max(128);

function brand<TBrand extends string>(label: string, value: string): Branded<TBrand> {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError({
      code: "INVALID_IDENTIFIER",
      message: `Value is not a valid ${label}.`,
      details: { identifierType: label },
    });
  }
  return parsed.data as Branded<TBrand>;
}

export const asUserId = (value: string): UserId => brand("UserId", value);
export const asMerchantId = (value: string): MerchantId => brand("MerchantId", value);
export const asProductId = (value: string): ProductId => brand("ProductId", value);
export const asPolicyId = (value: string): PolicyId => brand("PolicyId", value);
export const asTransactionId = (value: string): TransactionId =>
  brand("TransactionId", value);
export const asPurchaseQuoteId = (value: string): PurchaseQuoteId =>
  brand("PurchaseQuoteId", value);
export const asInventoryReservationId = (value: string): InventoryReservationId =>
  brand("InventoryReservationId", value);
export const asStateTransitionId = (value: string): StateTransitionId =>
  brand("StateTransitionId", value);
export const asPaymentAttemptId = (value: string): PaymentAttemptId =>
  brand("PaymentAttemptId", value);
export const asApprovalRequestId = (value: string): ApprovalRequestId =>
  brand("ApprovalRequestId", value);
export const asAuditEventId = (value: string): AuditEventId =>
  brand("AuditEventId", value);
export const asDecisionId = (value: string): DecisionId => brand("DecisionId", value);
export const asWebhookEventId = (value: string): WebhookEventId =>
  brand("WebhookEventId", value);
export const asIdempotencyKey = (value: string): IdempotencyKey =>
  brand("IdempotencyKey", value);
export const asCorrelationId = (value: string): CorrelationId =>
  brand("CorrelationId", value);
