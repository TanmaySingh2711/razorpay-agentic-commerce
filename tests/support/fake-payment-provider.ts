import type {
  CheckoutSignatureInput,
  WebhookSignatureInput,
  PaymentOrderRequest,
  PaymentProvider,
  ProviderLookupOutcome,
  ProviderOrder,
  ProviderOrderOutcome,
  ProviderOrderPaymentsOutcome,
  ProviderRefund,
  ProviderRefundLookupOutcome,
  ProviderRefundOutcome,
  RefundRequest,
} from "@/domain/payment/provider";

/**
 * One programmable stand-in for the payment provider, shared by every suite
 * that needs one.
 *
 * Shared rather than copied because it implements a port: the moment two
 * hand-rolled fakes exist, they start disagreeing about what the real adapter
 * does, and a test passing against a drifted fake proves nothing. With one
 * implementation the compiler forces every suite to confront a change to the
 * interface — which is exactly how the checkout signature method announced
 * itself.
 *
 * It records every call, because most of the properties worth proving about
 * payments are negative: that a second order was *not* created, that the
 * client's order id was *not* used to verify a signature. Counting and
 * inspecting calls is how those become assertions instead of hopes.
 */
export interface FakePaymentProvider extends PaymentProvider {
  readonly createRequests: PaymentOrderRequest[];
  readonly lookupReceipts: string[];
  /** Every signature check, so a test can assert which order id was used. */
  readonly verifyInputs: CheckoutSignatureInput[];
  /** Every webhook check, so a test can assert the raw body was passed through. */
  readonly webhookInputs: WebhookSignatureInput[];
  /** Every refund creation, so a test can assert a second one was *not* made. */
  readonly refundRequests: RefundRequest[];
  readonly refundLookups: { providerPaymentId: string; receipt: string }[];
  /** Every payment-status question, so a test can assert which order was asked about. */
  readonly paymentLookups: string[];
}

export interface FakePaymentProviderOptions {
  readonly onCreate?: (request: PaymentOrderRequest) => ProviderOrderOutcome;
  readonly onLookup?: (receipt: string) => ProviderLookupOutcome;
  /**
   * Decides signature checks. Defaults to accepting everything, because the
   * suites that do not exercise verification should not have to care — the real
   * HMAC is proved against the real adapter, not against this.
   */
  readonly onVerify?: (input: CheckoutSignatureInput) => boolean;
  /**
   * Decides webhook signature checks. Defaults to **rejecting**, the opposite
   * of `onVerify`, because a suite that forgets to arrange authentication must
   * fail rather than silently reconcile an unauthenticated event. Verification
   * is the whole control here; defaulting it open would make the tests that
   * matter most vacuous.
   */
  readonly onVerifyWebhook?: (input: WebhookSignatureInput) => boolean;
  readonly onRefund?: (request: RefundRequest) => ProviderRefundOutcome;
  readonly onRefundLookup?: (
    providerPaymentId: string,
    receipt: string,
  ) => ProviderRefundLookupOutcome;
  /**
   * Answers "which payments were made against this order?". Defaults to none:
   * a suite must arrange a captured payment before one can be reported.
   */
  readonly onListOrderPayments?: (
    providerOrderId: string,
  ) => ProviderOrderPaymentsOutcome;
  /** Fixes the order id, instead of issuing a distinct one per creation. */
  readonly providerOrderId?: string;
}

/**
 * The order id the first creation issues.
 *
 * Subsequent creations from the same fake get distinct ids, because the real
 * schema enforces `@@unique([provider, providerOrderId])` - two transactions
 * genuinely cannot share a provider order. A fake that handed out one constant
 * would make a suite arranging two transactions fail inside its own setup, for
 * a reason that has nothing to do with what it was testing.
 */
export const FAKE_PROVIDER_ORDER_ID = "order_TestMode0000001";

export function fakePaymentProvider(
  options: FakePaymentProviderOptions = {},
): FakePaymentProvider {
  const createRequests: PaymentOrderRequest[] = [];
  const lookupReceipts: string[] = [];
  const verifyInputs: CheckoutSignatureInput[] = [];
  const webhookInputs: WebhookSignatureInput[] = [];
  const store = new Map<string, ProviderOrder>();
  const refundRequests: RefundRequest[] = [];
  const refundLookups: { providerPaymentId: string; receipt: string }[] = [];
  const refunds = new Map<string, ProviderRefund>();
  const paymentLookups: string[] = [];
  let refundsIssued = 0;
  let issued = 0;
  const nextOrderId = (): string => {
    if (options.providerOrderId !== undefined) return options.providerOrderId;
    issued += 1;
    return issued === 1
      ? FAKE_PROVIDER_ORDER_ID
      : `order_TestMode${String(issued).padStart(7, "0")}`;
  };

  return {
    name: "RAZORPAY",
    createRequests,
    lookupReceipts,
    verifyInputs,
    webhookInputs,
    refundRequests,
    refundLookups,
    paymentLookups,

    listOrderPayments(providerOrderId) {
      paymentLookups.push(providerOrderId);
      return Promise.resolve(
        options.onListOrderPayments?.(providerOrderId) ?? { kind: "FOUND", payments: [] },
      );
    },

    createRefund(request) {
      refundRequests.push(request);
      const outcome =
        options.onRefund?.(request) ??
        (() => {
          refundsIssued += 1;
          return {
            kind: "CREATED",
            refund: {
              providerRefundId: `rfnd_TestMode${String(refundsIssued).padStart(7, "0")}`,
              providerPaymentId: request.providerPaymentId,
              amountMinor: request.amountMinor,
              currency: request.currency,
              receipt: request.receipt,
              status: "processed",
            },
          } satisfies ProviderRefundOutcome;
        })();
      if (outcome.kind === "CREATED" || outcome.kind === "ALREADY_EXISTS") {
        refunds.set(request.receipt, outcome.refund);
      }
      return Promise.resolve(outcome);
    },

    findRefundByReceipt(providerPaymentId, receipt) {
      refundLookups.push({ providerPaymentId, receipt });
      if (options.onRefundLookup !== undefined) {
        return Promise.resolve(options.onRefundLookup(providerPaymentId, receipt));
      }
      const found = refunds.get(receipt);
      return Promise.resolve(
        found === undefined
          ? ({ kind: "NOT_FOUND" } as const)
          : ({ kind: "FOUND", refund: found } as const),
      );
    },

    createOrder(request) {
      createRequests.push(request);
      const outcome =
        options.onCreate?.(request) ??
        ({
          kind: "CREATED",
          order: {
            providerOrderId: nextOrderId(),
            amountMinor: request.amountMinor,
            currency: request.currency,
            receipt: request.receipt,
            status: "created",
          },
        } satisfies ProviderOrderOutcome);
      if (outcome.kind === "CREATED" || outcome.kind === "ALREADY_EXISTS") {
        store.set(request.receipt, outcome.order);
      }
      return Promise.resolve(outcome);
    },

    findOrderByReceipt(receipt) {
      lookupReceipts.push(receipt);
      if (options.onLookup !== undefined) {
        return Promise.resolve(options.onLookup(receipt));
      }
      const found = store.get(receipt);
      return Promise.resolve(
        found === undefined
          ? ({ kind: "NOT_FOUND" } as const)
          : ({ kind: "FOUND", order: found } as const),
      );
    },

    verifyCheckoutSignature(input) {
      verifyInputs.push(input);
      return options.onVerify?.(input) ?? true;
    },

    verifyWebhookSignature(input) {
      webhookInputs.push(input);
      return options.onVerifyWebhook?.(input) ?? false;
    },
  };
}
