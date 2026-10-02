import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

/**
 * One-click setup: `npm run setup`, on a fresh clone, on any operating system.
 *
 * It does, in order, exactly what the README's manual steps do - and nothing a
 * reviewer would not do by hand:
 *
 *   1. checks the Node.js major version against `.nvmrc`;
 *   2. installs the locked dependencies (`npm ci`);
 *   3. creates `.env.local` from `.env.example` if there is none;
 *   4. makes sure a local PostgreSQL is listening - one that is already running
 *      is used as it is, otherwise the Docker container from
 *      `.config/docker-compose.yml` is started;
 *   5. prepares the disposable test schema (`npm run db:test:setup`);
 *   6. creates, migrates and seeds the development database
 *      (`npm run db:dev:setup`).
 *
 * ## Why this file imports nothing but Node built-ins
 *
 * It runs *before* dependencies exist - installing them is step 2 - so it
 * cannot use tsx, dotenv or pg. Node 24 executes erasable TypeScript directly,
 * which is why this is a `.ts` file run by plain `node` rather than a second
 * dialect of script living beside the others.
 *
 * ## Why it never reaches a hosted database
 *
 * The database it probes and prepares is whatever `TEST_DIRECT_URL` names,
 * and the two npm scripts it delegates to keep their own guards
 * (`scripts/database-target-guard.ts`): a non-loopback host is refused before
 * any connection is made. Nothing here relaxes that; this file only decides
 * whether a local server needs starting first.
 *
 * ## Why no shell
 *
 * Every child is spawned as `node <entry point> <args>` or as a real
 * executable, never through a shell, for the same reason
 * `scripts/run-package-bin.ts` gives: with a shell the argument array is
 * concatenated into a command string, and Node 24 warns about exactly that.
 */

const ROOT = process.cwd();
const DEFAULT_TEST_URL =
  "postgresql://razorpay:razorpay_local_test@localhost:5432/razorpay_agentic_test?sslmode=disable";
const COMPOSE_FILE = ".config/docker-compose.yml";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function step(message: string): void {
  console.log(`\n▶ ${message}`);
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/**
 * The npm CLI's JavaScript entry point.
 *
 * `npm run` exports it as `npm_execpath`. When this file is started with plain
 * `node scripts/setup.ts` instead, it is found beside the Node binary, where
 * every official Node distribution installs npm.
 */
function npmCli(): string {
  const fromNpm = process.env["npm_execpath"];
  if (fromNpm !== undefined && fromNpm.endsWith(".js") && existsSync(fromNpm)) {
    return fromNpm;
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) fail("Could not locate the npm CLI next to this Node.js.");
  return found;
}

function npm(args: readonly string[]): void {
  execFileSync(process.execPath, [npmCli(), ...args], { stdio: "inherit", cwd: ROOT });
}

/** Minimal KEY=VALUE reader for `.env.local`; dotenv is not installed yet. */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key = "", raw = ""] = match;
    values[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkNodeVersion(): void {
  const wanted = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
  const actual = process.versions.node.split(".")[0];
  if (actual !== wanted) {
    fail(
      `This project needs Node.js ${wanted}; you are running ${process.versions.node}. ` +
        "Install Node.js 24 (https://nodejs.org) and run `npm run setup` again.",
    );
  }
  console.log(`Node.js ${process.versions.node} ✓`);
}

function ensureEnvFile(): void {
  const target = join(ROOT, ".env.local");
  if (existsSync(target)) {
    console.log(".env.local already exists - left untouched ✓");
    return;
  }
  copyFileSync(join(ROOT, ".env.example"), target);
  console.log("Created .env.local from .env.example ✓");
}

async function ensureDatabase(): Promise<void> {
  const fromFile = readEnvFile(join(ROOT, ".env.local"))["TEST_DIRECT_URL"];
  const rawUrl = process.env["TEST_DIRECT_URL"] ?? fromFile ?? DEFAULT_TEST_URL;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("TEST_DIRECT_URL is not a valid connection string. See .env.example.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    fail(
      "TEST_DIRECT_URL must point at a database on this machine (localhost). " +
        "Setup never prepares a hosted database.",
    );
  }

  const port = Number(url.port === "" ? "5432" : url.port);
  if (await isPortOpen(url.hostname, port)) {
    console.log(`PostgreSQL is already listening on ${url.hostname}:${String(port)} ✓`);
    return;
  }

  if (!hasDocker()) {
    fail(
      `Nothing is listening on ${url.hostname}:${String(port)} and Docker is not installed.\n` +
        "  Either start Docker Desktop and run `npm run setup` again, or start a local\n" +
        "  PostgreSQL 17 with user `razorpay`, password `razorpay_local_test` and a\n" +
        "  database named `razorpay_agentic_test`.",
    );
  }

  console.log("Starting the local PostgreSQL container (docker compose)...");
  try {
    execFileSync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "up", "-d", "--wait", "postgres"],
      {
        stdio: "inherit",
        cwd: ROOT,
      },
    );
  } catch {
    fail("Docker could not start PostgreSQL. Is Docker Desktop running?");
  }
}

async function main(): Promise<void> {
  console.log("Razorpay Agentic Commerce - one-click setup");

  step("Checking Node.js");
  checkNodeVersion();

  step("Installing dependencies (npm ci)");
  npm(["ci", "--no-audit", "--no-fund"]);

  step("Preparing .env.local");
  ensureEnvFile();

  step("Making sure local PostgreSQL is running");
  await ensureDatabase();

  step("Preparing the disposable test database");
  npm(["run", "db:test:setup"]);

  step("Preparing the development database (migrate + seed)");
  npm(["run", "db:dev:setup"]);

  console.log(
    [
      "",
      "✔ Setup complete.",
      "",
      "  npm run dev      start the app at http://localhost:3000",
      "  npm run verify   typecheck + lint + tests + build",
      "",
      "  The AI and the payment window need your own free keys in .env.local",
      "  (GEMINI_API_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) - see README Step 7.",
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
