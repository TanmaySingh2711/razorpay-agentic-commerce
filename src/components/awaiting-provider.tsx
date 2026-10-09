"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { checkPaymentStatus } from "@/app/actions";

/**
 * Waits for the payment provider, so a person does not have to.
 *
 * There is a genuine gap between "this browser's confirmation was verified"
 * and "the provider confirmed the money moved". The second fact usually
 * arrives on Razorpay's own webhook, out of band, some seconds later - which
 * is exactly why `PAYMENT_VERIFIED` and `PAYMENT_CAPTURED` are separate
 * states. A webhook needs a public address, though, so on a machine it cannot
 * reach the wait would never end; each round therefore also asks the server
 * to check with Razorpay (`checkPaymentStatus`).
 *
 * The page used to state that gap and then hand the problem to the reader:
 * "this page does not update by itself - refresh in a moment". That was honest
 * and unhelpful, and it made a working system look stuck. This component
 * closes it by re-reading the server render on a timer until the state moves
 * on.
 *
 * ## What it deliberately does not do
 *
 * It carries no financial authority whatsoever. It decides nothing and cannot
 * advance a transaction: it sends the purchase id and nothing else, the server
 * asks Razorpay about an order it created itself, and only a capture matching
 * the stored amount moves anything. `router.refresh()` then re-runs the server
 * render, which reads the same authoritative row it always did. Polling faster would not make a payment settle sooner, and stopping
 * early does not roll anything back.
 *
 * ## Why it stops
 *
 * A page left open on a desk should not poll a server for ever. After
 * `MAX_ATTEMPTS` it gives up and offers a manual control instead, which is the
 * honest end state: the webhook may be delayed, and the person deserves to be
 * told that rather than watching a spinner that will never resolve.
 */

/**
 * Long enough not to hammer the server, short enough to feel immediate. Each
 * round also asks Razorpay once, so this keeps well inside the per-minute
 * payment ceiling (15 a minute against a default of 20).
 */
const INTERVAL_MS = 4000;

/** Roughly two and a half minutes of waiting before handing back to the person. */
const MAX_ATTEMPTS = 40;

export function AwaitingProvider({
  transactionId,
}: {
  readonly transactionId: string;
}): React.JSX.Element {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);

  // Held in a ref so the interval callback never closes over a stale count.
  const attemptsRef = useRef(0);

  useEffect(() => {
    if (gaveUp) return undefined;

    const timer = setInterval(() => {
      attemptsRef.current += 1;
      setAttempts(attemptsRef.current);

      if (attemptsRef.current >= MAX_ATTEMPTS) {
        setGaveUp(true);
        return;
      }
      // Ask the provider through the server, then re-run the server component
      // above. If the capture has landed, by either route, this render returns
      // a different state and the component unmounts with it.
      void checkPaymentStatus(transactionId)
        .catch(() => undefined)
        .finally(() => {
          router.refresh();
        });
    }, INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [router, gaveUp, transactionId]);

  if (gaveUp) {
    return (
      <div className="notice neutral awaiting" role="status">
        <div>
          <strong>Still waiting for the provider.</strong>
          <p>
            This is unusual but not lost. The payment provider confirms settlement on its
            own schedule, and this purchase will update whenever that arrives. Nothing has
            been charged twice, and nothing needs to be paid again.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            attemptsRef.current = 0;
            setAttempts(0);
            setGaveUp(false);
            void checkPaymentStatus(transactionId)
              .catch(() => undefined)
              .finally(() => {
                router.refresh();
              });
          }}
        >
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className="notice neutral awaiting" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div>
        <strong>Waiting for the payment provider to confirm</strong>
        <p>
          This updates by itself, so there is no need to refresh. Razorpay confirms
          settlement out of band, which is why a verified confirmation and a captured
          payment are two separate facts here.
        </p>
      </div>
      <span className="visually-hidden">
        Checked {attempts} {attempts === 1 ? "time" : "times"}.
      </span>
    </div>
  );
}
