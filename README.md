# Razorpay Agentic Commerce

**Razorpay AI Buildathon 2026 · Track 01 — AI Growth & Agentic Commerce**

An AI buyer agent that can shop and pay for you — safely.

You type something like _"Find me the best mouse under ₹3000 and buy it"_, and
the agent reads the merchant's catalog, proposes a product, and the purchase
runs all the way through to a real Razorpay payment.

The important part is what the AI is **not** allowed to do. It can suggest a
product and nothing else. It cannot set the price, approve a purchase, retry a
payment, move the transaction forward, or declare a payment successful. Every
one of those is decided by ordinary server code that does not ask a model
anything.

> **AI proposes. The server authorizes. Razorpay executes.**

---

# Section 1 — Try it online (nothing to install)

## 🔗 Live app

### **https://razorpay-agentic-commerce-xi.vercel.app**

That link is the whole project. There is nothing to clone, install, configure,
or sign up for. Just open it in a browser.

It is a real deployment, not a mock:

- a real hosted PostgreSQL database,
- the real Google Gemini model doing the product selection,
- and real **Razorpay Test Mode** for the payment.

A complete purchase works end to end, payment included.

### About the money

**No real money can move.** The app is hard-coded to refuse any Razorpay key
that is not a Test Mode key (`rzp_test_…`). This is enforced by code that fails
to start the payment path otherwise — it is not just a promise in a README.

When the Razorpay checkout window opens, use Razorpay's own Test Mode screen.
It tells you exactly which test card, UPI ID or number to type. You never need
a real card or bank account.

### What to try

Type any of these into the box on the homepage:

- `Find me the best mechanical keyboard under ₹3000 and buy it`
- `Find me the best mouse under ₹3000 and buy it`
- `I need wireless headphones with good battery life under ₹6000`
- `Find me a webcam under ₹3000` — the shop does not sell webcams, so it will
  honestly tell you nothing matched instead of selling you a keyboard.

Try a request above ₹3000 too. That crosses the automatic spending limit, so
the system stops and asks a human to approve it before any payment screen
appears.

---

# Section 2 — Run it on your own machine

This section is only needed if you want to read, change, or test the code.
Follow the steps in order. Each one says what it is for before the command.

## Before you start

You need three things installed:

| What                                                                 | Why                                              |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| **[Node.js 24](https://nodejs.org)**                                 | Runs the app. The version is pinned in `.nvmrc`. |
| **[Docker Desktop](https://www.docker.com/products/docker-desktop)** | Runs the local PostgreSQL database.              |
| **[Git](https://git-scm.com/downloads)**                             | Downloads the code.                              |

`npm` comes with Node.js, so there is nothing extra to install for it.

Check the Node version before going further:

```bash
node --version
```

You should see `v24.x.x`. If you see anything else, install Node 24.

---

## Step 1 — Download the code

This copies the repository onto your machine and moves you into the folder.

```bash
git clone https://github.com/TanmaySingh2711/razorpay-agentic-commerce.git
cd razorpay-agentic-commerce
```

Every command from here on is run from inside this folder.

---

## Step 2 — Install the dependencies

This downloads the libraries the project uses and generates the database client
from the schema.

```bash
npm install
```

It takes a minute or two the first time. It works on a fresh clone with no
configuration — you do not need any API key yet.

---

## Step 3 — Create your settings file

The project reads its settings from a file called `.env.local`. The repository
ships a template with every setting explained and no real credentials in it.

**macOS / Linux / Git Bash:**

```bash
cp .env.example .env.local
```

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env.local
```

You do not need to edit anything inside it yet. The one value that matters right
now — the address of the local test database — is already filled in, because it
points at a throwaway container on your own machine and protects nothing.

`.env.local` is git-ignored, so anything you put in it stays on your machine.

---

## Step 4 — Start the local database

The app stores products, quotes, approvals and payments in PostgreSQL. This
command starts one inside Docker and waits until it is genuinely ready to accept
connections.

Make sure **Docker Desktop is running first**, then:

```bash
npm run db:test:up
```

Confirm it is healthy:

```bash
npm run db:test:health
```

You should see `accepting connections`.

> This container is used only by your machine. It never touches the deployed
> database.

---

## Step 5 — Set up your development database

This creates the `razorpay_agentic_dev` database inside that container, builds
all the tables, and fills the catalog with the demo merchant's products —
keyboards, mice and headphones.

```bash
npm run db:dev:setup
```

The command refuses to run against anything except your own machine, so it
cannot accidentally reach a real database.

It is safe to run again later: seeding updates existing products rather than
duplicating them, and it never deletes past transactions.

---

## Step 6 — Start the app

```bash
npm run dev
```

Then open **http://localhost:3000** in your browser.

The site loads and you can browse the catalog. Typing a request will fail at
this point, because the AI needs an API key — that is Step 7.

To stop the app, press `Ctrl + C` in the terminal.

---

## Step 7 — Add your API keys (needed for the AI and for payments)

Two features need free keys of your own. Both take a couple of minutes to get.

**7a. Get a Gemini key** — this is the AI that reads your sentence and proposes
a product.

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with a Google account and click **Create API key**
3. Copy the key

**7b. Get Razorpay Test Mode keys** — these let the checkout window open.

1. Go to **https://dashboard.razorpay.com/**
2. Sign up or sign in
3. Switch the dashboard to **Test Mode** (there is a toggle at the top — make
   sure it does **not** say Live Mode)
4. Open **Settings → API Keys** and click **Generate Test Key**
5. Copy both the **Key ID** (it starts with `rzp_test_`) and the **Key Secret**

**7c. Put them in your `.env.local`**

Open `.env.local` in any text editor and fill in these three lines:

```bash
GEMINI_API_KEY="paste-your-gemini-key-here"
RAZORPAY_KEY_ID=rzp_test_paste_yours_here
RAZORPAY_KEY_SECRET=paste-your-razorpay-secret-here
```

**7d. Restart the app** so it picks up the new values:

```bash
npm run dev
```

Now type a request on the homepage and the full flow works.

> A live Razorpay key (`rzp_live_…`) is rejected on purpose. The app refuses to
> start the payment path with one, so it is not possible to accidentally charge
> a real card.

---

## Step 8 — Buy something end to end

This is the whole demo. Do it in this order:

1. Type **`Find me the best mouse under ₹3000 and buy it`** and press **Find**.
2. The agent proposes a product. The server re-reads the real price from the
   database and freezes it as a quote — the AI's opinion of the price is never
   used.
3. Because it is under ₹3000, the spending policy approves it automatically.
   (Ask for something over ₹3000 and you will be asked to approve it by hand
   first.)
4. Click **Pay**. The Razorpay Test Mode window opens.
5. Use the test payment details Razorpay shows you on that screen.
6. You are returned to the app, which verifies the payment signature, confirms
   the payment with Razorpay, and shows the **Safety Passport** — a
   plain-English record of exactly why the purchase was allowed.

If a payment fails, you can retry it up to 3 times. Retries are never automatic
and never silent.

---

## Step 9 — Run the tests

The test suite runs entirely on your machine. It never calls Gemini, Razorpay,
or any real network service — that is blocked automatically, not left to
convention.

**One-time:** prepare the isolated test database. This is a _separate_ database
from the one in Step 5, because the test suite empties its tables between tests.

```bash
npm run db:test:setup
```

**Then run everything:**

```bash
npm run verify
```

That runs the TypeScript typecheck, ESLint, the full test suite, and a
production build — about two minutes in total.

Formatting is checked separately:

```bash
npm run format:check
```

---

## Step 10 — Useful commands

| Command                  | What it does                                            |
| ------------------------ | ------------------------------------------------------- |
| `npm run dev`            | Start the app at http://localhost:3000                  |
| `npm run build`          | Production build                                        |
| `npm run verify`         | Typecheck + lint + tests + build                        |
| `npm run format:check`   | Check code formatting                                   |
| `npm run test`           | Run the tests only                                      |
| `npm run db:test:up`     | Start the local PostgreSQL container                    |
| `npm run db:test:health` | Check that the container is accepting connections       |
| `npm run db:test:down`   | Stop the container                                      |
| `npm run db:dev:setup`   | Create + migrate + seed your local development database |
| `npm run db:seed`        | Re-seed the catalog locally (safe to repeat)            |
| `npm run db:studio`      | Open a browser UI to inspect your local database        |

Plain command names always mean **local**. Only the `:staging` variants reach
the hosted database, and each of them announces that before it connects.

---

## Troubleshooting

**`npm run db:test:up` hangs or errors** — Docker Desktop is probably not
running. Start it, wait until it reports it is running, then try again.

**Port 5432 is already in use** — another PostgreSQL is running on your machine.
Stop it, or stop this project's container with `npm run db:test:down` and free
the port first.

**The app loads but every request fails** — the Gemini key in `.env.local` is
missing or wrong. See Step 7.

**The Pay button does nothing** — the Razorpay keys are missing, or the Key ID
does not begin with `rzp_test_`. See Step 7.

**Tests refuse to run with a message about `TEST_DIRECT_URL`** — Step 3 was
skipped. Copy `.env.example` to `.env.local`. This refusal is deliberate: it
stops the test suite from ever being pointed at a real database.

**Wrong Node version** — run `node --version`. It must be `v24.x.x`.

---

## How it works

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

The catalog holds three categories — mechanical keyboards, mice and headphones —
and a category the shopper states is treated as a hard requirement. Ask for a
mouse and you cannot be sold a keyboard, even if the model suggests one: the
server refuses the proposal rather than quietly substituting something else.

## Full documentation

Read **[docs/28 — Final architecture](./docs/28-final-architecture.md)** for the
complete system in one document — diagrams, the payment flow, and how safety is
enforced.

The full set of design docs is indexed in [docs/README.md](./docs/README.md).

## Built with

- **Next.js 16** + **React 19** + **TypeScript** (strict mode)
- **PostgreSQL** via **Prisma** — Docker locally, Neon in production
- **Google Gemini** for the AI, behind a swappable adapter
- **Razorpay Test Mode** for payments, behind a swappable adapter
- **Vitest**, **ESLint**, **Prettier** for testing and code quality

One Next.js app, one database, no microservices, no agent framework — kept
deliberately simple.
