"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Waits for the payment provider, so a person does not have to.
 *
 * There is a genuine gap between "this browser's confirmation was verified"
 * and "the provider confirmed the money moved". The second fact arrives on
 * Razorpay's own webhook, out of band, some seconds later - which is exactly
 * why `PAYMENT_VERIFIED` and `PAYMENT_CAPTURED` are separate states.
 *
 * The page used to state that gap and then hand the problem to the reader:
 * "this page does not update by itself - refresh in a moment". That was honest
 * and unhelpful, and it made a working system look stuck. This component
 * closes it by re-reading the server render on a timer until the state moves
 * on.
 *
 * ## What it deliberately does not do
 *
 * It carries no financial authority whatsoever. It sends nothing, decides
 * nothing, and cannot advance a transaction - `router.refresh()` only re-runs
 * the server render, and the server reads the same authoritative row it always
 * did. Polling faster would not make a payment settle sooner, and stopping
 * early does not roll anything back.
 *
 * ## Why it stops
 *
 * A page left open on a desk should not poll a server for ever. After
 * `MAX_ATTEMPTS` it gives up and offers a manual control instead, which is the
 * honest end state: the webhook may be delayed, and the person deserves to be
 * told that rather than watching a spinner that will never resolve.
 */

/** Long enough not to hammer the server, short enough to feel immediate. */
const INTERVAL_MS = 3000;

/** Roughly two minutes of waiting before handing back to the person. */
const MAX_ATTEMPTS = 40;

export function AwaitingProvider(): React.JSX.Element {
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
      // Re-runs the server component above. If the webhook has landed, this
      // render returns a different state and the component unmounts with it.
      router.refresh();
    }, INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [router, gaveUp]);

  if (gaveUp) {
    return (
      <div className="notice neutral awaiting" role="status">
        <div>
          <strong>Still waiting for the provider.</strong>
          <p>
            This is unusual but not lost — the payment provider confirms settlement on its
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
            router.refresh();
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
        <strong>Waiting for the payment provider to confirm…</strong>
        <p>
          This updates by itself — no need to refresh. Razorpay confirms settlement out of
          band, which is why a verified confirmation and a captured payment are two
          separate facts here.
        </p>
      </div>
      <span className="visually-hidden">
        Checked {attempts} {attempts === 1 ? "time" : "times"}.
      </span>
    </div>
  );
}
