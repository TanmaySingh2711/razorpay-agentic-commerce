# 10 — Error handling and logging

**Implemented.** [`src/domain/errors.ts`](../src/domain/errors.ts),
[`src/lib/logger.ts`](../src/lib/logger.ts),
[`src/lib/redact.ts`](../src/lib/redact.ts).

## Error taxonomy

Every failure is classified, so callers react by category instead of matching on
message strings. Every error carries two faces: an internal one for operators,
and a deliberately dull public one for the browser.

| Category         | Class                 | HTTP | Means                                                                                     |
| ---------------- | --------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `validation`     | `ValidationError`     | 400  | Input failed schema or shape checks — client body, LLM output, webhook payload.           |
| `domain_rule`    | `DomainRuleError`     | 409  | A domain invariant was violated, e.g. an illegal state transition or a currency mismatch. |
| `authorization`  | `AuthorizationError`  | 403  | A deterministic authorization decision denied the action.                                 |
| `provider`       | `ProviderError`       | 502  | Razorpay or the LLM failed, timed out, or misbehaved. Retryable by default.               |
| `payment`        | `PaymentError`        | 402  | A payment was attempted and did not succeed.                                              |
| `configuration`  | `ConfigurationError`  | 500  | Required configuration is missing or malformed.                                           |
| `infrastructure` | `InfrastructureError` | 503  | Datastore or runtime failure. Retryable by default.                                       |
| `internal`       | `InternalError`       | 500  | A bug. Unclassified condition.                                                            |

### Two faces

```ts
error.toPublicPayload(); // { code, category, message } — safe for the browser
error.toLogPayload(); // adds the internal message, details, retryability
```

The public message defaults per category ("The payment could not be
completed.") and can be overridden only with something equally safe. Internal
messages, causes, stack traces and provider payloads never cross the HTTP
boundary. A test asserts that an invalid-transition error's public message does
not disclose the internal state names.

### Conventions

- `toAppError(thrown)` funnels anything caught into the taxonomy;
  unrecognised throwables become `internal` with the original message preserved
  **for operators only**.
- Expected business outcomes are **not** exceptions. A policy denial, a
  verification mismatch and a rejected state transition are returned as plain
  discriminated-union values — e.g. `TransitionDecision`'s `APPLY` /
  `IDEMPOTENT_NO_OP` / `INVALID` / `LATE_EVENT_RECONCILIATION_CANDIDATE` kinds
  from `resolveTransition()` in
  [`state-machine.ts`](../src/domain/transaction/state-machine.ts) — so callers
  must handle every branch and so the outcome can be audited. Exceptions are
  for genuinely exceptional conditions. (An earlier generic `Result<T, E>`
  wrapper was built for this in Objective 1 but every engine ended up with its
  own named-kind union instead; the generic wrapper had no caller and was
  removed as dead code.)
- `details` is structured and redaction-safe: identifiers, states, rule names.
  Never a payload, never a secret.

## Logging

Operational logging is for operators: what the process did, how long it took,
what broke. Every entry is one structured JSON object.

```ts
const log = createLogger({ category: "payment", correlationId });
log.child({ transactionId }).info("order created", { amountMinorUnits, currency });
```

| Field           | Purpose                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `timestamp`     | UTC ISO-8601.                                                                                                                  |
| `level`         | `debug` \| `info` \| `warn` \| `error`; filtered by `LOG_LEVEL`.                                                               |
| `category`      | Subsystem: `system`, `http`, `config`, `agent`, `catalog`, `policy`, `approval`, `transaction`, `payment`, `webhook`, `audit`. |
| `correlationId` | Ties every line of one logical request together.                                                                               |
| `transactionId` | Ties every line of one transaction together.                                                                                   |
| `message`       | Short, human-readable.                                                                                                         |
| `metadata`      | Structured context — **always redacted**.                                                                                      |

`child()` narrows context, so a transaction id is bound once and appears on
every subsequent line.

### Never logged

Enforced by [`redact.ts`](../src/lib/redact.ts), which scrubs by key name at any
depth before an entry reaches a sink:

- API keys, key secrets, webhook secrets, tokens, authorization headers, cookies
- signatures, session identifiers, credentials, private keys
- card numbers, CVV/CVC, UPI handles, OTPs
- **hidden model reasoning** — `chain_of_thought`, `reasoning`, `thinking`,
  `prompt`

Strings over 512 characters are truncated so a stray payload cannot flood the
stream. Tests assert that both a Razorpay secret and a `chain_of_thought` field
are removed while ordinary metadata survives.

## Operational logs and the audit trail are different systems

This distinction is deliberate and load-bearing.

|            | Operational log             | Audit trail                                    |
| ---------- | --------------------------- | ---------------------------------------------- |
| Audience   | Operators and developers    | The user, and anyone reviewing the transaction |
| Purpose    | Diagnose the process        | Reconstruct what happened to someone's money   |
| Durability | Sampled, rotated, discarded | Append-only, permanent, complete               |
| Ordering   | Best effort                 | Ordered per transaction                        |
| Vocabulary | Free-form messages          | A closed set of event types                    |
| Written by | `createLogger`              | The Audit Service                              |
| Schema     | `LogEntry`                  | `AuditEvent` (Zod-validated)                   |

A user-facing "why did this happen" answer must never be reconstructed from
logs, and the logger must never be used as an audit sink. See
[11](./11-explainability-and-audit.md).
