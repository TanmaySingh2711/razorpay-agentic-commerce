import { afterEach, describe, expect, it } from "vitest";
import { loadCheckoutScript } from "@/lib/checkout-script";

/**
 * Loading the provider's checkout script, including the ways it fails.
 *
 * Script loading is the one part of the payment path that routinely breaks for
 * reasons nobody controls: an ad blocker, a corporate proxy, a blocked
 * third-party origin, a flaky connection. A Pay button that spins forever when
 * that happens is worse than one that says it could not reach the payment
 * provider, so the failure path is worth as much of a test as the happy one.
 *
 * The DOM is stubbed by hand rather than by pulling in jsdom. Only five
 * browser APIs are used - `window.Razorpay`, `getElementById`, `createElement`,
 * `addEventListener` and `body.appendChild` - and a stub that small keeps the
 * test honest about which of them the code actually depends on, without adding
 * a dependency to prove it.
 */

interface StubScript {
  id: string;
  src: string;
  async: boolean;
  readonly listeners: Map<string, () => void>;
  addEventListener: (event: string, handler: () => void) => void;
}

interface Harness {
  readonly created: StubScript[];
  readonly appended: StubScript[];
  existing: StubScript | null;
  /** Simulates the browser finishing the load, successfully or not. */
  finish: (event: "load" | "error", global?: unknown) => void;
}

function stubDom(): Harness {
  const created: StubScript[] = [];
  const appended: StubScript[] = [];
  const harness: Harness = {
    created,
    appended,
    existing: null,
    finish(event, global) {
      if (global !== undefined) {
        (globalThis as { Razorpay?: unknown }).Razorpay = global;
      }
      const target = appended.at(-1) ?? harness.existing;
      target?.listeners.get(event)?.();
    },
  };

  function makeScript(): StubScript {
    const listeners = new Map<string, () => void>();
    return {
      id: "",
      src: "",
      async: false,
      listeners,
      addEventListener: (event, handler) => listeners.set(event, handler),
    };
  }

  // `window` is the object the loader reads the provider's global off, so it
  // points at `globalThis` - which is also where `finish` installs it.
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { document?: unknown }).document = {
    getElementById: () => harness.existing,
    createElement: () => {
      const script = makeScript();
      created.push(script);
      return script;
    },
    body: {
      appendChild: (script: StubScript) => {
        appended.push(script);
      },
    },
  };
  return harness;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { Razorpay?: unknown }).Razorpay;
});

describe("loading the checkout script", () => {
  it("resolves with the constructor once the script has loaded", async () => {
    const dom = stubDom();
    const constructor = function Razorpay() {
      /* the provider's global */
    };

    const pending = loadCheckoutScript();
    dom.finish("load", constructor);

    await expect(pending).resolves.toBe(constructor);
    expect(dom.appended).toHaveLength(1);
    expect(dom.appended[0]?.src).toBe("https://checkout.razorpay.com/v1/checkout.js");
    expect(dom.appended[0]?.async).toBe(true);
  });

  it("rejects when the script cannot be fetched at all", async () => {
    const dom = stubDom();

    const pending = loadCheckoutScript();
    dom.finish("error");

    // The message must be actionable and must not blame the buyer.
    await expect(pending).rejects.toThrow(/could not be loaded/);
  });

  it("rejects when the script loads but defines no global", async () => {
    // A proxy or an ad blocker can answer with a 200 and an empty body, which
    // fires `load` while leaving nothing behind. Resolving here would hand the
    // caller `undefined` and fail later, somewhere less obvious.
    const dom = stubDom();

    const pending = loadCheckoutScript();
    dom.finish("load");

    await expect(pending).rejects.toThrow(/could not be loaded/);
  });

  it("reuses a constructor that is already present without touching the DOM", async () => {
    const dom = stubDom();
    const constructor = function Razorpay() {
      /* already loaded by an earlier press of Pay */
    };
    (globalThis as { Razorpay?: unknown }).Razorpay = constructor;

    await expect(loadCheckoutScript()).resolves.toBe(constructor);
    expect(dom.created).toHaveLength(0);
    expect(dom.appended).toHaveLength(0);
  });

  it("waits on an in-flight tag rather than appending a second one", async () => {
    const dom = stubDom();
    const constructor = function Razorpay() {
      /* the provider's global */
    };
    // A first press of Pay already put the tag in the document.
    dom.existing = {
      id: "razorpay-checkout-script",
      src: "https://checkout.razorpay.com/v1/checkout.js",
      async: true,
      listeners: new Map(),
      addEventListener(event, handler) {
        this.listeners.set(event, handler);
      },
    };

    const pending = loadCheckoutScript();
    expect(dom.appended).toHaveLength(0);

    dom.finish("load", constructor);
    await expect(pending).resolves.toBe(constructor);
    // Pressing Pay twice must not accumulate script tags.
    expect(dom.created).toHaveLength(0);
  });

  it("rejects outside a browser instead of throwing on `window`", async () => {
    // Server-side rendering reaches this module too. A ReferenceError here
    // would surface as an opaque 500 rather than a handled condition. No stub
    // is installed, so `window` is genuinely absent - exactly as on the server.
    await expect(loadCheckoutScript()).rejects.toThrow(/browser/);
  });
});
