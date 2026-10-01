import { ESLint } from "eslint";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertServerOnly } from "@/lib/server-only";

/**
 * The architecture rules, tested as rules.
 *
 * Three invariants in this project are worth more than a paragraph in a doc:
 *
 *   - a Transaction row may only be created through the creation boundary;
 *   - once it exists, only the state machine may change it;
 *   - and the state machine's answer may not be thrown away.
 *
 * All three are enforced by ESLint, and a lint rule that nobody tests is a lint
 * rule that quietly stops matching the day someone renames a variable. These
 * tests run the project's real ESLint configuration over small fixtures and
 * assert exactly which files it lets through.
 *
 * The fixtures are linted as *text* against a virtual file path, so nothing is
 * written to disk and the probes cannot leave a broken file behind.
 */

/** A prisma-shaped stand-in, so the fixture is valid TypeScript on its own. */
const PRISMA_STUB = `declare const prisma: {
  transaction: Record<string, (arg: unknown) => Promise<unknown>>;
};
`;

/**
 * A declaration-only stand-in for the transition service, in both shapes a
 * caller can reach it: a bare import and a method on an injected service.
 */
const TRANSITION_STUB = `declare function applyTransactionEvent(command: unknown): Promise<{ kind: string }>;
declare const service: { applyTransactionEvent(command: unknown): Promise<{ kind: string }> };
`;

const ANY_SERVICE = "src/services/example-service.ts";
const CREATION_SERVICE = "src/services/transaction/creation-service.ts";
const TRANSITION_SERVICE = "src/services/transaction/transition-service.ts";

let eslint: ESLint;

async function messagesFor(code: string, filePath: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.message);
}

function lint(body: string, filePath: string): Promise<readonly string[]> {
  return messagesFor(`${PRISMA_STUB}${body}\n`, filePath);
}

/** Wraps a body in an exported async function so unused-symbol rules stay quiet. */
function lintTransitionBody(body: string): Promise<readonly string[]> {
  const code = `${TRANSITION_STUB}export async function probe(): Promise<unknown> {
${body}
}
`;
  return messagesFor(code, ANY_SERVICE);
}

function hasMutationError(messages: readonly string[]): boolean {
  return messages.some((m) => m.includes("Do not mutate a Transaction row directly"));
}

function hasCreateError(messages: readonly string[]): boolean {
  return messages.some((m) => m.includes("Do not create a Transaction row directly"));
}

function hasDiscardError(messages: readonly string[]): boolean {
  return messages.some((m) =>
    m.includes("Do not discard the result of applyTransactionEvent()"),
  );
}

/**
 * Builds the linter and pays its start-up cost here, in setup.
 *
 * `new ESLint()` is nearly free: it resolves the flat config, loads every
 * plugin and parser it names, and builds the TypeScript program lazily, on the
 * first `lintText` call. Measured cold that first call takes ~3.5 seconds
 * against ~10ms for every one after it - a 350x cliff.
 *
 * Left alone, the whole of that cost lands on whichever assertion happens to
 * run first, which made one arbitrary test look slow and, in a full run behind
 * thirty-three other files, pushed it past the 30-second budget and failed it.
 * The test was never slow; the accounting was wrong.
 *
 * The warm-up moves the cost to where it belongs. The hook is given room of its
 * own because it is doing real one-time work, while every actual test keeps the
 * project's strict default budget - which they now meet with three orders of
 * magnitude to spare. Nothing is skipped, relaxed or mocked: the tests below
 * still run the project's real ESLint configuration, which is the entire point
 * of them.
 */
beforeAll(async () => {
  eslint = new ESLint({ cwd: process.cwd() });
  await messagesFor(PRISMA_STUB, ANY_SERVICE);
}, 120_000);

