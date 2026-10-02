/**
 * Refusing state-changing requests that a different site caused.
 *
 * ## The actual threat, stated honestly
 *
 * This application has no cookies, no session and no login, so it has no
 * classical CSRF exposure: there is no ambient credential for another site to
 * ride on. That is exactly why this file is small and why it does not introduce
 * a token, a secret or a round trip — ceremony aimed at a threat that is not
 * there would be worse than nothing, because it would look like protection.
 *
 * What *is* real is cross-site abuse of unauthenticated state-changing
 * endpoints. Anyone who learns a transaction id — from a shared screen, a
 * referrer, a support ticket, a URL in someone's history — can host a page that
 * silently posts to `/api/payments/retry` or `/api/payments/order` from a
 * visitor's browser. No credential is needed for those requests to consume a
 * bounded retry, create a real provider order, or move a transaction. The
 * server-side gates still hold: the amount comes from the persisted quote, the
 * attempt limit is counted from rows, and policy and approval are re-run. So
 * the damage is bounded — but "bounded" is not "intended", and a purchase step
 * driven by a page the buyer never visited is not a thing this system should
 * allow.
 *
 * ## What is checked, in order
 *
 * `Sec-Fetch-Site` first. It is set by the browser, cannot be set by page
 * script, and says directly what this request's relationship to us is. It is
 * the strongest available signal and needs no configuration.
 *
 * `Origin` second, for browsers or clients that did not send the first. It is
 * also unsettable by page script for these requests, and is compared against
 * the origin this deployment actually answers on.
 *
 * ## Why a request with neither header is allowed
 *
 * Because it is not a browser, and this is a browser-driven attack. `curl`, a
 * server-to-server caller, a test and a health probe send neither header, and
 * none of them can be aimed at a victim's browser by a hostile page. Rejecting
 * them would break legitimate non-browser use while stopping nothing: an
 * attacker who controls the client controls these headers anyway. The value of
 * this check is entirely that it constrains *real browsers*, which enforce the
 * headers faithfully and are the only thing a cross-site page can drive.
 *
 * The payment **webhook** is deliberately not guarded here. It is a
 * machine-to-machine call from Razorpay carrying no browser headers, and its
 * authenticity comes from an HMAC over the raw body — which is a far stronger
 * claim than any origin header could make.
 */

/** The verdict, as a value rather than a thrown error, so callers decide. */
export type OriginVerdict =
  | { readonly allowed: true; readonly reason: "SAME_ORIGIN" | "NON_BROWSER" }
  | { readonly allowed: false; readonly reason: "CROSS_SITE"; readonly site: string };

/**
 * Values of `Sec-Fetch-Site` that are not another website acting on us.
 *
 * `none` is a directly typed URL or a bookmark. `same-origin` is our own page.
 * `same-site` is a sibling host under one registrable domain — accepted because
 * a deployment may legitimately serve its API from one, and rejecting it would
 * break that without preventing anything a hostile third party can do.
 */
const ACCEPTABLE_SITES = new Set(["same-origin", "same-site", "none"]);

function originOf(value: string | null): string | null {
  if (value === null || value.length === 0 || value === "null") return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Decides whether a state-changing request may proceed.
 *
 * `selfOrigin` is the origin this deployment answers on. It is passed in rather
 * than read here so this stays a pure function — the same reason every other
 * decision in this codebase is testable without an environment.
 */
export function checkRequestOrigin(
  request: Request,
  selfOrigin: string | null,
): OriginVerdict {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site.length > 0) {
    return ACCEPTABLE_SITES.has(site.toLowerCase())
      ? { allowed: true, reason: "SAME_ORIGIN" }
      : { allowed: false, reason: "CROSS_SITE", site: site.toLowerCase() };
  }

  const origin = originOf(request.headers.get("origin"));
  if (origin === null) return { allowed: true, reason: "NON_BROWSER" };

  const expected = originOf(selfOrigin);
  // An unparseable or absent configured origin cannot be used to reject: it
  // would turn a configuration mistake into a total outage of every browser
  // request. The Sec-Fetch-Site check above is unaffected by it.
  if (expected === null) return { allowed: true, reason: "NON_BROWSER" };

  return origin === expected
    ? { allowed: true, reason: "SAME_ORIGIN" }
    : { allowed: false, reason: "CROSS_SITE", site: origin };
}
