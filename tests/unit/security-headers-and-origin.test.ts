import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { checkRequestOrigin } from "@/lib/http/same-origin";
import { handleCreatePaymentOrder, handleRetryPayment } from "@/app/api/payments/handler";

/**
 * The two browser-facing protections added by Objective 15.
 *
 * Both are the kind that fail silently when they regress. A header that stops
 * being sent breaks nothing visible; an origin check that starts accepting
 * everything makes every test still pass. So both are asserted directly, and
 * the Razorpay allowances are asserted too — because the way a Content-Security
 * -Policy actually fails in this application is not "an attack got through", it
 * is "the Pay button silently stopped working".
 */

const SELF = "https://shop.example.test";

async function headersFor(path: string): Promise<Map<string, string>> {
  const groups = await nextConfig.headers?.();
  const found = new Map<string, string>();
  for (const group of groups ?? []) {
    // The config uses a single catch-all source; this keeps the test honest if
    // that ever becomes several.
    if (group.source === "/:path*" || group.source === path) {
      for (const header of group.headers)
        found.set(header.key.toLowerCase(), header.value);
    }
  }
  return found;
}

describe("security response headers", () => {
  it("sends the headers that cost nothing and prevent real attacks", async () => {
    const headers = await headersFor("/checkout/abc");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("content-security-policy")).toBeDefined();
  });

  it("makes the page carrying the Pay button un-framable", () => {
    // Clickjacking is the attack that matters most on a page with a payment
    // action: an invisible frame over a button the buyer thinks is something
    // else. Two headers say it, and they must not disagree.
    return headersFor("/").then((headers) => {
      expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(headers.get("x-frame-options")).toBe("DENY");
    });
  });

  it("closes the directives that have no legitimate use here", async () => {
    const csp = (await headersFor("/")).get("content-security-policy") ?? "";
    expect(csp).toContain("object-src 'none'");
    // Stops an injected <base> tag silently rewriting every relative URL.
    expect(csp).toContain("base-uri 'self'");
    // Stops a form posting anything off-site.
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("default-src 'self'");
  });

  it("still allows everything Razorpay Checkout needs", async () => {
    const csp = (await headersFor("/")).get("content-security-policy") ?? "";
    // The script itself, the payment frame, and the calls the frame makes. A
    // policy missing any of these does not fail loudly - it fails as a buyer
    // pressing Pay and nothing happening.
    expect(csp).toMatch(/script-src[^;]*checkout\.razorpay\.com/);
    expect(csp).toMatch(/frame-src[^;]*razorpay\.com/);
    expect(csp).toMatch(/connect-src[^;]*razorpay\.com/);
  });

  it("does not deny the payment permission Checkout may use", async () => {
    // Denying `payment` would harden nothing this application does itself and
    // could stop the Payment Request API the widget relies on.
    const policy = (await headersFor("/")).get("permissions-policy") ?? "";
    expect(policy).not.toContain("payment=()");
  });

  it("never names a secret or an internal host", async () => {
    const headers = await headersFor("/");
    for (const value of headers.values()) {
      expect(value).not.toMatch(/rzp_|secret|prisma\.io|postgres|api[_-]?key/i);
    }
  });
});

