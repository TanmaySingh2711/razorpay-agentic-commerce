/**
 * Loading the payment provider's checkout script, and the types it brings.
 *
 * This is the only file that knows the provider ships a global. Keeping the
 * `window` cast, the script URL and the option shape here means the component
 * below reads as ordinary application code, and a change of provider is a
 * change to two files rather than a search through the UI.
 *
 * Deliberately client-only and dependency-free: it imports nothing from
 * `@/services`, `@/config` or Prisma, so it cannot drag a server module into a
 * browser bundle.
 */

/** The provider's official Standard Checkout script. */
const CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

const SCRIPT_ELEMENT_ID = "razorpay-checkout-script";

/** What the provider hands back to the success handler. All of it untrusted. */
export interface CheckoutSuccessResponse {
  readonly razorpay_payment_id: string;
  readonly razorpay_order_id: string;
  readonly razorpay_signature: string;
}

/** The provider's failure event. Useful for telling a person what happened. */
export interface CheckoutFailureResponse {
  readonly error?: {
    readonly code?: string;
    readonly description?: string;
    readonly reason?: string;
  };
}

export interface CheckoutOptions {
  readonly key: string;
  readonly amount: number;
  readonly currency: string;
  readonly name: string;
  readonly description?: string;
  readonly order_id: string;
  readonly handler: (response: CheckoutSuccessResponse) => void;
  readonly modal?: { readonly ondismiss?: () => void };
  readonly theme?: { readonly color?: string };
}

interface CheckoutInstance {
  open: () => void;
  on: (event: string, handler: (response: CheckoutFailureResponse) => void) => void;
}

type CheckoutConstructor = new (options: CheckoutOptions) => CheckoutInstance;

interface CheckoutWindow extends Window {
  Razorpay?: CheckoutConstructor;
}

/**
 * Ensures the script is present, resolving to the constructor.
 *
 * Rejects rather than hanging when the script cannot load — an ad blocker, a
 * broken network or a blocked third-party origin are all ordinary conditions,
 * and a Pay button that spins forever is worse than one that says it could not
 * reach the payment provider.
 *
 * Reuses an existing tag rather than appending a second one, so a person who
 * presses Pay twice does not accumulate scripts.
 */
export function loadCheckoutScript(): Promise<CheckoutConstructor> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Checkout can only be loaded in a browser."));
  }
  const globalWindow = window as CheckoutWindow;
  const existingConstructor = globalWindow.Razorpay;
  if (existingConstructor !== undefined) {
    return Promise.resolve(existingConstructor);
  }

  return new Promise((resolve, reject) => {
    const fail = (): void => {
      reject(new Error("The payment provider's checkout script could not be loaded."));
    };
    const settle = (): void => {
      const loaded = (window as CheckoutWindow).Razorpay;
      if (loaded === undefined) {
        fail();
        return;
      }
      resolve(loaded);
    };

    const existing = document.getElementById(SCRIPT_ELEMENT_ID);
    if (existing !== null) {
      existing.addEventListener("load", settle, { once: true });
      existing.addEventListener("error", fail, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ELEMENT_ID;
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", fail, { once: true });
    document.body.appendChild(script);
  });
}
