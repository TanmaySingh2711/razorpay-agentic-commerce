"use client";

import { useActionState } from "react";
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
}: {
  readonly action: Action;
  readonly transactionId: string;
  readonly label: string;
  readonly busyLabel: string;
  readonly variant?: "primary" | "secondary";
}): React.JSX.Element {
  const [outcome, dispatch] = useActionState<DecisionOutcome, FormData>(action, {
    kind: "IDLE",
  });

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
    </form>
  );
}
