"use client";

import { useActionState, useRef, useState } from "react";
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
  "Find me the best mechanical keyboard under ₹3000 and buy it",
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
      {pending ? "Finding…" : "Find"}
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

const MAX_MESSAGE = 1000;

export function BuyerConsole(): React.JSX.Element {
  const [outcome, action] = useActionState<RequestOutcome, FormData>(submitRequest, {
    kind: "IDLE",
  });

  // The textarea is uncontrolled for typing - React does not need to re-render
  // on every keystroke - but its current length is mirrored here so the counter
  // and the example buttons have something to work with.
  const box = useRef<HTMLTextAreaElement>(null);
  const [length, setLength] = useState(0);

  /**
   * Fills the box from an example and hands focus back to the person.
   *
   * The examples were previously plain list items: they looked like something
   * to press and did nothing at all, which is the worst of both. Filling the
   * field rather than submitting it is deliberate - the person still reads the
   * sentence and presses Find themselves, so nothing is requested on their
   * behalf.
   */
  const fillWithExample = (example: string): void => {
    const node = box.current;
    if (node === null) return;
    node.value = example;
    setLength(example.length);
    node.focus();
    // Caret to the end, so editing the sentence is the obvious next move.
    node.setSelectionRange(example.length, example.length);
  };

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
          ref={box}
          rows={3}
          required
          maxLength={MAX_MESSAGE}
          placeholder="Find me the best mechanical keyboard under ₹3000 and buy it"
          onChange={(event) => {
            setLength(event.currentTarget.value.length);
          }}
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
          <div className="ask-controls">
            <SubmitButton />
            <span
              className={`counter${length > MAX_MESSAGE - 100 ? " near-limit" : ""}`}
              aria-hidden="true"
            >
              {length}/{MAX_MESSAGE}
            </span>
          </div>
        </div>
      </form>

      <Outcome outcome={outcome} />

      <div className="examples">
        <p className="hint" id="examples-label">
          Try one of these
        </p>
        <ul aria-labelledby="examples-label">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  fillWithExample(example);
                }}
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
