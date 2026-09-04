import { config as loadEnv } from "dotenv";
import {
  assertLocalHost,
  assertNotDisposableTestDatabase,
  assertRemoteHost,
  databaseNameOf,
} from "./database-target-guard";
import { runPackageBin } from "./run-package-bin";

/**
 * Runs a Prisma CLI command against an explicitly chosen database.
 *
 * ## Why this exists
 *
 * `prisma.config.ts` loads `.env.local`, so every Prisma CLI command used to
 * resolve to the hosted staging database - including `db:migrate`, `db:seed`
 * and `db:studio`, which read like ordinary development commands and are the
 * ones a person types without thinking. A migration or a seed is not something
 * to send somewhere by default.
 *
 * The fix is to make the target part of the command rather than part of the
 * ambient environment:
 *
 *   npm run db:migrate           -> local development database
 *   npm run db:migrate:staging   -> hosted database, named out loud
 *
 * ## How the target is applied
 *
 * The chosen connection is placed into the child process's environment. Prisma
 * runs `prisma.config.ts`, which calls `dotenv` on `.env.local` - and dotenv
 * does not overwrite a variable that is already set. So the value chosen here
 * wins, `prisma.config.ts` needs no change, and the staging path through it
 * still behaves exactly as it always did.
 *
 * Both `DIRECT_URL` and `DATABASE_URL` are set to the same connection. The
 * pooled/direct split exists because a hosted pooler cannot run DDL; a local
 * PostgreSQL has no pooler in front of it, and for staging both are read from
 * `.env.local` as they were.
 *
 * ## What it refuses
 *
 * A local command against a remote host, a staging command against localhost,
 * and either one against the disposable test database. Each check runs before
 * the CLI is spawned, and each fails closed on a URL it cannot parse.
 *
 * Usage: tsx scripts/prisma-cli.ts <local|staging> <prisma args...>
 */

type Target = "local" | "staging";

interface Resolved {
  readonly url: string;
  readonly host: string;
  readonly database: string;
}

function isTarget(value: string | undefined): value is Target {
  return value === "local" || value === "staging";
}

function resolve(target: Target, command: string): Resolved {
  // Only the file belonging to the chosen target is read, so a local command
  // cannot pick up a stray staging value from the other one.
  const file = target === "local" ? ".env.development.local" : ".env.local";
  loadEnv({ path: file, quiet: true });

  const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error(
      `Neither DIRECT_URL nor DATABASE_URL is set in ${file}. ` +
        (target === "local"
          ? "Copy the local development block from .env.example, then run `npm run db:dev:setup`."
          : "See .env.example."),
    );
  }

  const host = target === "local" ? assertLocalHost(url) : assertRemoteHost(url);
  assertNotDisposableTestDatabase(url, command);

  return { url, host, database: databaseNameOf(url) ?? "(unknown)" };
}

function main(): void {
  const [target, ...args] = process.argv.slice(2);

  if (!isTarget(target) || args.length === 0) {
    throw new Error("Usage: tsx scripts/prisma-cli.ts <local|staging> <prisma args...>");
  }

  const command = `prisma ${args.join(" ")}`;
  const { url, host, database } = resolve(target, command);

  // The connection string is never printed - only where it lands, which is the
  // part a person needs to see before a migration runs.
  console.log(
    target === "staging"
      ? `\n*** STAGING *** ${command} -> ${database} on ${host}\n`
      : `${command} -> ${database} on ${host} (local)`,
  );

  runPackageBin("prisma", args, {
    env: { ...process.env, DIRECT_URL: url, DATABASE_URL: url },
  });
}

try {
  main();
} catch (error: unknown) {
  // Message only. A Prisma failure already printed its own output, and an
  // error object here would add a stack trace that can carry a connection
  // string through the config file that threw it.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
