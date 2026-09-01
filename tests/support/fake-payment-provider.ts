import type {
  CheckoutSignatureInput,
  PaymentOrderRequest,
  PaymentProvider,
  ProviderLookupOutcome,
  ProviderOrder,
  ProviderOrderOutcome,
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
  const store = new Map<string, ProviderOrder>();
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
  };
}
