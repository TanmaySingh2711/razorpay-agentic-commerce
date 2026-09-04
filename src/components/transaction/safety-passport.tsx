import type { PassportTone, SafetyPassportViewModel } from "@/domain/safety/passport";

/**
 * The Safety Passport, rendered.
 *
 * A server component with no state, no effects and no decisions. Every string
 * it draws was decided in `@/domain/safety/passport` from persisted rows, which
 * is what makes the panel testable without a browser and impossible to make
 * flattering by editing markup.
 *
 * ## Why the mark is never green by default
 *
 * A summary panel is read as a verdict, so a tick that appears because a row
 * exists rather than because a fact was proven is worse than no panel at all.
 * The glyph here is a function of the tone the domain assigned, and the domain
 * assigns a neutral tone to everything that merely has not happened yet. A
 * pending capture and a confirmed one never look alike.
 *
 * ## It does not replace the timeline
 *
 * The audit timeline below it is the chronological evidence, and stays exactly
 * as it was. This is the thirty-second version for someone who will not read
 * forty rows, and it says nothing the trail does not already contain.
 */

/** One glyph per tone. Decorative — the status word beside it carries meaning. */
const TONE_MARKS: Readonly<Record<PassportTone, string>> = {
  POSITIVE: "✓",
  NEUTRAL: "–",
  WARNING: "!",
  NEGATIVE: "✕",
};

function toneClass(tone: PassportTone): string {
  return tone.toLowerCase();
}

export function SafetyPassport({
  passport,
}: {
  readonly passport: SafetyPassportViewModel;
}): React.JSX.Element {
  return (
    <section className="card passport" aria-labelledby="passport-heading">
      <div className="passport-head">
        <h2 id="passport-heading">{passport.title}</h2>
        <p className="hint">{passport.subtitle}</p>
      </div>

      <div className="authority-grid">
        {[passport.aiAuthority, passport.financialAuthority].map((authority) => (
          <div className="authority" key={authority.label}>
            <p className="authority-label">{authority.label}</p>
            <p className="authority-value">{authority.value}</p>
            <p className="hint">{authority.note}</p>
          </div>
        ))}
      </div>

      <ul className="passport-checks">
        {passport.checks.map((entry) => (
          <li key={entry.id} className={`passport-check ${toneClass(entry.tone)}`}>
            <span className="mark" aria-hidden="true">
              {TONE_MARKS[entry.tone]}
            </span>
            <div className="passport-body">
              <p className="passport-label">
                {entry.label}
                <span className={`badge ${toneClass(entry.tone)}`}>
                  {entry.statusLabel}
                </span>
              </p>
              <p className="passport-value">{entry.value}</p>
              {entry.note === null ? null : <p className="hint">{entry.note}</p>}
            </div>
          </li>
        ))}
      </ul>

      <p className="hint price-source">{passport.priceSource}</p>

      {passport.retry === null ? null : (
        <div className="passport-retry">
          <h3>Retry safety</h3>
          <p className="hint">
            Payment attempts: {String(passport.retry.attemptsUsed)} of{" "}
            {String(passport.retry.maxAttempts)}. The limit is counted from stored attempt
            rows, never from anything a browser sends.
          </p>
          <dl className="passport-rows">
            {passport.retry.rows.map((row) => (
              <div key={row.label} className={toneClass(row.tone)}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <ul className="passport-properties">
        {passport.properties.map((property) => (
          <li
            key={property.label}
            className={property.evidenced ? "evidenced" : "unevidenced"}
          >
            <span className="mark" aria-hidden="true">
              {property.evidenced ? TONE_MARKS.POSITIVE : TONE_MARKS.NEUTRAL}
            </span>
            <div>
              <p className="property-label">{property.label}</p>
              <p className="hint">{property.evidence}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="hint">
        Every line above is derived from this purchase&apos;s own persisted records — its
        quote, its policy evaluation, its approvals, its stock hold, its payment attempts
        and its audit trail. No part of it is written by a language model. The full
        chronological evidence is in <strong>What happened</strong>, below.
      </p>
    </section>
  );
}
