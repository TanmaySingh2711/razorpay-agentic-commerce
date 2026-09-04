# Razorpay Agentic Commerce

**Razorpay AI Buildathon 2026 · Track 01 — AI Growth & Agentic Commerce**

An AI buyer agent that can shop and pay for you — safely. You type something
like _"Find me the best mechanical keyboard under ₹3000 and buy it"_, and the
agent finds a product and completes the purchase. The AI only ever **suggests**;
your server always decides the price, checks the rules, and is the only thing
that can actually spend money.

## 🔗 Try it online — nothing to install

**Live app: [razorpay-agentic-commerce-xi.vercel.app](https://razorpay-agentic-commerce-xi.vercel.app)**

This is a real, working deployment. It uses a real hosted database and real
**Razorpay Test Mode** — so a full purchase, including payment, works end to
end. No real money ever moves: the app is hard-coded to refuse any Razorpay key
that isn't a test key.

To pay at checkout, use Razorpay's own Test Mode screen — it tells you exactly
what test card, UPI ID, or number to enter. No real card or bank account needed.

You do not need to clone this repo, install anything, or have an API key to
review the project. The link above is the whole app.

## Running it on your own machine

Only needed if you want to read or change the code. You'll need:

- **Node.js 24** ([download](https://nodejs.org)) — `.nvmrc` pins this version
- **Docker Desktop** ([download](https://www.docker.com/products/docker-desktop)) — runs the local database
- **npm** (comes with Node.js)

### Steps

```bash
# 1. Get the code
git clone https://github.com/TanmaySingh2711/razorpay-agentic-commerce.git
cd razorpay-agentic-commerce

# 2. Install dependencies
npm install

# 3. Start a local PostgreSQL database in Docker
npm run db:test:up

# 4. Create, migrate and seed your local dev database
npm run db:dev:setup

# 5. Start the app
npm run dev
```

Open **http://localhost:3000** — that's it. No `.env` file and no API key is
required just to start the app and browse it.

### If you want the AI or real payments to work locally

The buyer agent needs a **Gemini API key**, and payments need a **Razorpay Test
Mode key**. Both are free and take a couple of minutes to get:

1. Copy the template: `cp .env.example .env.local`
2. Get a free Gemini key from [Google AI Studio](https://aistudio.google.com/apikey)
3. Get free Razorpay **Test Mode** keys from the [Razorpay Dashboard](https://dashboard.razorpay.com/) (Test Mode, not Live Mode)
4. Paste both into `.env.local`
5. Restart `npm run dev`

Nothing in this project ever reads a real (`rzp_live_…`) Razorpay key — it's
refused on purpose, so it's impossible to accidentally take real money.

### Running the test suite

```bash
npm run db:test:setup   # one-time: prepares an isolated test database
npm run verify           # typecheck + lint + tests + production build
```

Everything here runs locally. Tests never call Gemini, Razorpay, or any real
network service — that's enforced automatically, not just a convention.

## What this project actually does

| Piece                | What it's for                                                 |
| -------------------- | ------------------------------------------------------------- |
| Buyer agent (Gemini) | Reads your request, proposes a product — nothing more         |
| Trusted price quote  | The server re-checks the real price and freezes it            |
| Policy engine        | Decides automatically: allow, ask a human, or block           |
| Human approval       | A one-time, single-use approval for anything above your limit |
| Inventory hold       | Stock is reserved before payment, so nothing oversells        |
| Razorpay payment     | Server-controlled amount, Test Mode only                      |
| Retry                | Up to 3 tries if a payment fails, never silently repeated     |
| Audit trail          | Every decision is logged with a reason — readable by a human  |
| Safety Passport      | A plain-English summary of why each purchase was allowed      |

**The one rule everything else follows:**

> The AI can propose. Only your server can authorize. Only Razorpay moves money.

## Full documentation

Read **[docs/28 — Final architecture](./docs/28-final-architecture.md)** for
the complete system in one document — diagrams, the payment flow, and how
safety is enforced.

The full set of design docs is indexed in [docs/README.md](./docs/README.md).

## Useful commands

| Command                | What it does                     |
| ---------------------- | -------------------------------- |
| `npm run dev`          | Start the app locally            |
| `npm run build`        | Production build                 |
| `npm run verify`       | typecheck + lint + tests + build |
| `npm run format:check` | Check code formatting            |
| `npm run db:test:up`   | Start the local Docker database  |
| `npm run db:dev:setup` | Set up your local dev database   |

More database commands are documented in [docs/16-database.md](./docs/16-database.md).

## Built with

- **Next.js 16** + **React 19** + **TypeScript** (strict mode)
- **PostgreSQL** via **Prisma** — Docker locally, Neon in production
- **Google Gemini** for the AI, behind a swappable adapter
- **Razorpay Test Mode** for payments, behind a swappable adapter
- **Vitest**, **ESLint**, **Prettier** for testing and code quality

One Next.js app, one database, no microservices, no agent framework — kept
deliberately simple.
