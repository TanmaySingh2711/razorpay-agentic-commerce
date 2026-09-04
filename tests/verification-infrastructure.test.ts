import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_TEST_DATABASE_OPT_IN,
  TestDatabaseUrlError,
  resolveTestDatabaseUrl,
} from "./db/test-database-url";
import { NetworkAccessInTestError } from "./support/no-network";
import {
  DisposableSchemaGuardError,
  describeMarkerFailure,
} from "./db/test-database-guard";
import {
  DISPOSABLE_TEST_DATABASE,
  DisposableTestDatabaseTargetError,
  LocalStagingTargetError,
  RemoteDevDatabaseError,
  assertLocalHost,
  assertNotDisposableTestDatabase,
  assertRemoteHost,
} from "../scripts/database-target-guard";
import {
  POOLED_HOSTNAME_CONVENTIONS,
  isPooledHostname,
} from "../scripts/pooled-endpoint";
import { resolvePackageBin } from "../scripts/run-package-bin";

/**
 * The verification infrastructure, tested like anything else.
 *
 * Two protections were added to make automated verification local, offline and
 * safe: a refusal to aim the destructive database suite at the application's
 * own database, and a refusal to make live network calls from tests. Both are
 * the kind of guard that fails open silently if it ever stops working - the
 * suite would simply go green while doing the thing it was meant to prevent.
 * So both are asserted here.
 *
 * No secret and no real connection string appears below. Every URL is a
 * fabricated example, and the two database-URL cases that matter are decided
 * from the *shape* of the configuration, never from its contents.
 */

const LOCAL = "postgresql://u:p@localhost:5432/razorpay_agentic_test";
const CLOUD_DIRECT = "postgresql://u:p@db.example-cloud.test:5432/postgres";
const CLOUD_POOLED = "postgresql://u:p@pooled.db.example-cloud.test:5432/postgres";

describe("which database the destructive suite may use", () => {
  it("accepts a test URL that names a different server from the application's", () => {
    expect(
      resolveTestDatabaseUrl({
        TEST_DIRECT_URL: LOCAL,
        DIRECT_URL: CLOUD_DIRECT,
        DATABASE_URL: CLOUD_POOLED,
      }),
    ).toBe(LOCAL);
  });

  it("skips, rather than fails, when nothing at all is configured", () => {
    // The Objective 1 promise: a fresh clone with no credentials still runs a
    // green suite. `undefined` is what makes the db suites skip themselves.
    expect(resolveTestDatabaseUrl({})).toBeUndefined();
    expect(resolveTestDatabaseUrl({ TEST_DIRECT_URL: "" })).toBeUndefined();
  });

  it("refuses to fall back to the application's connection", () => {
    // The whole point. Before this guard the harness read
    // `TEST_DIRECT_URL ?? DIRECT_URL`, so a missing test URL silently pointed a
    // truncation loop at staging.
    expect(() => resolveTestDatabaseUrl({ DIRECT_URL: CLOUD_DIRECT })).toThrow(
      TestDatabaseUrlError,
    );
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL: CLOUD_POOLED })).toThrow(
      /TEST_DIRECT_URL is not set/,
    );
  });

  it("refuses a test URL pointing at the same server as DIRECT_URL", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        TEST_DIRECT_URL: `${CLOUD_DIRECT}?schema=agentic_test`,
        DIRECT_URL: CLOUD_DIRECT,
      }),
    ).toThrow(/same database server as DIRECT_URL/);
  });

  it("refuses a test URL pointing at the same server as DATABASE_URL", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        TEST_DIRECT_URL: CLOUD_POOLED,
        DATABASE_URL: CLOUD_POOLED,
      }),
    ).toThrow(/same database server as DATABASE_URL/);
  });

  it("compares by host, so adding a query parameter does not evade the check", () => {
    // An equality check would pass this. The server is identical.
    expect(() =>
      resolveTestDatabaseUrl({
        TEST_DIRECT_URL: `${CLOUD_DIRECT}?sslmode=require&schema=agentic_test`,
        DIRECT_URL: `${CLOUD_DIRECT}?sslmode=require`,
      }),
    ).toThrow(TestDatabaseUrlError);
  });

  it("treats the pooled and direct endpoints as the distinct hosts they are", () => {
    // `pooled.db...` and `db...` really are different hostnames, and a test
    // schema on the pooled endpoint of the same account is still a remote
    // database - but it is DATABASE_URL's host that catches that case, above.
    expect(
      resolveTestDatabaseUrl({
        TEST_DIRECT_URL: CLOUD_POOLED,
        DIRECT_URL: CLOUD_DIRECT,
      }),
    ).toBe(CLOUD_POOLED);
  });

  it("allows a deliberate opt-in for a genuinely disposable remote database", () => {
    expect(
      resolveTestDatabaseUrl({
        TEST_DIRECT_URL: CLOUD_DIRECT,
        DIRECT_URL: CLOUD_DIRECT,
        [REMOTE_TEST_DATABASE_OPT_IN]: "1",
      }),
    ).toBe(CLOUD_DIRECT);
  });

  it('requires exactly "1" to opt in, so a stray empty value cannot disarm it', () => {
    for (const value of ["", "0", "true", "yes"]) {
      expect(() =>
        resolveTestDatabaseUrl({
          TEST_DIRECT_URL: CLOUD_DIRECT,
          DIRECT_URL: CLOUD_DIRECT,
          [REMOTE_TEST_DATABASE_OPT_IN]: value,
        }),
      ).toThrow(TestDatabaseUrlError);
    }
  });
});

