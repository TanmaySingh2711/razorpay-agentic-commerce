# 09 — Environment and configuration

**Implemented.** [`src/config/env.ts`](../src/config/env.ts),
[`.env.example`](../.env.example),
[`tests/config-env.test.ts`](../tests/config-env.test.ts).

## The rule

`process.env` is read in exactly one file. Everywhere else it is a lint error:

```
Read configuration through @/config/env instead of process.env.
```

The rule is scoped off for `src/config/**` (the boundary itself) and `tests/**`
(which builds fake environments to exercise validation failures).

## Runtime

The application targets **Node.js 24 LTS**, declared in two places that serve
different purposes and are therefore not redundant:

| File                                             | Role                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `package.json` → `engines.node` (`>=24.0.0 <25`) | Enforcement — npm warns or fails on a wrong runtime     |
| `.nvmrc` (`24`)                                  | Selection — `nvm use` and most CI setup actions read it |

`packageManager` pins npm. No other package manager is used.

## Tiers

Configuration is split by _when_ it must exist, which is what lets the
foundation boot with an entirely empty environment.

### Required now — always validated, always defaulted

| Variable    | Default                 | Purpose                                             |
| ----------- | ----------------------- | --------------------------------------------------- |
| `NODE_ENV`  | `development`           | Runtime mode.                                       |
| `APP_URL`   | `http://localhost:3000` | Public base URL; used later for Razorpay callbacks. |
| `LOG_LEVEL` | `info`                  | Minimum severity emitted by the operational logger. |

Every one has a default, so `getRuntimeConfig()` succeeds against `{}`. A test
asserts exactly that. **No secret is required to run, build or test this
repository today.**

### Required later — validated lazily, at the point of use

| Variable                  | Needed by                                                                                                                     | Server-only     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `GEMINI_API_KEY`          | Gemini Provider Adapter (server-only; never a NEXT_PUBLIC_* variable)                                                         | yes             |
| `GEMINI_MODEL`            | Gemini Provider Adapter (defaults to `gemini-3.6-flash`)                                                                      | yes             |
| `RAZORPAY_KEY_ID`         | Razorpay adapter; sent to the browser for Standard Checkout. Must be a Test Mode (`rzp_test_`) key id — a live key is refused | server-supplied |
| `RAZORPAY_KEY_SECRET`     | Razorpay adapter, signature verification                                                                                      | yes             |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook verification                                                                                                          | yes             |
| `DATABASE_URL`            | Persistence — **pooled** PostgreSQL connection used at runtime                                                                | yes             |
| `DIRECT_URL`              | Persistence — **direct** connection for migrations. Optional; omit when the instance is unpooled                              | yes             |
| `APP_SECRET`              | Session and CSRF signing. Minimum 32 characters                                                                               | yes             |

`getGeminiConfig()`, `getRazorpayConfig()`, `getRazorpayCredentials()`,
`getDatabaseConfig()`, `getCatalogConfig()` and
`getAppSecretConfig()` throw a `ConfigurationError` when their variables are
missing.

`getRazorpayCredentials()` is the narrower of the two Razorpay accessors: it
validates `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` alone, which is everything
payment-order creation needs. `getRazorpayConfig()` additionally requires
`RAZORPAY_WEBHOOK_SECRET` and belongs to the webhook path. Splitting them means
an unconfigured webhook cannot block order creation — a control failing a path
it has no authority over. That is the intended
behaviour: a missing Razorpay secret or database URL must fail that path loudly and
immediately, not prevent the application from starting or, worse, let it start
in a degraded state that silently skips a control.

`isSectionConfigured()` answers "is this feature available?" without throwing —
useful for a demo that wants to show a disabled state.

## Test Mode is enforced, not requested

`RAZORPAY_KEY_ID` must begin with `rzp_test_`. This application moves no real
money, and a live key would make that statement false everywhere at once — so
the rule is a validation rather than a note in this file. The smoke scripts
already refused to run against a live key; the configuration boundary now
refuses too, which matters more, because the scripts are a path a developer
takes deliberately while the config boundary is the path every deployed request
takes. The refusal names the variable and the mode, never the key.

See [26 — Staging deployment](./26-staging-deployment.md) for the deployed
variable set.

## Secrets never leak through config errors

Validation failures report variable **names**, plus why each one failed — never
a value:

```
Invalid or missing Razorpay configuration: RAZORPAY_KEY_SECRET (missing), RAZORPAY_WEBHOOK_SECRET (missing). See .env.example.
Invalid or missing Razorpay credentials configuration: RAZORPAY_KEY_ID (must be a Razorpay Test Mode key id (rzp_test_...). This application must never run against live credentials.). See .env.example.
```

`(missing)` and `(invalid)` distinguish a variable that was never set from one
that is set but breaks a rule — a distinction worth making, because without it a
refused live key reads as "the variable did not save" and the operator sets the
same value again. A rule written in this repository, such as the Test Mode
check, states itself. Zod's own messages never do: they can quote the value they
received, so they collapse to `(invalid)`.

A test asserts that a configured secret value appears in neither the message nor
the log payload. No variable is ever prefixed `NEXT_PUBLIC_`, so nothing here is
inlined into a client bundle.

## Files

| File                     | Tracked | Contents                                                                          |
| ------------------------ | ------- | --------------------------------------------------------------------------------- |
| `.env.example`           | **yes** | Names, documentation, placeholders. No real values.                               |
| `.env.local`             | **no**  | Real values, hosted Neon database. Read by staging tooling and the smoke scripts. |
| `.env.development.local` | **no**  | Local development overrides. Outranks `.env.local` for `npm run dev`.             |
| `.env`, `.env.*`         | **no**  | Git-ignored via `.env` / `.env.*` with an explicit `!.env.example` exception.     |

## Three databases, and which command reaches which

Local work never touches the hosted database. That is arranged by Next.js's own
file precedence rather than by anyone remembering to edit a file:

```
process.env  >  .env.$(NODE_ENV).local  >  .env.local  >  .env.$(NODE_ENV)  >  .env
```

`next dev` sets `NODE_ENV=development` itself, so `.env.development.local` wins
for development and `.env.local` — which holds the real staging credentials —
is never edited to switch between them. Both are git-ignored.

| Purpose                   | Address                                      | Database                                             | Disposable |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------- | ---------- |
| `npm run dev`             | `DATABASE_URL` from `.env.development.local` | local `razorpay_agentic_dev`                         | no         |
| Automated tests           | `TEST_DIRECT_URL`                            | local `razorpay_agentic_test`, schema `agentic_test` | yes        |
| Vercel / staging          | `DATABASE_URL` from Vercel's own settings    | hosted Neon PostgreSQL                               | no         |
| `db:*:staging`, `*:smoke` | `DATABASE_URL` from `.env.local`             | hosted Neon PostgreSQL                               | no         |

Development and test are separate **databases**, not two schemas in one, so the
suite's `TRUNCATE ... CASCADE` cannot reach development data across the database
boundary even if a schema name ever collided.

### What stops a local command writing to staging

- `npm run db:dev:setup` is the only local command that migrates and seeds. It
  refuses any host outside `localhost`, `127.0.0.1`, `::1` and `0.0.0.0`, checked
  against an allow-list before a single statement runs
  (`scripts/local-database-guard.ts`), and refuses to target the disposable test
  database by name.
- The test suite cannot fall back to the application's connection
  (`tests/db/test-database-url.ts`), and cannot make a live network call at all
  (`tests/support/no-network.ts`).
- `next dev` never reads `.env.local` for these two variables while
  `.env.development.local` defines them.

### Commands name their target

A command that reads like ordinary development work does ordinary development
work. Reaching the hosted database requires saying so.

| Command                                                                                                | Target                        |
| ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `db:migrate`, `db:migrate:create`, `db:migrate:deploy`, `db:status`, `db:seed`, `db:studio`            | local `razorpay_agentic_dev`  |
| `db:migrate:staging`, `db:status:staging`, `db:seed:staging`, `db:studio:staging`, `db:verify:staging` | hosted Neon PostgreSQL        |
| `db:test:*`                                                                                            | local `razorpay_agentic_test` |
| `db:dev:*`                                                                                             | local `razorpay_agentic_dev`  |

`scripts/prisma-cli.ts` is what makes this true. It loads only the env file
belonging to the chosen target, asserts the target, prints where the command is
going - and for staging, that it is staging - then puts the connection into the
child process's environment. `prisma.config.ts` still loads `.env.local`, but
`dotenv` does not overwrite a variable that is already set, so the chosen target
wins and the staging path through that file behaves exactly as it always did.

## Adding a variable later

1. Add it to the right Zod section in `src/config/env.ts` — required-now only if
   it has a safe default.
2. Document it in `.env.example` with its tier and who reads it.
3. Read it through the accessor, inside the adapter that owns it. Never widen
   the lint exemption.
