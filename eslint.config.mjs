import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts"]),

  {
    name: "agentic-commerce/financial-safety",
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    rules: {
      // Invariant: LLM output and client input are untrusted. `any` erases the
      // type checks that make that distinction enforceable, so it is banned
      // outright rather than warned about.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Money is integer minor units. `==` coercion and stray `console` calls
      // both undermine the deterministic/auditable core.
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-syntax": [
        "error",
        {
          // The typed config boundary (src/config) is the only place allowed to
          // read the environment. Everything else imports from it.
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            "Read configuration through @/config/env instead of process.env. See docs/09-configuration.md.",
        },
      ],
    },
  },

  {
    // The config boundary itself must read process.env, and tests need to
    // manipulate a raw environment record to exercise validation failures.
    name: "agentic-commerce/env-boundary-exemption",
    files: ["src/config/**/*.ts", "tests/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
