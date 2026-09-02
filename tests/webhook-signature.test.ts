import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";
import { processWebhook } from "@/services/payment/webhook-service";
import { fakePaymentProvider } from "./support/fake-payment-provider";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Webhook authentication, proved against the real adapter.
 *
 * This is the control the entire objective rests on. A webhook is the only
 * message in this system that can assert money moved, and the only thing
 * standing between "Razorpay said so" and "a stranger said so" is this HMAC.
 * So it is tested against the real implementation with a real secret, never
 * against a fake that returns true.
 *
 * The tests below are mostly negative, on purpose. Proving a correct signature
 * is accepted is easy and nearly worthless; what matters is the long tail of
 * ways a forged, malformed or replayed message could be let through.
 */

const WEBHOOK_SECRET = "webhook-secret-for-tests-only";
const OTHER_SECRET = "a-different-webhook-secret";

const provider = createRazorpayProvider({
  keyId: "rzp_test_unit",
  keySecret: "unit-test-api-secret",
  webhookSecret: WEBHOOK_SECRET,
});

const sign = (rawBody: string, secret = WEBHOOK_SECRET): string =>
  createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

const BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: { id: "pay_X", order_id: "order_X", amount: 1000, currency: "INR" },
    },
  },
});

describe("webhook signature verification", () => {
  it("accepts a signature made with the webhook secret over the exact body", () => {
    expect(
      provider.verifyWebhookSignature({ rawBody: BODY, signature: sign(BODY) }),
    ).toBe(true);
  });

  it("refuses a signature made with a different secret", () => {
    expect(
      provider.verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY, OTHER_SECRET),
      }),
    ).toBe(false);
  });

  it("refuses a signature made with the API key secret", () => {
    // The two credentials are not interchangeable. Signing a webhook with the
    // key secret is a plausible implementation slip, and it must fail.
    expect(
      provider.verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY, "unit-test-api-secret"),
      }),
    ).toBe(false);
  });

  it("refuses a body modified after it was signed", () => {
    const signature = sign(BODY);
    const tampered = BODY.replace('"amount":1000', '"amount":1');
    expect(tampered).not.toBe(BODY);
    expect(provider.verifyWebhookSignature({ rawBody: tampered, signature })).toBe(false);
  });

  it("refuses a re-serialisation that is equal as JSON but different as bytes", () => {
    // The reason the raw body must be preserved end to end. These two strings
    // parse to the same object and hash differently, so a handler that parsed
    // and re-encoded before verifying would reject authentic Razorpay events.
    const signature = sign(BODY);
    const reserialised = JSON.stringify(JSON.parse(BODY) as unknown, null, 2);
    expect(JSON.parse(reserialised)).toEqual(JSON.parse(BODY));
    expect(reserialised).not.toBe(BODY);
    expect(provider.verifyWebhookSignature({ rawBody: reserialised, signature })).toBe(
      false,
    );
  });

  describe("malformed signatures fail closed rather than throwing", () => {
    // `timingSafeEqual` throws on unequal buffer lengths, and `Buffer.from(x,
    // "hex")` truncates rather than refusing bad input. Either one, unguarded,
    // turns the verifier into a way to crash the endpoint or to slip past it.
    for (const [label, signature] of [
      ["empty", ""],
      ["too short", "abc123"],
      ["one character short", "a".repeat(63)],
      ["one character long", "a".repeat(65)],
      ["not hex", "z".repeat(64)],
      ["hex with spaces", `${" ".repeat(2)}${"a".repeat(62)}`],
      ["json", '{"signature":"a"}'],
      ["very long", "a".repeat(10_000)],
    ] as const) {
      it(`refuses a ${label} signature`, () => {
        expect(() =>
          provider.verifyWebhookSignature({ rawBody: BODY, signature }),
        ).not.toThrow();
        expect(provider.verifyWebhookSignature({ rawBody: BODY, signature })).toBe(false);
      });
    }
  });

  it("accepts the same signature case-insensitively, as hex is", () => {
    const signature = sign(BODY);
    expect(
      provider.verifyWebhookSignature({
        rawBody: BODY,
        signature: signature.toUpperCase(),
      }),
    ).toBe(true);
  });
});

describe("nothing is trusted before authentication", () => {
  /**
   * A database that fails loudly if it is touched.
   *
   * The point of these tests is that an unauthenticated request never reaches
   * persistence at all. Asserting "no rows were written" afterwards would be
   * weaker: it cannot tell a write that did not happen from one that happened
   * and was rolled back.
   */
  const forbiddenPrisma = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `the database was reached before authentication succeeded (via ${String(property)})`,
        );
      },
    },
  ) as PrismaClient;

  const rejecting = fakePaymentProvider();

  it("never touches the database when the signature is missing", async () => {
    const result = await processWebhook(
      { rawBody: BODY, signature: null, providerEventId: "evt_1" },
      { prisma: forbiddenPrisma, provider: rejecting },
    );
    expect(result).toEqual({ kind: "REJECTED", rejection: "SIGNATURE_MISSING" });
  });

  it("never touches the database when the signature is wrong", async () => {
    const result = await processWebhook(
      { rawBody: BODY, signature: "a".repeat(64), providerEventId: "evt_1" },
      { prisma: forbiddenPrisma, provider: rejecting },
    );
    expect(result).toEqual({ kind: "REJECTED", rejection: "SIGNATURE_INVALID" });
  });

  it("refuses an oversized body before hashing or storing it", async () => {
    // A megabyte of unauthenticated input must not become a megabyte of work.
    const huge = "x".repeat(200_000);
    const result = await processWebhook(
      { rawBody: huge, signature: "a".repeat(64), providerEventId: "evt_1" },
      { prisma: forbiddenPrisma, provider: rejecting },
    );
    expect(result).toEqual({ kind: "REJECTED", rejection: "BODY_TOO_LARGE" });
  });

  it("refuses an authentic request that carries no event id", async () => {
    // Without a delivery id there is nothing to deduplicate against, and an
    // at-least-once provider would be able to apply the same capture twice.
    const accepting = fakePaymentProvider({ onVerifyWebhook: () => true });
    const result = await processWebhook(
      { rawBody: BODY, signature: "a".repeat(64), providerEventId: null },
      { prisma: forbiddenPrisma, provider: accepting },
    );
    expect(result).toEqual({ kind: "REJECTED", rejection: "EVENT_ID_MISSING" });
  });

  it("refuses an authentic request whose body is not a payment event", async () => {
    const accepting = fakePaymentProvider({ onVerifyWebhook: () => true });
    for (const rawBody of ["not json at all", "{}", '{"event":"payment.captured"}']) {
      const result = await processWebhook(
        { rawBody, signature: "a".repeat(64), providerEventId: "evt_1" },
        { prisma: forbiddenPrisma, provider: accepting },
      );
      expect(result, rawBody).toEqual({ kind: "REJECTED", rejection: "BODY_MALFORMED" });
    }
  });

  it("hands the verifier the raw body, byte for byte", async () => {
    const accepting = fakePaymentProvider({ onVerifyWebhook: () => false });
    const awkward = '{"event":"payment.captured",  "spacing":"preserved\\u00e9"}';
    await processWebhook(
      { rawBody: awkward, signature: "a".repeat(64), providerEventId: "evt_1" },
      { prisma: forbiddenPrisma, provider: accepting },
    );
    expect(accepting.webhookInputs).toHaveLength(1);
    expect(accepting.webhookInputs[0]?.rawBody).toBe(awkward);
  });
});
