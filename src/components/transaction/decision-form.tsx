"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import type { DecisionOutcome } from "@/app/actions/purchase";

/**
 * A single server action bound to a single button.
 *
 * Every decision on the transaction page — approve, reject, hold the item — is
 * one of these. They look alike on purpose: each sends a transaction id and
 * nothing else, each disables itself while its request is in flight, and each
 * renders the server's answer rather than an optimistic guess at it.
 *
 * Nothing is applied optimistically. An approval that appeared to succeed and
 * then had not is worse than a moment of waiting, so the button waits for the
 * server and the page re-reads state afterwards.
 *
 * That re-read is real rather than assumed. The server action revalidates the
 * transaction path, and this component asks the router to re-render once the
 * action reports success - without both halves the decision landed in the
 * database while the page kept showing the previous step until someone pressed
 * F5.
 */

type Action = (previous: DecisionOutcome, formData: FormData) => Promise<DecisionOutcome>;

function Button({
  label,
  busyLabel,
  variant,
}: {
  readonly label: string;
  readonly busyLabel: string;
  readonly variant: "primary" | "secondary";
}): React.JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={variant} disabled={pending} aria-busy={pending}>
      {pending ? busyLabel : label}
    </button>
  );
}

export function DecisionForm({
  action,
  transactionId,
  label,
  busyLabel,
  variant = "primary",
  recoveryHref,
  recoveryLabel,
}: {
  readonly action: Action;
  readonly transactionId: string;
  readonly label: string;
  readonly busyLabel: string;
  readonly variant?: "primary" | "secondary";
  /**
   * Where a person goes when this decision cannot be made at all.
   *
   * Some refusals are permanent for *this* transaction - the item sold out, the
   * price lapsed - and a sentence explaining that, with nothing to press, is a
   * dead end. When a recovery route is supplied it is offered as a real control
   * beside the explanation, and only once the server has actually refused.
   */
  readonly recoveryHref?: string;
  readonly recoveryLabel?: string;
}): React.JSX.Element {
  const [outcome, dispatch] = useActionState<DecisionOutcome, FormData>(action, {
    kind: "IDLE",
  });
  const router = useRouter();

  // Refresh exactly once per successful decision. `useActionState` keeps the
  // same outcome object until the next submission, so without the ref this
  // would re-run on every unrelated re-render.
  const refreshedFor = useRef<DecisionOutcome | null>(null);
  useEffect(() => {
    if (outcome.kind !== "DONE" || refreshedFor.current === outcome) return;
    refreshedFor.current = outcome;
    router.refresh();
  }, [outcome, router]);

  return (
    <form action={dispatch} className="decision">
      {/* The complete payload. There is nowhere here to put an amount. */}
      <input type="hidden" name="transactionId" value={transactionId} />
      <Button label={label} busyLabel={busyLabel} variant={variant} />
      {outcome.kind === "IDLE" ? null : (
        <p
          className={outcome.kind === "ERROR" ? "field-error" : "field-done"}
          role="status"
          aria-live="polite"
        >
          {outcome.message}
        </p>
      )}
      {outcome.kind === "ERROR" &&
      recoveryHref !== undefined &&
      recoveryLabel !== undefined ? (
        <p className="recovery-row">
          <Link href={recoveryHref} className="secondary">
            {recoveryLabel}
          </Link>
        </p>
      ) : null}
    </form>
  );
}
