"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { submitRequest, type RequestOutcome } from "@/app/actions/purchase";

/**
 * The one input in this application.
 *
 * A buyer types a sentence. Everything after that is the server's decision, and
 * this component holds no part of it — there is no price here, no product id,
 * no policy result and no eligibility. It sends a sentence and renders what it
 * is told.
 *
 * Duplicate submission is prevented the only way that is honest in a browser:
 * the button disables itself while the action is in flight, and the server
 * remains the thing that actually enforces one purchase per request. Disabling
 * a button is a courtesy to the person, never a control.
 */

const EXAMPLES = [
  "Find me a mechanical keyboard under ₹3000",
  "I need a wireless keyboard for the office, budget ₹5000",
  "Show me a compact keyboard with linear switches",
];

function SubmitButton(): React.JSX.Element {
  // `useFormStatus` reads the state of the form this button is inside, which is
  // what makes the disabled state true while the request is genuinely running
  // rather than while a local flag happens to be set.
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="primary" disabled={pending} aria-busy={pending}>
      {pending ? "Thinking…" : "Ask"}
    </button>
  );
}

function Outcome({ outcome }: { outcome: RequestOutcome }): React.JSX.Element | null {
  if (outcome.kind === "IDLE") return null;

  // `role="status"` so a screen reader announces the answer without the person
  // having to go looking for it.
  const tone = outcome.kind === "ERROR" ? "negative" : "neutral";
  return (
    <div className={`notice ${tone}`} role="status" aria-live="polite">
      {outcome.kind === "CLARIFICATION" ? (
        <>
          <strong>One thing first</strong>
          <p>{outcome.question}</p>
        </>
      ) : outcome.kind === "ERROR" ? (
        <>
          <strong>That did not work</strong>
          <p>{outcome.message}</p>
        </>
      ) : (
        <>
          <strong>Nothing was opened</strong>
          <p>{outcome.summary}</p>
        </>
      )}
    </div>
  );
}

export function BuyerConsole(): React.JSX.Element {
  const [outcome, action] = useActionState<RequestOutcome, FormData>(submitRequest, {
    kind: "IDLE",
  });

  return (
    <section className="console" aria-labelledby="ask-heading">
      <h2 id="ask-heading" className="plain">
        What would you like to buy?
      </h2>

      <form action={action} className="ask">
        <label htmlFor="message" className="visually-hidden">
          Describe what you are looking for
        </label>
        <textarea
          id="message"
          name="message"
          rows={3}
          required
          maxLength={1000}
          placeholder="Find me a mechanical keyboard under ₹3000"
          // Enter submits, so the common case needs no mouse at all; Shift+Enter
          // still adds a line for a longer description.
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="ask-actions">
          <p className="hint">
            The assistant can only suggest a product. It cannot set a price, approve a
            purchase, or spend anything.
          </p>
          <SubmitButton />
        </div>
      </form>

      <Outcome outcome={outcome} />

      <div className="examples">
        <p className="hint">Try:</p>
        <ul>
          {EXAMPLES.map((example) => (
            <li key={example}>{example}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
