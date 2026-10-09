import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import {
  assertLocalHost,
  assertNotDisposableTestDatabase,
} from "./database-target-guard";
import { resolvePackageBin } from "./run-package-bin";

/**
 * Makes sure the local development database is up before `npm run dev`.
 *
 * Runs as `predev`, so both `npm run dev` and run_dashboard.bat get it. The
 * app reads PostgreSQL on almost every page, and the usual reason it is not
 * there is simply that Docker Desktop is not running yet - after a restart,
 * say. Without this, that showed up as a crashed merchant page and an
 * assistant that "is unavailable just now". So, in order:
 *
 *  1. if something already answers on the database port, use it;
 *  2. otherwise find Docker, start Docker Desktop if its engine is not up,
 *     and start the PostgreSQL container from `.config/docker-compose.yml`;
 *  3. create and seed the development database if it is missing, and apply
 *     any migration it has not had yet.
 *
 * It never stops `npm run dev` from starting: if the database cannot be
 * brought up, it says why and lets the app start anyway, because the pages
 * that do not need the database still work and the others now say what is
 * wrong instead of crashing.
 *
 * Local only. The connection string must name this machine
 * (`assertLocalHost`), exactly like `npm run db:dev:setup`.
 */

loadEnv({ path: ".env.development.local", quiet: true });

const COMPOSE_FILE = ".config/docker-compose.yml";
const DOCKER_START_TIMEOUT_MS = 180_000;
const POSTGRES_READY_TIMEOUT_MS = 300_000;