describe("tests may not reach the internet", () => {
  it("refuses a live call to the payment provider", () => {
    expect(() => globalThis.fetch("https://api.razorpay.com/v1/orders")).toThrow(
      NetworkAccessInTestError,
    );
  });

  it("refuses a live call to the AI provider", () => {
    expect(() =>
      globalThis.fetch("https://generativelanguage.googleapis.com/v1beta/models"),
    ).toThrow(/deterministic and offline/);
  });

  it("refuses a URL object and a Request just as firmly as a string", () => {
    expect(() => globalThis.fetch(new URL("https://api.razorpay.com/v1/orders"))).toThrow(
      NetworkAccessInTestError,
    );
    expect(() =>
      globalThis.fetch(new Request("https://api.razorpay.com/v1/orders")),
    ).toThrow(NetworkAccessInTestError);
  });

  it("names what it stopped, so the fix is obvious", () => {
    expect(() => globalThis.fetch("https://api.razorpay.com/v1/orders")).toThrow(
      /api\.razorpay\.com/,
    );
  });

  it("fails closed on a target it cannot parse", () => {
    expect(() => globalThis.fetch("not a url")).toThrow(NetworkAccessInTestError);
  });

  it("lets loopback through, so a locally started server is still reachable", () => {
    // Port 1 is not listening; the point is only that the guard does not refuse
    // it. The connection error is expected and deliberately swallowed.
    let refused: unknown = null;
    try {
      void globalThis.fetch("http://localhost:1/").catch(() => undefined);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeNull();
  });
});

describe("which database local development setup may migrate and seed", () => {
  it("accepts the loopback addresses that can only be this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0"]) {
      expect(assertLocalHost(`postgresql://u:p@${host}:5432/razorpay_agentic_dev`)).toBe(
        host,
      );
    }
  });

  it("refuses a hosted database outright", () => {
    // `npm run db:dev:setup` migrates and seeds. Pointed at staging by a stale
    // shell variable or a copied connection string, it would do both there.
    expect(() =>
      assertLocalHost("postgresql://u:p@db.example-cloud.test:5432/postgres"),
    ).toThrow(RemoteDevDatabaseError);
  });

  it("refuses anything merely resembling a local name", () => {
    // An allow-list, not a blocklist: these all contain "localhost" or a
    // private-looking address and are all still somewhere else.
    for (const host of [
      "localhost.example-cloud.test",
      "notlocalhost",
      "127.0.0.1.example-cloud.test",
      "192.168.1.50",
    ]) {
      expect(() => assertLocalHost(`postgresql://u:p@${host}:5432/db`)).toThrow(
        RemoteDevDatabaseError,
      );
    }
  });

  it("fails closed on a URL it cannot parse", () => {
    expect(() => assertLocalHost("not a url")).toThrow(/an unparseable URL/);
  });

  it("points at the explicit staging command instead of just refusing", () => {
    expect(() =>
      assertLocalHost("postgresql://u:p@db.example-cloud.test:5432/postgres"),
    ).toThrow(/`:staging` command/);
  });
});

describe("which database a staging command may reach", () => {
  it("accepts a hosted database", () => {
    expect(assertRemoteHost("postgresql://u:p@db.example-cloud.test:5432/postgres")).toBe(
      "db.example-cloud.test",
    );
  });

  it("refuses localhost", () => {
    // Not harmless: a `:staging` command that quietly ran locally would report
    // that staging was migrated when it was not, and the next person to look
    // would believe the report.
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0"]) {
      expect(() => assertRemoteHost(`postgresql://u:p@${host}:5432/db`)).toThrow(
        LocalStagingTargetError,
      );
    }
  });

  it("fails closed on a URL it cannot parse", () => {
    expect(() => assertRemoteHost("not a url")).toThrow(LocalStagingTargetError);
  });
});

