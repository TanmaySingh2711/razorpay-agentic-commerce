/**
 * Which database a command is allowed to reach, checked before it reaches it.
 *
 * This project has three databases — a local development one, a local
 * disposable test one, and the hosted staging one — and exactly one class of
 * accident worth engineering against: a command doing the right thing to the
 * wrong database. Migrating staging while meaning to migrate locally is the
 * expensive direction; seeding the disposable test database while meaning to
 * seed development is the confusing one, because the data vanishes at the next
 * `TRUNCATE` and nobody can explain why.
 *
 * So the target is asserted rather than assumed, and every assertion here fails
 * closed: a URL that cannot be parsed has not been shown to be safe, and "not
 * shown to be safe" is not a reason to proceed.
 *
 * The allow-list for local hosts is deliberate. A blocklist would have to
 * anticipate every host that must be refused, and the cost of missing one is a
 * write to a real database; an allow-list only has to name the hosts that are
 * genuinely this machine, and anything new must be added on purpose.
 *
 * These live in `scripts/` rather than `src/` because nothing the application
 * serves may depend on them, and in their own module rather than inside a setup
 * script so they can be tested without running one.
 */

export const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
]);

/** The disposable database the test suite truncates between tests. */
export const DISPOSABLE_TEST_DATABASE = "razorpay_agentic_test";

export class RemoteDevDatabaseError extends Error {
  constructor(host: string) {
    super(
      `Refusing to run a local development database command against "${host}". ` +
        "Local commands apply migrations and seed demo data, and may only run " +
        "against a local PostgreSQL instance. Point DIRECT_URL in " +
        ".env.development.local at the local Docker database (`npm run db:test:up` " +
        "starts the container), or use the explicit `:staging` command if you " +
        "genuinely meant to reach the hosted database.",
    );
    this.name = "RemoteDevDatabaseError";
  }
}

export class LocalStagingTargetError extends Error {
  constructor(host: string) {
    super(
      `Refusing to run a staging command against "${host}", which is this ` +
        "machine. A `:staging` command is meant to reach the hosted database; " +
        "pointed at localhost it would silently do staging work locally and " +
        "report success. Check DATABASE_URL and DIRECT_URL in .env.local.",
    );
    this.name = "LocalStagingTargetError";
  }
}

export class DisposableTestDatabaseTargetError extends Error {
  constructor(command: string) {
    super(
      `Refusing to point ${command} at "${DISPOSABLE_TEST_DATABASE}". That is the ` +
        "disposable database the automated suite owns: it truncates every table " +
        "between tests, so anything written here disappears without explanation. " +
        "The test schema is built by `npm run db:test:setup` and by nothing else.",
    );
    this.name = "DisposableTestDatabaseTargetError";
  }
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function databaseNameOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname.replace(/^\//, "");
  } catch {
    return null;
  }
}

/**
 * Returns the hostname when it is unmistakably this machine, and throws
 * otherwise. Used by every command that writes to the development database.
 */
export function assertLocalHost(rawUrl: string): string {
  const host = hostOf(rawUrl);
  if (host === null) throw new RemoteDevDatabaseError("an unparseable URL");
  if (!LOCAL_HOSTS.has(host)) throw new RemoteDevDatabaseError(host);
  return host;
}

/**
 * The mirror image, for `:staging` commands.
 *
 * A staging command that quietly ran against localhost is not harmless: it
 * reports that staging was migrated, seeded or inspected when it was not, and
 * the next thing anyone does is trust that report.
 */
export function assertRemoteHost(rawUrl: string): string {
  const host = hostOf(rawUrl);
  if (host === null) throw new LocalStagingTargetError("an unparseable URL");
  if (LOCAL_HOSTS.has(host)) throw new LocalStagingTargetError(host);
  return host;
}

/**
 * Refuses the disposable test database, whichever direction it is reached from.
 *
 * Applies to local and staging commands alike. Development pointed at it loses
 * data at the next test run; staging pointed at it would be a configuration
 * mistake serious enough to stop for.
 */
export function assertNotDisposableTestDatabase(rawUrl: string, command: string): void {
  if (databaseNameOf(rawUrl) === DISPOSABLE_TEST_DATABASE) {
    throw new DisposableTestDatabaseTargetError(command);
  }
}