describe("transaction write enforcement (ESLint)", () => {
  describe("ordinary application code", () => {
    // Every way Prisma offers to change a transaction row, so a future
    // refactor cannot slip through on a method the selector forgot.
    for (const method of ["update", "updateMany", "upsert"] as const) {
      it(`rejects a direct transaction.${method}()`, async () => {
        const messages = await lint(
          `await prisma.transaction.${method}({});`,
          ANY_SERVICE,
        );
        expect(hasMutationError(messages)).toBe(true);
      });
    }

    for (const method of ["create", "createMany"] as const) {
      it(`rejects a direct transaction.${method}()`, async () => {
        const messages = await lint(
          `await prisma.transaction.${method}({});`,
          ANY_SERVICE,
        );
        expect(hasCreateError(messages)).toBe(true);
      });
    }

    it("points the developer at the two sanctioned boundaries", async () => {
      const mutation = await lint("await prisma.transaction.update({});", ANY_SERVICE);
      const creation = await lint("await prisma.transaction.create({});", ANY_SERVICE);
      expect(mutation.join(" ")).toContain("applyTransactionEvent()");
      expect(creation.join(" ")).toContain("createTransaction()");
    });

    it("leaves writes to other models alone", async () => {
      // The rule targets the lifecycle, not persistence in general. A quote or
      // a payment attempt is written by its own service in the normal way.
      const messages = await lint("await prisma.purchaseQuote.create({});", ANY_SERVICE);
      expect(messages).toHaveLength(0);
    });
  });

  describe("the creation boundary", () => {
    it("may create a transaction", async () => {
      const messages = await lint(
        "await prisma.transaction.create({});",
        CREATION_SERVICE,
      );
      expect(hasCreateError(messages)).toBe(false);
    });

    it("may not mutate one afterwards", async () => {
      // Otherwise the creation boundary quietly becomes a second, unpoliced
      // writer of the lifecycle.
      const messages = await lint(
        "await prisma.transaction.update({});",
        CREATION_SERVICE,
      );
      expect(hasMutationError(messages)).toBe(true);
    });
  });

  describe("the transition service", () => {
    it("may mutate a transaction", async () => {
      const messages = await lint(
        "await prisma.transaction.updateMany({});",
        TRANSITION_SERVICE,
      );
      expect(hasMutationError(messages)).toBe(false);
    });

    it("may not create one", async () => {
      // Applying an event to a transaction that does not exist must fail, not
      // conjure the transaction it was looking for.
      const messages = await lint(
        "await prisma.transaction.create({});",
        TRANSITION_SERVICE,
      );
      expect(hasCreateError(messages)).toBe(true);
    });
  });

  describe("exemptions are subtractions, not switches", () => {
    // A `no-restricted-syntax: "off"` in an exemption block would drop every
    // other restriction with it. These prove each boundary still carries the
    // rules it was never exempted from.
    for (const filePath of [CREATION_SERVICE, TRANSITION_SERVICE]) {
      it(`still forbids process.env in ${filePath}`, async () => {
        const messages = await lint("const x = process.env['DATABASE_URL'];", filePath);
        expect(messages.join(" ")).toContain("@/config/env");
      });
    }
  });
});

/**
 * The transition service answers with a discriminated union, and one arm -
 * `LATE_EVENT_HELD` - means "nothing happened, and someone has to decide what
 * that means". TypeScript stops a caller misreading that union but not
 * discarding it, so the discard is what these tests police.
 */
describe("discarded transition outcomes (ESLint)", () => {
  describe("rejected: the outcome is dropped", () => {
    const dropped: ReadonlyArray<readonly [string, string]> = [
      ["a bare awaited call", "await applyTransactionEvent({});\nreturn null;"],
      ["a call that is not even awaited", "applyTransactionEvent({});\nreturn null;"],
      ["an explicit void discard", "void applyTransactionEvent({});\nreturn null;"],
      [
        "a void discard of the awaited result",
        "void (await applyTransactionEvent({}));\nreturn null;",
      ],
      [
        "a method call on an injected service",
        "await service.applyTransactionEvent({});\nreturn null;",
      ],
    ];

    for (const [label, body] of dropped) {
      it(`rejects ${label}`, async () => {
        expect(hasDiscardError(await lintTransitionBody(body))).toBe(true);
      });
    }

    it("names all three outcomes so the fix is obvious", async () => {
      const messages = await lintTransitionBody(
        "await applyTransactionEvent({});\nreturn null;",
      );
      const text = messages.join(" ");
      expect(text).toContain("APPLIED");
      expect(text).toContain("ALREADY_APPLIED");
      expect(text).toContain("LATE_EVENT_HELD");
    });
  });

  describe("accepted: the outcome is consumed", () => {
    const consumed: ReadonlyArray<readonly [string, string]> = [
      ["assigning it", "const result = await applyTransactionEvent({});\nreturn result;"],
      ["returning the promise", "return applyTransactionEvent({});"],
      ["returning the awaited result", "return await applyTransactionEvent({});"],
      [
        "branching on it",
        'if ((await applyTransactionEvent({})).kind === "APPLIED") {\n  return 1;\n}\nreturn 0;',
      ],
      [
        "destructuring it",
        "const { kind } = await applyTransactionEvent({});\nreturn kind;",
      ],
      [
        "passing it on",
        "const record = (v: unknown): unknown => v;\nreturn record(await applyTransactionEvent({}));",
      ],
      [
        "consuming a method call",
        "const result = await service.applyTransactionEvent({});\nreturn result;",
      ],
    ];

    for (const [label, body] of consumed) {
      it(`accepts ${label}`, async () => {
        expect(hasDiscardError(await lintTransitionBody(body))).toBe(false);
      });
    }
  });

  it("leaves the existing Objective 3 source passing", async () => {
    // Not a fixture: the real application tree, linted with the real config.
    // A rule the existing code cannot satisfy is a rule someone will disable.
    const results = await eslint.lintFiles(["src"]);
    const errors = results.flatMap((result) =>
      result.messages
        .filter((m) => m.severity === 2)
        .map((m) => `${result.filePath}:${m.line} ${m.message}`),
    );
    expect(errors).toEqual([]);
  });
});

describe("server-only boundary", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as { window?: unknown }).window;
  });

  it("throws when a server-only module is evaluated in a browser", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(() => assertServerOnly("some/module.ts")).toThrow(/browser bundle/);
  });

  it("does nothing on the server", () => {
    expect(() => assertServerOnly("some/module.ts")).not.toThrow();
  });

  it("refuses to load the transaction creation service in a browser", async () => {
    // The proof that client code cannot open a transaction: the module throws
    // at import, before any exported function can be reached.
    vi.resetModules();
    (globalThis as { window?: unknown }).window = {};
    await expect(import("@/services/transaction/creation-service")).rejects.toThrow(
      /browser bundle/,
    );
  });
});
