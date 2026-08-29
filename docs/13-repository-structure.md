# 13 — Repository structure

Every file listed exists and does something. There are no placeholder
directories: a folder appears when its first real file does. The homes for
future modules are named here so they land in the right place without being
pre-created as empty shells.

```
razorpay-agentic-commerce/
├── docs/                       architecture record (this directory)
├── src/
│   ├── app/                    Next.js App Router — delivery layer only
│   │   ├── api/health/route.ts liveness endpoint
│   │   ├── globals.css         minimal foundation styling
│   │   ├── layout.tsx          root layout
│   │   └── page.tsx            foundation landing page
│   ├── config/
│   │   └── env.ts              the ONLY reader of process.env
│   ├── domain/                 pure, framework-free core
│   │   ├── audit-event.ts      audit event contract
│   │   ├── decision-record.ts  explainability contract
│   │   ├── errors.ts           error taxonomy
│   │   ├── identifiers.ts      branded id types
│   │   ├── money.ts            integer minor units + currency
│   │   └── transaction/
│   │       ├── state-machine.ts   the adjudicator (pure)
│   │       ├── states.ts          states, actors, terminal/failure sets
│   │       └── transitions.ts     the transition table
│   └── lib/                    cross-cutting primitives
│       ├── json.ts             JSON value model
│       ├── logger.ts           structured operational logging
│       ├── redact.ts           secret and reasoning scrubbing
│       └── result.ts           Result<T, E>
├── tests/                      Vitest suites, mirroring src by concern
├── .env.example                tracked, credential-free template
├── eslint.config.mjs           lint rules incl. the process.env ban
├── next.config.ts
├── package.json
├── tsconfig.json               strict settings
└── vitest.config.mts
```

## Why each area exists

| Area                      | Reason it is a boundary                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                | The delivery layer. UI and route handlers, nothing else. Business logic here would make the rules untestable without a server and unreachable from anything but HTTP.                                                                                      |
| `src/config/`             | The single reader of the environment. Isolating it makes "no secret required to boot" a checkable property and stops ad-hoc `process.env` access spreading.                                                                                                |
| `src/domain/`             | The financial core: pure, dependency-free, exhaustively testable. This is where the invariants live. It imports nothing that could pull in a framework, a provider, or a network call.                                                                     |
| `src/domain/transaction/` | Its own folder because the lifecycle has three genuinely separate concerns — the vocabulary (`states`), the policy (`transitions`), and the adjudicator (`state-machine`) — and the transition table is data a reviewer should be able to read on its own. |
| `src/lib/`                | Cross-cutting primitives used by more than one layer. **Not a `utils.ts` dumping ground**: each file has one named responsibility, and anything domain-specific belongs in `domain/`.                                                                      |
| `tests/`                  | Kept out of `src/` so the shipped surface is obvious and the test runner needs no exclusion rules.                                                                                                                                                         |
| `docs/`                   | The design record. It is the artefact that lets a later session continue without redesigning.                                                                                                                                                              |

## Where future modules go

Created when their first real file is written, not before:

| Module                        | Home                                                   |
| ----------------------------- | ------------------------------------------------------ |
| Buyer Agent                   | `src/services/buyer-agent/`                            |
| Merchant Service + Catalog    | `src/services/merchant/`                               |
| Product Decision Engine       | `src/services/product-decision/`                       |
| Policy / Authorization Engine | `src/domain/policy/` (pure, so it belongs in the core) |
| Human Approval Gate           | `src/services/approval/`                               |
| Transaction Service           | `src/services/transaction/`                            |
| Audit Service                 | `src/services/audit/`                                  |
| Razorpay adapter              | `src/integrations/razorpay/`                           |
| LLM provider adapter          | `src/integrations/llm/`                                |
| Persistence                   | `src/integrations/persistence/`                        |
| UI components                 | `src/components/`                                      |

## Rules that keep it clean

- No source files in the repository root.
- No business logic in UI components.
- Payment logic never mixes with agent logic — separate top-level modules, and
  the agent has no dependency edge to the Razorpay adapter.
- Policy logic never lives in a route handler; handlers call one service.
- Database access is confined to `src/integrations/persistence/`.
- No `utils.ts`. A file is named for what it owns.
- No duplicate type definitions: a type lives with the module that owns it and
  is imported, never re-declared.
- Path alias `@/*` is configured once in `tsconfig.json` and reused by Vitest.
