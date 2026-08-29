import { defineConfig } from "vitest/config";

/**
 * Tests run on the Node runtime because every module in this foundation
 * (money, state machine, config, logging, route handlers) is deliberately
 * framework-free and server-side. A DOM environment is added only when a
 * component actually needs one.
 *
 * `resolve.tsconfigPaths` reuses the `@/*` alias from tsconfig.json, so a test
 * import path is identical to an application import path.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    restoreMocks: true,
  },
});
