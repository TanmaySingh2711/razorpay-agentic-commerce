import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Unknown addresses: the site's own not-found page, and no checkout for a
 * purchase that does not exist.
 *
 * The checkout page once rendered "Complete your payment", with a Pay button,
 * for any id at all. The purchase page beside it already answered not-found,
 * so that hid nothing and offered a click the server could only refuse.
 */

const mocks = vi.hoisted(() => ({
  readRetryStatus: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/services/retry-service", () => ({ readRetryStatus: mocks.readRetryStatus }));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/actions", () => ({}));

const ID = "01a068ee-b304-7756-83d6-000000000000";

describe("the checkout page", () => {
  it("answers not-found for a purchase that does not exist", async () => {
    mocks.readRetryStatus.mockResolvedValueOnce(null);
    const { default: CheckoutPage } =
      await import("@/app/shop/[transactionId]/checkout/page");

    await expect(
      CheckoutPage({ params: Promise.resolve({ transactionId: ID }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the not-found page", () => {
  it("keeps the site's header and offers a way on", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    const markup = renderToStaticMarkup(NotFound());

    expect(markup).toContain('class="product-bar"');
    expect(markup).toContain("There is nothing at this address.");
    expect(markup).toMatch(/<a class="primary" href="\/shop">/);
    expect(markup).not.toMatch(/[–—…]| - /);
  });
});
