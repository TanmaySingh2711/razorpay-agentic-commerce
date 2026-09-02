/**
 * Which database the automated suite is allowed to destroy.
 *
 * The database tests truncate their schema between every test. That is only
 * ever safe against a disposable database, so the address of that database is
 * resolved here rather than read ad hoc, and the resolution is deliberately
 * unforgiving in one specific direction: it will not quietly reach for the
 * application's own connection when the test connection is missing.
 *
 * Before this module, `tests/db/harness.ts` and `scripts/setup-test-schema.ts`
 * both read `TEST_DIRECT_URL ?? DIRECT_URL`. That fallback is the failure mode
 * worth designing against — it is silent, it is convenient, and it points a
 * `TRUNCATE ... CASCADE` loop at whatever `DIRECT_URL` happens to be, which on
 * a developer machine is the hosted staging database. The schema guard in
 * ./test-database-guard.ts would still refuse to delete anything there, so this
 * is a second line rather than the only one; but a second line that fails at
 * configuration time, with a sentence explaining what to do, beats one that
 * fails deep inside a `beforeEach`.
 *
 * This module handles *addressing*. It says nothing about whether the schema
 * on the other end is disposable — that remains the guard's job, proven against
 * the live catalog, and nothing here weakens it.
 */

/**
 * Escape hatch for the rare case of a genuinely disposable *remote* test
 * database — a CI service container reached over the network, say.
 *
 * It exists so the check below can stay strict without becoming a wall. Set it
 * deliberately, per command; a value of exactly "1" is required so a stray
 * empty string in an environment file cannot switch the protection off.
 */
export const REMOTE_TEST_DATABASE_OPT_IN = "ALLOW_REMOTE_TEST_DATABASE";

export class TestDatabaseUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TestDatabaseUrlError";
  }
}

/** Never throws on a malformed URL: an unparseable host simply cannot match. */
function hostOf(url: string | undefined): string | null {
  if (url === undefined || url.length === 0) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The three variables this decision is made from, plus the opt-in.
 *
 * The index signature is what lets `process.env` itself be passed: without it
 * TypeScript treats an all-optional interface as a "weak type" and rejects
 * `ProcessEnv` for having no properties in common with it.
 */
export interface TestDatabaseEnvironment {
  readonly TEST_DIRECT_URL?: string | undefined;
  readonly DIRECT_URL?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly [key: string]: string | undefined;
}

/**
 * The connection string the database suite may use, or `undefined` when this
 * checkout has no database configured at all.
 *
 * Three outcomes, and the difference between the last two is the whole point:
 *
 *  - **A string.** `TEST_DIRECT_URL` is set and does not point at the
 *    application's database. Tests run.
 *  - **`undefined`.** Nothing is configured — no test URL and no application
 *    URL either. This is a fresh clone, and the Objective 1 promise that the
 *    suite boots and passes with no credentials is preserved: the database
 *    suites skip themselves.
 *  - **A throw.** The project *is* configured but the test connection is
 *    missing or points at the application's own database. Skipping there would
 *    silently drop seventeen files' worth of PostgreSQL coverage from a run
 *    that looked green, so it fails loudly instead.
 */
export function resolveTestDatabaseUrl(
  env: TestDatabaseEnvironment = process.env,
): string | undefined {
  const testUrl = env.TEST_DIRECT_URL;
  const appDirect = env.DIRECT_URL;
  const appPooled = env.DATABASE_URL;
  const configured = (value: string | undefined): boolean =>
    value !== undefined && value.length > 0;

  if (!configured(testUrl)) {
    if (!configured(appDirect) && !configured(appPooled)) return undefined;
    throw new TestDatabaseUrlError(
      "TEST_DIRECT_URL is not set, but this project has an application database " +
        "configured. The database tests will not fall back to it. Start the local " +
        "test database with `npm run db:test:up`, then set TEST_DIRECT_URL in " +
        ".env.local - see .env.example.",
    );
  }

  if (env[REMOTE_TEST_DATABASE_OPT_IN] === "1") return testUrl;

  // Compared by host rather than by whole string: the pooled and direct
  // endpoints of one hosted database differ in path, parameters and often
  // subdomain prefix, and a test URL that merely added `?schema=` to the
  // application's would slip past an equality check while addressing the very
  // same server.
  const testHost = hostOf(testUrl);
  for (const [name, appUrl] of [
    ["DIRECT_URL", appDirect],
    ["DATABASE_URL", appPooled],
  ] as const) {
    const appHost = hostOf(appUrl);
    if (appHost !== null && testHost !== null && appHost === testHost) {
      throw new TestDatabaseUrlError(
        `TEST_DIRECT_URL points at the same database server as ${name}. The ` +
          "database tests truncate their schema between tests and must never be " +
          "aimed at the application's database. Point TEST_DIRECT_URL at the local " +
          `Docker instance (\`npm run db:test:up\`), or set ${REMOTE_TEST_DATABASE_OPT_IN}=1 ` +
          "if that server really is disposable.",
      );
    }
  }

  return testUrl;
}
