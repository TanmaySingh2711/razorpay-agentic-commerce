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

| Variable                  | Needed by                                                                                        | Server-only     |
| ------------------------- | ------------------------------------------------------------------------------------------------ | --------------- |
| `GEMINI_API_KEY`          | Gemini Provider Adapter (server-only; never a NEXT_PUBLIC_* variable)                            | yes             |
| `GEMINI_MODEL`            | Gemini Provider Adapter (defaults to `gemini-3.6-flash`)                                         | yes             |
| `RAZORPAY_KEY_ID`         | Razorpay adapter, checkout                                                                       | server-supplied |
| `RAZORPAY_KEY_SECRET`     | Razorpay adapter, signature verification                                                         | yes             |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook verification                                                                             | yes             |
| `DATABASE_URL`            | Persistence — **pooled** PostgreSQL connection used at runtime                                   | yes             |
| `DIRECT_URL`              | Persistence — **direct** connection for migrations. Optional; omit when the instance is unpooled | yes             |
| `APP_SECRET`              | Session and CSRF signing. Minimum 32 characters                                                  | yes             |

`getGeminiConfig()`, `getRazorpayConfig()`, `getDatabaseConfig()`, `getCatalogConfig()` and
`getAppSecretConfig()` throw a `ConfigurationError` when their variables are
missing. That is the intended
behaviour: a missing Razorpay secret or database URL must fail that path loudly and
immediately, not prevent the application from starting or, worse, let it start
in a degraded state that silently skips a control.

`isSectionConfigured()` answers "is this feature available?" without throwing —
useful for a demo that wants to show a disabled state.

## Secrets never leak through config errors

Validation failures report variable **names** only:

```
Invalid or missing Razorpay configuration: RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET. See .env.example.
```

A test asserts that a configured secret value appears in neither the message nor
the log payload. No variable is ever prefixed `NEXT_PUBLIC_`, so nothing here is
inlined into a client bundle.

## Files

| File                           | Tracked | Contents                                                                                   |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `.env.example`                 | **yes** | Names, documentation, placeholders. No real values.                                        |
| `.env`, `.env.local`, `.env.*` | **no**  | Real values. Git-ignored via `.env` / `.env.*` with an explicit `!.env.example` exception. |

## Adding a variable later

1. Add it to the right Zod section in `src/config/env.ts` — required-now only if
   it has a safe default.
2. Document it in `.env.example` with its tier and who reads it.
3. Read it through the accessor, inside the adapter that owns it. Never widen
   the lint exemption.