describe("nothing may aim at the disposable test database", () => {
  it("refuses it from a local command", () => {
    expect(() =>
      assertNotDisposableTestDatabase(
        `postgresql://u:p@localhost:5432/${DISPOSABLE_TEST_DATABASE}`,
        "npm run db:seed",
      ),
    ).toThrow(DisposableTestDatabaseTargetError);
  });

  it("refuses it from a staging command too", () => {
    expect(() =>
      assertNotDisposableTestDatabase(
        `postgresql://u:p@db.example-cloud.test:5432/${DISPOSABLE_TEST_DATABASE}`,
        "npm run db:migrate:staging",
      ),
    ).toThrow(DisposableTestDatabaseTargetError);
  });

  it("names the command that was refused, so the message is actionable", () => {
    expect(() =>
      assertNotDisposableTestDatabase(
        `postgresql://u:p@localhost:5432/${DISPOSABLE_TEST_DATABASE}`,
        "npm run db:studio",
      ),
    ).toThrow(/npm run db:studio/);
  });

  it("allows the development and staging databases through", () => {
    expect(() =>
      assertNotDisposableTestDatabase(
        "postgresql://u:p@localhost:5432/razorpay_agentic_dev",
        "npm run db:migrate",
      ),
    ).not.toThrow();
    expect(() =>
      assertNotDisposableTestDatabase(
        "postgresql://u:p@db.example-cloud.test:5432/postgres",
        "npm run db:migrate:staging",
      ),
    ).not.toThrow();
  });
});

describe("which endpoint DATABASE_URL is allowed to be", () => {
  /**
   * The staging verifier insists the application's runtime URL is the pooled
   * endpoint. That check was written against one provider's naming convention
   * and silently became wrong when staging moved to Neon: a correctly pooled
   * host was reported as "NOT a pooled host" and the verification failed on a
   * configuration that was right. What follows pins both halves - the pooled
   * conventions that must be accepted, and the direct endpoints that must still
   * be refused, because a verifier that accepted everything would be worse than
   * the one that was wrong.
   *
   * Every hostname here is fabricated in the shape each provider publishes.
   */

  it("accepts a hostname whose leading label is the pooling marker", () => {
    expect(isPooledHostname("pooled.db.example-cloud.test")).toBe(true);
  });

  it("accepts the Neon pooled hostname, where the marker is a suffix", () => {
    // The case that regressed: the pooling marker is at the end of the first
    // label, not the start of the hostname.
    expect(isPooledHostname("ep-quiet-sun-123456-pooler.ap-south-1.aws.neon.tech")).toBe(
      true,
    );
  });

  it("accepts a pooler that is its own label", () => {
    expect(isPooledHostname("aws-0-ap-south-1.pooler.example-cloud.test")).toBe(true);
  });

  it("refuses a genuinely unpooled hostname", () => {
    // Each of these is the *direct* endpoint of a provider whose pooled
    // endpoint is accepted above. Confusing the two is exactly the mistake the
    // verifier exists to catch.
    expect(isPooledHostname("ep-quiet-sun-123456.ap-south-1.aws.neon.tech")).toBe(false);
    expect(isPooledHostname("db.example-cloud.test")).toBe(false);
    expect(isPooledHostname("localhost")).toBe(false);
  });

  it("matches whole name parts, not any substring", () => {
    // A substring search would call this pooled on the strength of "pool"
    // appearing inside an ordinary word.
    expect(isPooledHostname("liverpool.example.test")).toBe(false);
    expect(isPooledHostname("carpooling-db.example.test")).toBe(false);
  });

  it("is unaffected by the case a hostname is written in", () => {
    expect(isPooledHostname("EP-Quiet-Sun-123456-POOLER.aws.neon.tech")).toBe(true);
  });

  it("names every accepted convention when it refuses one", () => {
    // The old message pointed at one vendor's console, which is unhelpful
    // advice when staging is on a different provider.
    expect(POOLED_HOSTNAME_CONVENTIONS).toMatch(/pooled/);
    expect(POOLED_HOSTNAME_CONVENTIONS).toMatch(/pooler/);
  });
});

