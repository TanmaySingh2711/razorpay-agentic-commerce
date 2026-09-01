"use client";

import { useCallback, useState } from "react";
import {
  loadCheckoutScript,
  type CheckoutFailureResponse,
  type CheckoutSuccessResponse,
} from "@/lib/checkout-script";
import type { CheckoutSessionDto } from "@/domain/payment/checkout";

/**
 * The one place a person decides to spend money.
 *
 * Everything here hangs off a real click. Nothing in this component runs on
 * mount, on render, or in an effect: no session is requested, no script is
 * fetched, and no state moves. That is the whole point — `PAYMENT_PENDING` has
 * to mean "somebody pressed Pay", and a flow that started itself would make the
 * state a lie the first time a crawler or a prefetch touched the page.
 *
 * There is also no way for anything else to trigger it. The agent has no tool
 * that reaches this component, and this component exposes no imperative handle;
 * the only caller is the button's `onClick`.
 *
 * **No card data ever touches this application.** The provider's own checkout
 * collects the instrument in its own frame. There is no card number field here,
 * no CVV field, and nothing to persist — which is exactly why the integration
 * is worth the third-party script.
 */

type Phase =
  | { readonly kind: "IDLE" }
  | { readonly kind: "PREPARING" }
  | { readonly kind: "AWAITING_PAYMENT" }
  | { readonly kind: "VERIFYING" }
  | { readonly kind: "VERIFIED"; readonly paymentId: string }
  | { readonly kind: "DISMISSED" }
  | { readonly kind: "PROBLEM"; readonly message: string };

interface Envelope<TData> {
  readonly data?: TData;
  readonly error?: { readonly message?: string };
}

async function postJson<TData>(url: string, body: unknown): Promise<Envelope<TData>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Envelope<TData>;
}

export function PayButton({
  transactionId,
}: {
  readonly transactionId: string;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "IDLE" });

  const verify = useCallback(
    async (session: CheckoutSessionDto, response: CheckoutSuccessResponse) => {
      setPhase({ kind: "VERIFYING" });
      // Only what the server needs to find its own record and check the
      // signature. The amount is not sent, because the browser has no say in it.
      const verified = await postJson<{
        kind: string;
        providerPaymentId?: string;
        rejection?: string;
      }>("/api/payments/callback", {
        transactionId: session.transactionId,
        paymentAttemptId: session.paymentAttemptId,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_signature: response.razorpay_signature,
      });

      if (verified.data?.kind === "PAYMENT_VERIFIED") {
        setPhase({
          kind: "VERIFIED",
          paymentId: verified.data.providerPaymentId ?? response.razorpay_payment_id,
        });
        return;
      }
      setPhase({
        kind: "PROBLEM",
        message:
          "We could not confirm this payment as genuine. Nothing has been charged to you by us, and support can look it up.",
      });
    },
    [],
  );

  const onPay = useCallback(() => {
    void (async () => {
      setPhase({ kind: "PREPARING" });
      try {
        // The server decides whether checkout may start at all, and it is this
        // call - not the page render - that records that payment has begun.
        const started = await postJson<{
          kind: string;
          session?: CheckoutSessionDto;
          refusal?: string;
        }>("/api/payments/checkout", { transactionId });

        const session = started.data?.session;
        if (started.data?.kind !== "CHECKOUT_READY" || session === undefined) {
          setPhase({
            kind: "PROBLEM",
            message:
              started.data?.refusal === "RESERVATION_NOT_HELD"
                ? "This item is no longer held for you. Please start again."
                : "This purchase is not ready for payment.",
          });
          return;
        }

        const Checkout = await loadCheckoutScript();
        const checkout = new Checkout({
          key: session.providerKeyId,
          amount: session.amountMinor,
          currency: session.currency,
          name: session.merchantName,
          description: session.productName,
          // The order created server-side. The browser never chooses this.
          order_id: session.providerOrderId,
          handler: (response) => {
            void verify(session, response);
          },
          modal: {
            ondismiss: () => {
              setPhase({ kind: "DISMISSED" });
              // Recorded, but it decides nothing: closing a window is not a
              // failed payment, and the server treats it as neither.
              void postJson("/api/payments/dismissed", { transactionId });
            },
          },
        });

        checkout.on("payment.failed", (failure: CheckoutFailureResponse) => {
          // Shown to the person, and nothing more. A browser event is not
          // authority to record a financial outcome; the provider's own
          // reconciliation decides that later.
          setPhase({
            kind: "PROBLEM",
            message:
              failure.error?.description ??
              "The payment did not go through. You have not been charged.",
          });
        });

        setPhase({ kind: "AWAITING_PAYMENT" });
        checkout.open();
      } catch {
        setPhase({
          kind: "PROBLEM",
          message:
            "We could not open the payment window. Check your connection and try again.",
        });
      }
    })();
  }, [transactionId, verify]);

  const busy = phase.kind === "PREPARING" || phase.kind === "VERIFYING";

  return (
    <div>
      <button type="button" onClick={onPay} disabled={busy}>
        {busy ? "Please wait…" : "Pay"}
      </button>
      <p role="status">{describe(phase)}</p>
    </div>
  );
}

function describe(phase: Phase): string {
  switch (phase.kind) {
    case "IDLE":
      return "Press Pay to open the secure payment window.";
    case "PREPARING":
      return "Preparing your payment…";
    case "AWAITING_PAYMENT":
      return "Complete the payment in the window that opened.";
    case "VERIFYING":
      return "Checking that the confirmation is genuine…";
    case "VERIFIED":
      // Careful wording. A verified signature is not a settled payment, and
      // telling someone their order is confirmed here would be a promise this
      // objective cannot keep.
      return `Payment confirmation verified (${phase.paymentId}). We are now waiting for your bank to confirm settlement.`;
    case "DISMISSED":
      return "You closed the payment window. Nothing was charged, and your item is still held for a short while.";
    case "PROBLEM":
      return phase.message;
  }
}
