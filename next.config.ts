import type { NextConfig } from "next";

/**
 * Security response headers.
 *
 * Everything here is a browser-enforced constraint on what a page served by
 * this application is allowed to do. They are declared in one place, applied to
 * every route, and written out rather than generated so that reading this file
 * tells you exactly what a browser will be told.
 *
 * ## The Razorpay constraint
 *
 * Checkout is a third-party script that opens a payment frame. A policy that
 * forgot it would not fail loudly — it would fail as a buyer clicking Pay and
 * nothing happening. So the origins Checkout needs are listed explicitly:
 *
 *  - `checkout.razorpay.com` serves the script itself;
 *  - `api.razorpay.com` and `*.razorpay.com` serve the payment frame;
 *  - the same hosts receive the XHR the frame makes;
 *  - `cdn.razorpay.com` and `*.rzp.io` serve its images and fonts.
 *
 * ## Why `script-src` still allows inline
 *
 * Next.js App Router inlines its streaming payload as `self.__next_f.push(...)`
 * script tags, and this project prerenders several pages at build time. A nonce
 * has to be generated per request, which means every page would have to become
 * dynamically rendered to carry one — a real cost, and a change to rendering
 * behaviour rather than to security posture. Rather than pretend otherwise:
 * `'unsafe-inline'` is present for scripts, so this CSP does not by itself stop
 * an injected inline script.
 *
 * What it does still do is substantial, and is the reason it is here: no script
 * may be *loaded* from a host that is not listed, `object-src 'none'` removes
 * the plugin vector entirely, `base-uri 'self'` stops a `<base>` tag rewriting
 * every relative URL on the page, `form-action 'self'` stops a form posting
 * credentials off-site, and `frame-ancestors 'none'` makes the checkout page
 * un-framable, which is the clickjacking defence that matters most on a page
 * with a Pay button. The upgrade path — nonces with dynamic rendering — is a
 * deliberate later decision, not an oversight.
 */
const RAZORPAY_HOSTS = "https://*.razorpay.com https://checkout.razorpay.com";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // See the note above: inline is required by the framework's streaming payload.
  `script-src 'self' 'unsafe-inline' ${RAZORPAY_HOSTS}`,
  // React and the checkout widget both inject style attributes at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://cdn.razorpay.com https://*.rzp.io https://*.razorpay.com",
  "font-src 'self' data: https://cdn.razorpay.com https://*.razorpay.com",
  // Checkout reports telemetry and completes payments over these.
  `connect-src 'self' ${RAZORPAY_HOSTS} https://lumberjack.razorpay.com https://lumberjack-cx.razorpay.com`,
  // The payment frame. Without this, pressing Pay opens nothing.
  `frame-src ${RAZORPAY_HOSTS}`,
  // Nobody may frame us. The page carrying the Pay button is the one that must
  // never be wrapped in someone else's chrome.
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * Sent only over HTTPS deployments.
 *
 * Asserting HSTS from a local `http://localhost:3000` would pin a developer's
 * browser to HTTPS for a host that does not serve it, which breaks development
 * in a way that is tedious to undo. Vercel serves this application over HTTPS,
 * so the header belongs to the production build only.
 */
const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains; preload";

/**
 * Whether this deployment actually answers over HTTPS.
 *
 * Read from the configured application URL rather than from `NODE_ENV`, because
 * it is the *correct* signal: HSTS is about the transport, not the build mode,
 * and RFC 6797 says a host must not send it over a non-secure connection. A
 * production build served over plain HTTP on a developer machine must not pin
 * that host to HTTPS.
 *
 * This is the one place outside `src/config` that reads `process.env`, and the
 * reason is mechanical rather than a preference: Next.js loads this file with
 * its own TypeScript loader, which does not resolve the `@/*` path aliases the
 * config boundary is written in, so importing it here fails the build. The
 * ESLint exemption is scoped to this single file and to nothing else.
 */
function servesHttps(): boolean {
  try {
    // eslint-disable-next-line no-restricted-syntax -- see the note above.
    const url = process.env["APP_URL"];
    return url !== undefined && new URL(url).protocol === "https:";
  } catch {
    // A malformed URL is not evidence of HTTPS, and a build must not fail over
    // a header. Fail closed on the assertion, not on the build.
    return false;
  }
}

const nextConfig: NextConfig = {
  async headers() {
    const https = servesHttps();
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          // No MIME sniffing. A JSON error body must never be executed as script.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Transaction ids live in URLs. They must not leak to third parties
          // through a referrer, and they must not leave HTTPS at all.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // This application needs none of these. Denying them means an injected
          // script cannot reach them either.
          {
            key: "Permissions-Policy",
            value:
              // `payment` is deliberately absent: Razorpay Checkout may use the
              // Payment Request API, and denying it would break paying rather
              // than harden anything this application does itself.
              "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()",
          },
          // Redundant beside frame-ancestors, kept for browsers that honour only
          // this one. They agree, so there is no ambiguity to resolve.
          { key: "X-Frame-Options", value: "DENY" },
          ...(https
            ? [{ key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
