import { beforeAll } from "vitest";

/**
 * The automated suite may not talk to the internet.
 *
 * Every external dependency in this system already has a seam: the payment
 * adapter takes a `fetchImpl`, the AI provider is an interface with a fake
 * implementation, and the database is local. So today no test makes a live
 * call. The problem is that nothing *enforces* it — `createRazorpayProvider()`
 * defaults `fetchImpl` to global `fetch` and `baseUrl` to
 * `https://api.razorpay.com/v1`, so a future test that forgets to inject one
 * would reach the real provider with real credentials from `.env.local` and
 * still look like it passed.
 *
 * That is not a hypothetical class of bug. A test suite that silently spends
 * Razorpay requests or Gemini quota is expensive, non-deterministic, and
 * unrunnable offline or in CI; and a test that accidentally authenticates
 * against a live API is a test that can create state nobody asked for.
 *
 * So global `fetch` is replaced for the whole run with one that refuses. The
 * refusal names the URL it stopped, because the fix is always the same and
 * always local: inject a fake.
 *
 * **Loopback stays open.** Local addresses are allowed through so a test may
 * legitimately talk to something this machine is running - the Docker
 * PostgreSQL, or a server a test starts itself. The database driver does not go
 * through `fetch` at all (`pg` opens a TCP socket), so it is unaffected either
 * way.
 *
 * This guards `fetch` specifically. A dependency reaching for `node:http`
 * directly would not be caught here; that is a deliberate limit rather than an
 * oversight, because every HTTP client in this project's dependency tree uses
 * `fetch`, and a socket-level interception would also have to understand which
 * sockets belong to PostgreSQL.
 */

const ALLOWED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "host.docker.internal",
]);

function hostnameOf(input: unknown): string | null {
  try {
    if (typeof input === "string") return new URL(input).hostname.toLowerCase();
    if (input instanceof URL) return input.hostname.toLowerCase();
    if (input instanceof Request) return new URL(input.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return null;
}

function describe(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return "an unrecognised request";
}

export class NetworkAccessInTestError extends Error {
  constructor(target: string) {
    super(
      `A test tried to make a live network request to ${target}. ` +
        "Automated verification must be deterministic and offline: no Gemini, no " +
        "Razorpay, no hosted database, no deployment. Inject a fake instead - see " +
        "tests/support/fake-payment-provider.ts and tests/support/fake-ai-provider.ts.",
    );
    this.name = "NetworkAccessInTestError";
  }
}

beforeAll(() => {
  const real = globalThis.fetch;

  const guarded: typeof fetch = (input, init) => {
    const hostname = hostnameOf(input);
    // An unparseable target is refused rather than allowed. Failing closed
    // costs a clear error message; failing open costs a live API call.
    if (hostname !== null && ALLOWED_HOSTNAMES.has(hostname)) {
      return real(input, init);
    }
    throw new NetworkAccessInTestError(describe(input));
  };

  globalThis.fetch = guarded;
});
