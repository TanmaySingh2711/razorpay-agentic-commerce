import { defineConfig } from "vitest/config";

/**
 * Tests run on the Node runtime because every module in this project - money,
 * state machine, config, logging, persistence - is deliberately framework-free
 * and server-side. A DOM environment is added only when a component needs one.
 *
 * `resolve.tsconfigPaths` reuses the `@/*` alias from tsconfig.json, so a test
 * import path is identical to an application import path.
 *
 * Database tests live in `tests/db/` and run against the isolated
 * `agentic_test` PostgreSQL schema. They skip themselves when no database is
 * configured, so the foundation suite still passes with no credentials.
 * They also run single-threaded: they share one schema, so parallel forks
 * would interfere with each other's fixtures.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
