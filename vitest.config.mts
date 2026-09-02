import { defineConfig } from "vitest/config";

/**
 * Tests run on the Node runtime because every module in this project - money,
 * state machine, config, logging, persistence - is deliberately framework-free
 * and server-side. A DOM environment is added only when a component needs one.
 *
 * `resolve.tsconfigPaths` reuses the `@/*` alias from tsconfig.json, so a test
 * import path is identical to an application import path.
 *
 * `setupFiles` installs the offline guard in every worker. Automated
 * verification must never spend Gemini quota, issue a Razorpay request, or
 * reach a hosted database, and that is enforced rather than merely intended -
 * see tests/support/no-network.ts.
 *
 * ## Two projects, because they need opposite scheduling
 *
 * The suite splits into two populations with genuinely different isolation
 * requirements, and collapsing them into one setting penalises whichever half
 * loses the argument.
 *
 * **`unit`** is every test outside `tests/db/`. These touch no shared mutable
 * state at all - pure domain rules, signature arithmetic, Zod contracts, route
 * handlers called as functions. They can run in parallel, and measured on this
 * machine doing so takes them from 10.5s to 5.9s across 21 files and 557 tests.
 *
 * **`db`** is everything under `tests/db/`. Every one of these files shares a
 * single PostgreSQL schema, `agentic_test`, and empties it with a
 * `TRUNCATE ... CASCADE` between tests. Two files running at once would
 * truncate each other's fixtures mid-test, which does not fail cleanly - it
 * fails as a scattering of "record not found" errors that look like product
 * bugs. So this project keeps `fileParallelism: false`.
 *
 * That is a deliberate refusal to optimise. Per-worker schemas would let these
 * run concurrently too, but it would mean provisioning and migrating N schemas
 * per run and teaching the disposable-schema guard about all of them - real
 * complexity, and a new way to be flaky, to save roughly twenty seconds. The
 * database suites stay serial until that trade changes.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    globals: false,
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["tests/support/no-network.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/*.test.ts"],
          fileParallelism: true,
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          // Load-bearing. See the note above: these files share one schema.
          fileParallelism: false,
        },
      },
    ],
  },
});
