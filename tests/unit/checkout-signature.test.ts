import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRazorpayProvider } from "@/integrations/payments/razorpay-provider";

/**
 * The checkout signature check, against the real adapter.
 *
 * Not a fake anywhere in this file. The HMAC is the single thing standing
 * between "a browser said a payment happened" and the server believing it, so
 * it is proved against the implementation that will actually run, using
 * signatures computed independently here with Node's own crypto.
 *
 * The most important test in the file is the one that signs the *right* payload
 * with the *wrong* order id. That is the attack the provider's documentation
 * warns about, and a verifier that used the client's order id would pass every
 * other test here while failing that one.
 */

const KEY_SECRET = "test_secret_do_not_use_anywhere";
const OUR_ORDER_ID = "order_OursFromTheDatabase";
const OTHER_ORDER_ID = "order_AttackersOwnOrder";
const PAYMENT_ID = "pay_TestModePayment01";

function provider(keySecret = KEY_SECRET) {
  return createRazorpayProvider({
    keyId: "rzp_test_unit",
    keySecret,
    baseUrl: "https://provider.test/v1",
    // Never used by signature verification; supplied so construction needs no
    // network stack at all.
    fetchImpl: (() => Promise.reject(new Error("no network in this test"))) as never,
  });
}

/** The provider's documented scheme: HMAC-SHA256 over `order_id|payment_id`. */
function sign(orderId: string, paymentId: string, secret = KEY_SECRET): string {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

describe("checkout signature verification", () => {
  it("accepts a signature the provider would really have produced", () => {
    expect(
      provider().verifyCheckoutSignature({
        serverStoredOrderId: OUR_ORDER_ID,
        providerPaymentId: PAYMENT_ID,
        signature: sign(OUR_ORDER_ID, PAYMENT_ID),
      }),
    ).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      provider().verifyCheckoutSignature({
        serverStoredOrderId: OUR_ORDER_ID,
        providerPaymentId: PAYMENT_ID,
        signature: sign(OUR_ORDER_ID, PAYMENT_ID, "someone-elses-secret"),
      }),
    ).toBe(false);
  });

  it("rejects a genuine signature for somebody else's order", () => {
    // The attack the provider documents: an attacker holds a real, correctly
    // signed payment for an order of their own, and presents it against our
    // transaction. It verifies perfectly - but only against THEIR order id.
    // Because the server signs with the id it stored, the check fails.
    const genuineForTheirOrder = sign(OTHER_ORDER_ID, PAYMENT_ID);

    expect(
      provider().verifyCheckoutSignature({
        serverStoredOrderId: OUR_ORDER_ID,
        providerPaymentId: PAYMENT_ID,
        signature: genuineForTheirOrder,
      }),
    ).toBe(false);

    // And is authentic against the order it was actually made for, which proves
    // the signature itself was well formed rather than merely broken.
    expect(
      provider().verifyCheckoutSignature({
        serverStoredOrderId: OTHER_ORDER_ID,
        providerPaymentId: PAYMENT_ID,
        signature: genuineForTheirOrder,
      }),
    ).toBe(true);
  });

  it("rejects a signature for a different payment id", () => {
    expect(
      provider().verifyCheckoutSignature({
        serverStoredOrderId: OUR_ORDER_ID,
        providerPaymentId: "pay_SomeOtherPayment",
        signature: sign(OUR_ORDER_ID, PAYMENT_ID),
      }),
    ).toBe(false);
  });

  it("accepts the digest in either letter case", () => {
    expect(
      provider().verifyCheckoutSignature({
        serverStoredOrderId: OUR_ORDER_ID,
        providerPaymentId: PAYMENT_ID,
        signature: sign(OUR_ORDER_ID, PAYMENT_ID).toUpperCase(),
      }),
    ).toBe(true);
  });

  describe("malformed input fails closed rather than throwing", () => {
    // `timingSafeEqual` throws on unequal-length buffers. A verifier that
    // called it without validating shape first would turn a malformed
    // signature into a 500 - which is both a crash and an oracle. Every case
    // here must return false, quietly.
    const malformed: readonly (readonly [string, string])[] = [
      ["empty", ""],
      ["not hex", "z".repeat(64)],
      ["too short", "ab".repeat(16)],
      ["too long", "ab".repeat(64)],
      ["odd length", "abc"],
      ["hex with whitespace", ` ${sign(OUR_ORDER_ID, PAYMENT_ID)} `],
      ["truncated by one", sign(OUR_ORDER_ID, PAYMENT_ID).slice(0, 63)],
    ];

    for (const [name, signature] of malformed) {
      it(`rejects a signature that is ${name}`, () => {
        let threw = false;
        let verdict = true;
        try {
          verdict = provider().verifyCheckoutSignature({
            serverStoredOrderId: OUR_ORDER_ID,
            providerPaymentId: PAYMENT_ID,
            signature,
          });
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(verdict).toBe(false);
      });
    }

    it("rejects an empty order id or payment id", () => {
      expect(
        provider().verifyCheckoutSignature({
          serverStoredOrderId: "",
          providerPaymentId: PAYMENT_ID,
          signature: sign("", PAYMENT_ID),
        }),
      ).toBe(false);
      expect(
        provider().verifyCheckoutSignature({
          serverStoredOrderId: OUR_ORDER_ID,
          providerPaymentId: "",
          signature: sign(OUR_ORDER_ID, ""),
        }),
      ).toBe(false);
    });
  });

  it("never returns anything derived from the expected signature", () => {
    // The return type is a boolean, so there is nothing to leak by construction.
    // Asserted anyway, because the day someone widens this to return a reason is
    // the day an attacker gets an oracle.
    const verdict = provider().verifyCheckoutSignature({
      serverStoredOrderId: OUR_ORDER_ID,
      providerPaymentId: PAYMENT_ID,
      signature: "0".repeat(64),
    });
    expect(typeof verdict).toBe("boolean");
    expect(verdict).toBe(false);
  });
});
