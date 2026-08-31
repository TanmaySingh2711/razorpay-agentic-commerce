import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Architecture rules that are enforced rather than documented.
 *
 * `no-restricted-syntax` takes a list, and a later config block replaces that
 * list wholesale - it cannot subtract one entry. So each restriction is named
 * here and the exemption blocks below re-state the subset that still applies.
 * Writing `"no-restricted-syntax": "off"` in an exemption would silently drop
 * every other restriction with it, which is exactly the kind of accidental hole
 * these rules exist to prevent.
 */

/**
 * The typed config boundary (src/config) is the only place allowed to read the
 * environment. Everything else imports from it.
 */
const NO_DIRECT_PROCESS_ENV = {
  selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
  message:
    "Read configuration through @/config/env instead of process.env. See docs/09-configuration.md.",
};

/**
 * Lifecycle mutation. Once a transaction exists, its row may only be changed by
 * the state machine: a direct update would bypass the transition matrix, the
 * allowed-actor check, the atomic history insert and the concurrency guard all
 * at once. `upsert` is included because it is an update wearing a create's
 * clothes - it can move a live transaction without ever consulting the machine.
 */
const NO_DIRECT_TRANSACTION_MUTATION = {
  selector:
    "CallExpression[callee.property.name=/^(update|updateMany|upsert)$/][callee.object.property.name='transaction']",
  message:
    "Do not mutate a Transaction row directly. Emit a domain event through applyTransactionEvent() in @/services/transaction/transition-service. See docs/17-transaction-state-machine.md.",
};

/**
 * Creation. Legitimate, but only through the creation boundary, which is what
 * pins a new transaction to INTENT_RECEIVED. A raw `create` can name any status
 * it likes and start a transaction at AUTHORIZED, skipping quoting, policy and
 * approval in a single object literal.
 */
const NO_DIRECT_TRANSACTION_CREATE = {
  selector:
    "CallExpression[callee.property.name=/^(create|createMany)$/][callee.object.property.name='transaction']",
  message:
    "Do not create a Transaction row directly. Use createTransaction() in @/services/transaction/creation-service, which pins the initial state to INTENT_RECEIVED. See docs/17-transaction-state-machine.md.",
};

/**
 * A discarded transition outcome.
 *
 * `applyTransactionEvent` returns a discriminated union, and one of its arms -
 * `LATE_EVENT_HELD` - means "nothing happened, and someone has to decide what
 * that means". TypeScript will not let a caller misread that union, but it will
 * happily let a caller throw it away: `await applyTransactionEvent(...)` as a
 * bare statement type-checks and silently drops the outcome.
 *
 * There is no `#[must_use]` in TypeScript and no typed lint rule for an unused
 * return value, so this is enforced syntactically: the result of the transition
 * operation may not be the whole of an expression statement. Assign it, return
 * it, test it, pass it on - but do not drop it on the floor.
 *
 * `void applyTransactionEvent(...)` is rejected too. Explicitly discarding an
 * outcome is still discarding it; a caller who genuinely means to needs an
 * eslint-disable comment, which is visible in review.
 *
 * The alternatives were worse. Throwing on `LATE_EVENT_HELD` would turn an
 * expected, non-exceptional outcome into an exception, and collapsing the union
 * would destroy the very distinction the machine exists to draw.
 */
const DISCARDED_TRANSITION_RESULT_MESSAGE =
  "Do not discard the result of applyTransactionEvent(). It returns APPLIED, ALREADY_APPLIED or LATE_EVENT_HELD, and a held event means nothing happened - assign, return or inspect the outcome. See docs/17-transaction-state-machine.md.";

const NO_DISCARDED_TRANSITION_RESULT = [
  // await applyTransactionEvent(...);
  "ExpressionStatement > AwaitExpression > CallExpression[callee.name='applyTransactionEvent']",
  "ExpressionStatement > AwaitExpression > CallExpression[callee.property.name='applyTransactionEvent']",
  // applyTransactionEvent(...);  - not even awaited.
  "ExpressionStatement > CallExpression[callee.name='applyTransactionEvent']",
  "ExpressionStatement > CallExpression[callee.property.name='applyTransactionEvent']",
  // void applyTransactionEvent(...);  and  void (await applyTransactionEvent(...));
  "ExpressionStatement > UnaryExpression[operator='void'] CallExpression[callee.name='applyTransactionEvent']",
  "ExpressionStatement > UnaryExpression[operator='void'] CallExpression[callee.property.name='applyTransactionEvent']",
].map((selector) => ({ selector, message: DISCARDED_TRANSITION_RESULT_MESSAGE }));

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    // Generated by `prisma generate`; not ours to lint.
    "src/generated/**",
  ]),

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
        NO_DIRECT_TRANSACTION_MUTATION,
        NO_DIRECT_TRANSACTION_CREATE,
        NO_DIRECT_PROCESS_ENV,
        ...NO_DISCARDED_TRANSITION_RESULT,
      ],
    },
  },

  {
    // The config boundary itself must read process.env. It has no business
    // touching transactions, so both transaction rules stay on.
    name: "agentic-commerce/env-boundary-exemption",
    files: ["src/config/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DIRECT_TRANSACTION_MUTATION,
        NO_DIRECT_TRANSACTION_CREATE,
        ...NO_DISCARDED_TRANSITION_RESULT,
      ],
    },
  },

  {
    // The transition service IS the sanctioned mutator - it is the module the
    // mutation rule exists to funnel everything into. It is still forbidden
    // from creating transactions: applying an event to a row that does not
    // exist must fail, never quietly conjure one.
    name: "agentic-commerce/transition-service-exemption",
    files: ["src/services/transaction/transition-service.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DIRECT_TRANSACTION_CREATE,
        NO_DIRECT_PROCESS_ENV,
        ...NO_DISCARDED_TRANSITION_RESULT,
      ],
    },
  },

  {
    // The creation boundary may create - and only create. It cannot mutate a
    // transaction afterwards, so it cannot be quietly grown into a second,
    // unpoliced writer of the lifecycle.
    name: "agentic-commerce/creation-service-exemption",
    files: ["src/services/transaction/creation-service.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DIRECT_TRANSACTION_MUTATION,
        NO_DIRECT_PROCESS_ENV,
        ...NO_DISCARDED_TRANSITION_RESULT,
      ],
    },
  },

  {
    // Tests must be able to do what application code may not: write a raw
    // status to prove a column persists it, insert a transaction with a
    // deliberately invalid foreign key to prove the constraint rejects it, and
    // manipulate a raw environment record to exercise config validation.
    // Forbidding that here would only push those proofs out of the suite.
    // The rules themselves are proved instead by tests/lint-architecture.test.ts,
    // which runs ESLint over fixture source and asserts what it rejects.
    name: "agentic-commerce/test-exemption",
    files: ["tests/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },

  {
    // Standalone Node CLI tooling: the seed, the schema/verify scripts and the
    // Prisma config. These run outside the Next.js runtime - often before the
    // app can even start - so the application config boundary is not available
    // to them, and stdout IS their user interface. The exemption is deliberately
    // scoped to these paths and must not widen to src/.
    name: "agentic-commerce/cli-tooling",
    files: ["scripts/**/*.ts", "prisma/**/*.ts", "prisma.config.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "no-console": "off",
    },
  },
]);

export default eslintConfig;
