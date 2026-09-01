import { PayButton } from "@/components/payments/pay-button";

/**
 * The checkout page for one transaction.
 *
 * Deliberately inert. It reads no database, starts no session, and moves no
 * state - it renders a button and passes an identifier. Every decision about
 * whether this purchase may be paid for happens on the server, when a person
 * actually presses Pay.
 *
 * That split is what makes `PAYMENT_PENDING` mean something. If this page
 * fetched a checkout session while rendering, the state would also be reached
 * by a refresh, a prefetch or a link preview.
 */
export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ transactionId: string }>;
}) {
  const { transactionId } = await params;

  return (
    <main>
      <h1>Complete your payment</h1>
      <p>
        The amount, the item and the order were all fixed by the server before you got
        here. Nothing on this page can change what you are charged.
      </p>
      <PayButton transactionId={transactionId} />
      <p className="tagline">Razorpay Test Mode — no real money moves.</p>
    </main>
  );
}