describe("state-changing requests from another site", () => {
  it("accepts our own page", () => {
    const request = new Request(`${SELF}/api/payments/retry`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(checkRequestOrigin(request, SELF).allowed).toBe(true);
  });

  it("accepts a directly typed URL or a bookmark", () => {
    const request = new Request(`${SELF}/api/payments/retry`, {
      method: "POST",
      headers: { "sec-fetch-site": "none" },
    });
    expect(checkRequestOrigin(request, SELF).allowed).toBe(true);
  });

  it("refuses a request another website caused", () => {
    // The attack: a page anywhere posts to a retry endpoint using a transaction
    // id it learned. No credential is needed for that request to consume a
    // bounded retry or create a real provider order.
    const request = new Request(`${SELF}/api/payments/retry`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    const verdict = checkRequestOrigin(request, SELF);
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason: "CROSS_SITE" });
  });

  it("refuses a mismatched Origin when Sec-Fetch-Site is absent", () => {
    const request = new Request(`${SELF}/api/payments/order`, {
      method: "POST",
      headers: { origin: "https://attacker.example.test" },
    });
    expect(checkRequestOrigin(request, SELF).allowed).toBe(false);
  });

  it("prefers Sec-Fetch-Site over Origin, because page script cannot set it", () => {
    const request = new Request(`${SELF}/api/payments/order`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", origin: SELF },
    });
    expect(checkRequestOrigin(request, SELF).allowed).toBe(false);
  });

  it("allows a non-browser caller, which is not what this defends against", () => {
    // curl, a server-to-server call, a probe, a test. None of them can be
    // pointed at a victim's browser by a hostile page, and an attacker who
    // controls the client controls these headers anyway.
    const request = new Request(`${SELF}/api/payments/retry`, { method: "POST" });
    expect(checkRequestOrigin(request, SELF)).toMatchObject({
      allowed: true,
      reason: "NON_BROWSER",
    });
  });

  it("does not turn a misconfigured app URL into a total outage", () => {
    // Failing closed here would take the whole site down over a config typo,
    // while the Sec-Fetch-Site check above keeps working regardless.
    const request = new Request(`${SELF}/api/payments/retry`, {
      method: "POST",
      headers: { origin: SELF },
    });
    expect(checkRequestOrigin(request, "not a url").allowed).toBe(true);
    expect(checkRequestOrigin(request, null).allowed).toBe(true);
  });

  it("is not fooled by an origin that merely starts the same", () => {
    const request = new Request(`${SELF}/api/payments/retry`, {
      method: "POST",
      headers: { origin: "https://shop.example.test.attacker.test" },
    });
    expect(checkRequestOrigin(request, SELF).allowed).toBe(false);
  });

  it('treats a literal "null" origin as no origin rather than a match', () => {
    // Sandboxed frames and some redirects send `Origin: null`. It must never be
    // parsed into something that could equal our own.
    const request = new Request(`${SELF}/api/payments/retry`, {
      method: "POST",
      headers: { origin: "null" },
    });
    expect(checkRequestOrigin(request, SELF)).toMatchObject({ reason: "NON_BROWSER" });
  });
});

describe("the guard is actually wired into the payment endpoints", () => {
  /**
   * A throwing proxy for the service dependencies.
   *
   * If the route ever reaches the retry service, this explodes - which is the
   * point. The refusal has to happen before any database work, any policy
   * recheck and certainly any provider call, so the test proves *where* the
   * check runs, not merely that a 4xx came back.
   */
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw new Error("the retry service must not be reached by a cross-site request");
      },
    },
  ) as never;

  it("refuses a cross-site POST before touching the service", async () => {
    const response = await handleRetryPayment(
      new Request("https://shop.example.test/api/payments/retry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ transactionId: "01930000-0000-7000-8000-00000000c001" }),
      }),
      unreachable,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    // Sanitised: a stable public sentence, and nothing about the expected
    // origin, the deployment, or what the server holds.
    expect(JSON.stringify(body)).not.toMatch(/shop\.example|origin|APP_URL/i);
  });

  it("refuses a cross-site order creation before touching the service", async () => {
    // The endpoint that creates a real provider order, and therefore the one
    // that most needs this. It parsed its own body rather than going through
    // the shared reader, so an earlier version of the guard missed it
    // entirely - the reason the reader is now the only door into a body.
    const response = await handleCreatePaymentOrder(
      new Request("https://shop.example.test/api/payments/order", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ transactionId: "01930000-0000-7000-8000-00000000c001" }),
      }),
      unreachable,
    );
    expect(response.status).toBe(400);
  });

  it("keeps the order endpoint's tailored refusal for a bad shape", async () => {
    // Routing it through the shared reader must not have flattened its message
    // into the generic one: "amounts are determined by the server" is the
    // sentence that tells a prober exactly why its `amount` field did nothing.
    const response = await handleCreatePaymentOrder(
      new Request("https://shop.example.test/api/payments/order", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ transactionId: "t", amount: 1 }),
      }),
      unreachable,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/determined by the server/i);
  });

  it("lets a same-origin POST through to the service", async () => {
    // Proven by the service being reached: the proxy throws, the boundary turns
    // that into a 500, and a 500 here means the request passed the guard.
    const response = await handleRetryPayment(
      new Request("https://shop.example.test/api/payments/retry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ transactionId: "01930000-0000-7000-8000-00000000c001" }),
      }),
      unreachable,
    );
    expect(response.status).toBe(500);
  });
});