function log(message: string): void {
  console.log(`[database] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Where Docker Desktop puts its CLI when it is not on PATH. */
function dockerCandidates(): string[] {
  const env = process.env;
  const candidates = ["docker"];
  if (process.platform === "win32") {
    for (const base of [
      env["LOCALAPPDATA"]
        ? join(env["LOCALAPPDATA"], "Programs", "DockerDesktop")
        : undefined,
      env["ProgramFiles"] ? join(env["ProgramFiles"], "Docker", "Docker") : undefined,
    ]) {
      if (base !== undefined)
        candidates.push(join(base, "resources", "bin", "docker.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/usr/local/bin/docker",
    );
  }
  return candidates;
}

function findDocker(): string | null {
  for (const candidate of dockerCandidates()) {
    if (candidate !== "docker" && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function engineIsUp(docker: string): boolean {
  return spawnSync(docker, ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

/** Starts Docker Desktop without waiting for it. Returns false if it is not installed. */
function launchDockerDesktop(): boolean {
  const env = process.env;
  if (process.platform === "win32") {
    const apps = [
      env["LOCALAPPDATA"]
        ? join(env["LOCALAPPDATA"], "Programs", "DockerDesktop", "Docker Desktop.exe")
        : undefined,
      env["ProgramFiles"]
        ? join(env["ProgramFiles"], "Docker", "Docker", "Docker Desktop.exe")
        : undefined,
    ].filter((path): path is string => path !== undefined && existsSync(path));
    const app = apps[0];
    if (app === undefined) return false;
    spawn(app, [], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  if (process.platform === "darwin") {
    return spawnSync("open", ["-a", "Docker"], { stdio: "ignore" }).status === 0;
  }
  return false;
}

/**
 * Waits until PostgreSQL accepts a real connection, not merely a TCP one.
 *
 * Docker publishes the port before PostgreSQL is ready, and after an unclean
 * shutdown PostgreSQL spends a while recovering ("the database system is
 * starting up"). That is not a failure, so it is waited out, with a line every
 * so often so the wait does not look like a hang.
 */
async function waitForPostgres(rawUrl: string): Promise<boolean> {
  const deadline = Date.now() + POSTGRES_READY_TIMEOUT_MS;
  let nextNotice = Date.now() + 15_000;
  for (;;) {
    const client = new Client({
      connectionString: maintenanceUrl(rawUrl),
      connectionTimeoutMillis: 3_000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } catch {
      // Still starting up or recovering; try again below.
    } finally {
      await client.end().catch(() => undefined);
    }
    if (Date.now() > deadline) {
      log("PostgreSQL did not become ready within 5 minutes.");
      return false;
    }
    if (Date.now() > nextNotice) {
      log(
        "PostgreSQL is still starting (it may be recovering after Docker was closed)...",
      );
      nextNotice = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
}

async function startContainer(): Promise<boolean> {
  const docker = findDocker();
  if (docker === null) {
    log("Docker is not installed, and nothing is listening on the database port.");
    log("Install Docker Desktop, or start a local PostgreSQL 17 (see README).");
    return false;
  }

  if (!engineIsUp(docker)) {
    if (!launchDockerDesktop()) {
      log("Docker's engine is not running. Start Docker Desktop, then try again.");
      return false;
    }
    log("Starting Docker Desktop (this can take a minute the first time)...");
    const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
    while (!engineIsUp(docker)) {
      if (Date.now() > deadline) {
        log(
          "Docker Desktop did not start within 3 minutes. Open it yourself, then try again.",
        );
        return false;
      }
      await sleep(2_000);
    }
  }

  log("Starting the PostgreSQL container...");
  // Compose is a Docker CLI plugin; it is found next to the CLI it belongs to.
  const env = {
    ...process.env,
    PATH: `${dirname(docker)}${delimiter}${process.env["PATH"] ?? ""}`,
  };
  const up = spawnSync(docker, ["compose", "-f", COMPOSE_FILE, "up", "-d", "postgres"], {
    stdio: "inherit",
    env,
  });
  if (up.status !== 0) {
    log("Docker could not start the PostgreSQL container. See the messages above.");
    return false;
  }
  return true;
}

/** The maintenance database on the same server, so CREATE DATABASE can run. */
function maintenanceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/postgres";
  return url.toString();
}

type DatabaseState = "missing" | "empty" | "ready";

async function inspectDatabase(rawUrl: string): Promise<DatabaseState> {
  const name = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  const admin = new Client({ connectionString: maintenanceUrl(rawUrl) });
  await admin.connect();
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name,
    ]);
    if (found.rowCount === 0) return "missing";
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: rawUrl });
  await client.connect();
  try {
    const table = await client.query("SELECT to_regclass('public.merchant') AS present");
    const present = (table.rows[0] as { present: string | null } | undefined)?.present;
    if (present === null || present === undefined) return "empty";
    const merchants = await client.query("SELECT 1 FROM merchant LIMIT 1");
    return merchants.rowCount === 0 ? "empty" : "ready";
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const directUrl = process.env["DIRECT_URL"];
  if (directUrl === undefined || directUrl.length === 0) {
    log("No .env.development.local yet. Run `npm run db:dev:setup` (or setup.bat) once.");
    return;
  }
  const host = assertLocalHost(directUrl);
  assertNotDisposableTestDatabase(directUrl, "npm run dev");
  const url = new URL(directUrl);
  const port = Number(url.port === "" ? "5432" : url.port);

  if (!(await isPortOpen(host, port))) {
    if (!(await startContainer())) return;
  }
  if (!(await waitForPostgres(directUrl))) return;

  const state = await inspectDatabase(directUrl);
  if (state === "ready") {
    // Cheap when there is nothing to do, and it means a migration added since
    // the last run can never leave the app reading a table that is not there.
    const childEnv = { ...process.env, DIRECT_URL: directUrl, DATABASE_URL: directUrl };
    execFileSync(process.execPath, [resolvePackageBin("prisma"), "migrate", "deploy"], {
      env: childEnv,
      stdio: "pipe",
    });
    log("Development database is up to date.");
    return;
  }

  log(
    state === "missing"
      ? "Creating the development database..."
      : "Filling the empty development database...",
  );
  execFileSync(
    process.execPath,
    [resolvePackageBin("tsx"), "scripts/setup-dev-database.ts"],
    {
      stdio: "inherit",
    },
  );
}

main().catch((error: unknown) => {
  // Never block the app from starting; say what went wrong instead.
  log(
    `Could not prepare the database: ${error instanceof Error ? error.message : String(error)}`,
  );
});
