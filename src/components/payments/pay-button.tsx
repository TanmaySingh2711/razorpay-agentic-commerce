"use client";

import { useRouter } from "next/navigation";
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
  | { readonly kind: "REQUESTING_RETRY" }
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

/**
 * How the button behaves, and it is the server that decides which is offered.
 *
 * `RETRY` differs from `PAY` by exactly one extra step: it asks the server for
 * permission first. Everything after that - the checkout session, the provider
 * script, the callback verification - is the same code, because a retry
 * payment is an ordinary payment against a new attempt and must not develop its
 * own quietly different path.
 */
export type PayMode = "PAY" | "RETRY";

export function PayButton({
  transactionId,
  mode = "PAY",
  attemptsUsed,
  maxAttempts,
}: {
  readonly transactionId: string;
  readonly mode?: PayMode;
  /**
   * Shown to the person, never used to decide anything.
   *
   * The limit is enforced by counting persisted PaymentAttempt rows on the
   * server. These two numbers exist so the button can say "attempt 2 of 3"; if
   * they were wrong, or absent, or edited in a browser console, the only effect
   * would be a misleading label - the retry request carries neither of them.
   */
  readonly attemptsUsed?: number;
  readonly maxAttempts?: number;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "IDLE" });
  const router = useRouter();

  /**
   * Re-reads the server-rendered journey after something has actually moved.
   *
   * This component owns a local phase for the *checkout window*, but the page
   * around it is a server component reading the authoritative transaction
   * state. Without this the two drift apart the moment a payment lands: the
   * button says verified while the timeline above it still shows the previous
   * step, and only F5 reconciled them. `router.refresh()` re-runs the server
   * render in place, keeping the local phase message intact.
   *
   * It is deliberately never a source of truth - it asks the server what
   * happened, it does not tell the server anything.
   */
  const rereadServerState = useCallback(() => {
    router.refresh();
  }, [router]);

  const verify = useCallback(
    async (session: CheckoutSessionDto, response: CheckoutSuccessResponse) => {
      setPhase({ kind: "VERIFYING" });
      try {
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
          // The transaction has moved to PAYMENT_VERIFIED server-side. Re-read
          // so the journey above updates itself instead of waiting for F5.
          rereadServerState();
          return;
        }
        setPhase({
          kind: "PROBLEM",
          message:
            "We could not confirm this payment as genuine. The page below re-reads the authoritative record, and support can look it up.",
        });
        // Outcome unknown here, which is exactly why the server is asked.
        rereadServerState();
      } catch {
        // This point is reached *after* the person paid, so the one thing that
        // must not be said here is "nothing was charged". A dropped connection
        // or a non-JSON error response means we do not know the outcome, not
        // that there was none - and the provider's own webhook will reconcile
        // it regardless of what this browser managed to send. Without this
        // catch the promise simply rejected and the button sat on "Verifying"
        // for ever, which is the worst of both: no answer and no way forward.
        setPhase({
          kind: "PROBLEM",
          message:
            "Your payment may well have gone through - we just could not confirm it from this page. Do not pay again. Open this purchase to see the confirmed outcome.",
        });
      }
    },
    [rereadServerState],
  );

  const onPay = useCallback(() => {
    void (async () => {
      try {
        if (mode === "RETRY") {
          setPhase({ kind: "REQUESTING_RETRY" });
          // The server decides whether a retry is permitted at all. Only a
          // transaction id is sent: there is no retry count, no amount and no
          // order id in this request, so nothing here can influence what is
          // charged or how many attempts are allowed.
          const retried = await postJson<{ kind: string; denial?: string }>(
            "/api/payments/retry",
            { transactionId },
          );
          if (retried.data?.kind !== "RETRY_STARTED") {
            setPhase({
              kind: "PROBLEM",
              message:
                retried.data?.kind === "ORDER_NOT_READY"
                  ? "We could not prepare another payment just now. Please try again in a moment."
                  : retried.data?.kind === "APPROVAL_REQUIRED"
                    ? // The retry found the price had changed and re-quoted it,
                      // but the new amount needs a person's approval before it
                      // can be paid - the same rule a first purchase above the
                      // spending ceiling already follows. The approve/reject
                      // prompt now appears on its own; this click cannot itself
                      // proceed.
                      "The price for this purchase changed and now needs your approval. The approval prompt is below."
                    : "This purchase cannot be paid again - the current state is shown below.",
            });
            rereadServerState();
            return;
          }
        } else {
          // A first payment needs its Razorpay order created before a checkout
          // session can be started for it - the same two-step shape RETRY uses
          // above, just without a prior failure to gate it. This is the step
          // that used to be missing entirely: the item card offers Pay as soon
          // as the hold succeeds (state INVENTORY_RESERVED), but nothing had
          // ever asked the server to create the order that session depends on,
          // so `startCheckout` below found none and refused every click with a
          // generic "not ready" - even though the hold and the quote were both
          // still perfectly good.
          //
          // Safe to call unconditionally: the server's claim is idempotent and
          // converges on an order that already exists rather than creating a
          // second one, so this is a no-op on a retried click or a refreshed
          // page that is already past this state.
          setPhase({ kind: "PREPARING" });
          const prepared = await postJson<{ kind: string; refusal?: string }>(
            "/api/payments/order",
            { transactionId },
          );
          if (prepared.data?.kind !== "ORDER_CREATED") {
            setPhase({
              kind: "PROBLEM",
              message:
                prepared.data?.refusal === "RESERVATION_EXPIRED" ||
                prepared.data?.refusal === "NO_ACTIVE_RESERVATION"
                  ? "This item is no longer held for you. Please start again."
                  : "We could not prepare this payment just now. Please try again in a moment.",
            });
            return;
          }
        }

        setPhase({ kind: "PREPARING" });
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
              rereadServerState();
              // Recorded, but it decides nothing: closing a window is not a
              // failed payment, and the server treats it as neither.
              // Fire and forget, and genuinely forgotten: this call decides
              // nothing, so a failure must not surface as an unhandled
              // rejection in the person's console.
              void postJson("/api/payments/dismissed", { transactionId }).catch(
                () => undefined,
              );
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
          // A failed attempt is now recorded, and the retry affordance below
          // depends on it. Re-read rather than making the buyer refresh.
          rereadServerState();
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
  }, [transactionId, mode, verify, rereadServerState]);

  // Disabling the button while a request is in flight is a courtesy to the
  // person, not a control. Two clicks that both get through converge on one
  // retry and one payment attempt, because the server settles that with a
  // unique claim in PostgreSQL rather than trusting the browser to behave.
  const busy =
    phase.kind === "PREPARING" ||
    phase.kind === "VERIFYING" ||
    phase.kind === "REQUESTING_RETRY";

  const label =
    mode === "RETRY" && attemptsUsed !== undefined && maxAttempts !== undefined
      ? `Retry payment (attempt ${String(Math.min(attemptsUsed + 1, maxAttempts))} of ${String(maxAttempts)})`
      : mode === "RETRY"
        ? "Retry payment"
        : "Pay";

  return (
    <div>
      <button type="button" onClick={onPay} disabled={busy}>
        {busy ? "Please wait…" : label}
      </button>
      <p role="status">{describe(phase, mode)}</p>
    </div>
  );
}

function describe(phase: Phase, mode: PayMode): string {
  switch (phase.kind) {
    case "IDLE":
      return mode === "RETRY"
        ? "Press Retry payment to try again. You have not been charged for the attempt that failed."
        : "Press Pay to open the secure payment window.";
    case "REQUESTING_RETRY":
      return "Checking whether this purchase can be paid again…";
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