describe("why the disposable-schema guard refused", () => {
  /**
   * The guard fails closed whatever went wrong, and that is not in question
   * here. What is in question is what the reader is told afterwards.
   *
   * Observed for real: Docker Desktop stopped part-way through a run, and 331
   * database tests failed with "the disposable-schema marker could not be read
   * (Invalid `prisma.$queryRawUnsafe()` invocation:)" - a sentence about the
   * disposable schema, for a problem that was nothing to do with it. Prisma
   * leaves the useful half of that message empty when the query never reached a
   * server, so the text pointed at the guard rather than at the stopped
   * container. The natural conclusion from reading it is that the safety
   * interlock is broken, which is the last thing anyone should be talked into
   * distrusting.
   *
   * The two error shapes below are copied from the real driver: a refused TCP
   * connection on a dead port, and a genuine `42P01` from a live PostgreSQL
   * that has no such table.
   */

  /** What the pg driver adapter produces when nothing is listening. */
  const unreachable = Object.assign(
    new Error("\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\n"),
    { name: "PrismaClientKnownRequestError", code: "ECONNREFUSED" },
  );

  /** What a live PostgreSQL produces for a missing table. */
  const missingTable = Object.assign(
    new Error(
      "\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nRaw query failed. " +
        'Code: `42P01`. Message: `relation "agentic_test.disposable_schema_marker" does not exist`',
    ),
    {
      name: "PrismaClientKnownRequestError",
      code: "P2010",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "42P01",
            kind: "TableDoesNotExist",
            table: "agentic_test.disposable_schema_marker",
          },
        },
      },
    },
  );

  it("names the stopped database, not the schema, when nothing answered", () => {
    const reason = describeMarkerFailure(unreachable);
    expect(reason).toMatch(/could not be reached/i);
    expect(reason).toContain("npm run db:test:up");
    // The misleading half must be gone: this is not a statement about whether
    // the schema is disposable, because that was never determined.
    expect(reason).not.toMatch(/queryRawUnsafe/);
  });

  it("names the unbuilt schema when the database answered and had no marker", () => {
    const reason = describeMarkerFailure(missingTable);
    expect(reason).toContain("npm run db:test:setup");
    expect(reason).toMatch(/no marker table/i);
    expect(reason).not.toMatch(/could not be reached/i);
  });

  it("tells the two apart by the driver's own cause, not by message text", () => {
    // Both messages open with the identical Prisma preamble, so any check that
    // read the text would classify them the same way.
    expect(unreachable.message.startsWith("\nInvalid `prisma.")).toBe(true);
    expect(missingTable.message.startsWith("\nInvalid `prisma.")).toBe(true);
    expect(describeMarkerFailure(unreachable)).not.toBe(
      describeMarkerFailure(missingTable),
    );
  });

  it("falls back to the original detail for anything it does not recognise", () => {
    // An unfamiliar database error must still be reported, not swallowed into
    // a confident but wrong diagnosis.
    const other = Object.assign(new Error("permission denied for schema"), {
      meta: {
        driverAdapterError: {
          cause: { originalCode: "42501", kind: "SomethingElse" },
        },
      },
    });
    expect(describeMarkerFailure(other)).toContain("permission denied for schema");
  });

  it("still refuses, whichever cause it names", () => {
    // The diagnosis changed; the verdict did not. Every path here is a refusal.
    for (const error of [unreachable, missingTable]) {
      expect(() => {
        throw new DisposableSchemaGuardError(describeMarkerFailure(error));
      }).toThrow(/Refusing to run destructive test cleanup/);
    }
  });
});

describe("dependency CLIs are spawned without a shell", () => {
  /**
   * The database scripts used to run `npx <tool>` with `shell: true` on
   * Windows, which Node 24 deprecates (DEP0190) precisely because arguments
   * are concatenated into a command string instead of being passed
   * individually. Resolving the tool's own entry point removes the shell, and
   * therefore removes the question of whether an argument would have been
   * quoted correctly. These assert the resolution itself, because a wrong path
   * here would fail at spawn time inside a migration rather than here.
   */
  it("resolves the Prisma CLI to a real JavaScript entry point", () => {
    const bin = resolvePackageBin("prisma");
    expect(isAbsolute(bin)).toBe(true);
    expect(bin.endsWith(".js")).toBe(true);
    expect(existsSync(bin)).toBe(true);
  });

  it("resolves the tsx CLI, which the seed step runs", () => {
    const bin = resolvePackageBin("tsx");
    expect(isAbsolute(bin)).toBe(true);
    expect(existsSync(bin)).toBe(true);
  });

  it("refuses a package that exposes no CLI, rather than spawning a guess", () => {
    // `zod` is a library with no bin. Resolving it must fail loudly here, not
    // hand `node` a path that does not exist.
    expect(() => resolvePackageBin("zod")).toThrow(/no bin entry/);
  });
});
