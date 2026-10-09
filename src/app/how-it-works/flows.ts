import { node, split, step, type FlowItem } from "@/components/flowchart";

/**
 * The four flowcharts on /how-it-works, as data.
 *
 * Each step names who performs it, and each is a description of code that
 * exists: the limits quoted are the defaults in `src/lib/env.ts`, the tool
 * names are the ones the Buyer Agent is given, and the states are the ones in
 * the transaction state machine. When one of those changes, this file is the
 * one place the diagrams need to follow.
 */

export const AI_FLOW: readonly FlowItem[] = [
  node(
    "person",
    "Your sentence",
    "Up to 1,000 characters, plus the conversation so far if the assistant asked you something.",
  ),
  node(
    "server",
    "Rate limits",
    "By default 5 requests a minute and 60 a day per visitor, and 1,500 a day for the whole site. Over the limit, the model is never called.",
  ),
  node(
    "ai",
    "First pass: intent",
    "Gemini turns the sentence into a structured intent: what kind of request it is, the category, the quantity and the budget.",
  ),
  node(
    "server",
    "Budget, re-read",
    "The server finds the budget in your own words and parses the amount itself. If it cannot confirm one, it asks you instead of guessing.",
  ),
  node(
    "data",
    "Catalog prefetch",
    "The server runs the most likely catalog search before the second pass, so the model starts with real products in hand.",
  ),
  node(
    "ai",
    "Second pass: selection",
    "Gemini picks one product id from what it was shown. It may call search_catalog, get_product_by_id or get_merchant_info, all of them read-only.",
  ),
  node(
    "server",
    "Selection check",
    "Was this product actually shown to the model? Right category? In stock? Within budget? Every answer is checked by code.",
  ),
  split(
    {
      label: "Every check passes",
      nodes: [
        step(
          "data",
          "Purchase opened",
          "A quote is created from the database price. This is where the money part begins.",
        ),
      ],
    },
    {
      label: "Missing detail, no match, or a failed check",
      end: "stop",
      nodes: [
        step(
          "server",
          "Nothing opened",
          "You get a question, a list of what the shop does sell, or a refusal. Nothing is created and nothing is charged.",
        ),
      ],
    },
  ),
];

export const PURCHASE_FLOW: readonly FlowItem[] = [
  node(
    "data",
    "Trusted quote",
    "The price is read from the database and frozen for 5 minutes by default. It is the only amount this purchase can ever charge.",
  ),
  node(
    "server",
    "Spending rules",
    "A fixed rule set compares the quote with your policy and returns ALLOWED, APPROVAL_REQUIRED or BLOCKED.",
  ),
  split(
    {
      label: "Up to ₹3,000",
      nodes: [step("server", "Allowed", "Authorized straight away.")],
    },
    {
      label: "Above ₹3,000",
      nodes: [
        step(
          "person",
          "Your approval",
          "You approve or reject this exact amount. The request expires after 15 minutes by default.",
        ),
      ],
    },
    {
      label: "Rules say no",
      end: "stop",
      nodes: [step("server", "Blocked", "Nothing can be held or paid.")],
    },
  ),
  node(
    "person",
    "Hold it for me",
    "The stock is reserved for 10 minutes by default, so it cannot be sold to someone else while you pay.",
  ),
  node(
    "razorpay",
    "Razorpay order",
    "Created by the server for the quoted amount. The browser never sends an amount.",
  ),
  node(
    "person",
    "Pay",
    "The Razorpay Test Mode window opens. Use the test card or UPI details it shows.",
  ),
  split(
    {
      label: "Payment goes through",
      nodes: [
        step(
          "server",
          "Signature verified",
          "PAYMENT_VERIFIED: the confirmation your browser received is authentic.",
        ),
        step(
          "razorpay",
          "Webhook: captured",
          "PAYMENT_CAPTURED: Razorpay itself confirms the money. Only this counts as paid.",
        ),
      ],
    },
    {
      label: "Payment fails",
      end: "loop",
      nodes: [
        step(
          "person",
          "Try again",
          "Up to 3 attempts in all, and only when you press retry. Retries are never automatic.",
        ),
      ],
    },
  ),
  node(
    "data",
    "Completed",
    "The held stock is committed exactly once and the purchase moves to COMPLETED.",
  ),
  node(
    "person",
    "Refund, if you want it",
    "A full refund, once, within 7 days by default. The amount is copied from the captured payment.",
  ),
];

export const DASHBOARD_MAP: readonly FlowItem[] = [
  node(
    "person",
    "Overview",
    "What this is, how the AI is built, and the work behind it.",
    "/",
  ),
  node(
    "ai",
    "Shop",
    "Type a request. The assistant answers here: a question, a suggestion, or a purchase.",
    "/shop",
  ),
  node(
    "server",
    "Purchase page",
    "The verified price, how the assistant chose, approval, the stock hold, the Safety Passport, refunds and the full timeline.",
    "/transaction/[id]",
  ),
  node(
    "razorpay",
    "Checkout",
    "The Razorpay payment window, opened only after the purchase is authorized and held.",
    "/checkout/[id]",
  ),
  split(
    {
      label: "Look back",
      nodes: [
        step(
          "data",
          "History",
          "Every purchase this browser opened, with its current status from the server.",
          "/history",
        ),
      ],
    },
    {
      label: "Understand",
      nodes: [
        step(
          "server",
          "How it works",
          "These flowcharts and the safety rules.",
          "/how-it-works",
        ),
      ],
    },
    {
      label: "Seller's view",
      nodes: [
        step(
          "data",
          "Merchant",
          "Revenue, conversion, unmet demand and payments recovered by retry.",
          "/merchant",
        ),
      ],
    },
  ),
];

export const USER_FLOW: readonly FlowItem[] = [
  node("person", "Open the shop", "From the Overview, or straight to /shop."),
  node(
    "person",
    "Type what you want",
    "Or pick one of the examples. Press Find, or Enter.",
  ),
  split(
    {
      label: "It needs a detail",
      end: "loop",
      nodes: [
        step(
          "person",
          "Answer its question",
          "Usually your budget. The same conversation continues, so you do not start over.",
        ),
      ],
    },
    {
      label: "You only asked for options",
      nodes: [
        step(
          "person",
          "Press Buy this",
          "You see a suggestion first. Nothing is opened until you choose it.",
        ),
      ],
    },
    {
      label: "Nothing matched",
      end: "stop",
      nodes: [
        step(
          "server",
          "See what it sells",
          "The shop lists its categories. Try another request.",
        ),
      ],
    },
  ),
  node(
    "server",
    "Purchase page opens",
    "Check the verified price, how the assistant chose, and the Safety Passport.",
  ),
  node(
    "person",
    "Approve, if asked",
    "Only for purchases above ₹3,000. Below that, this step is skipped.",
  ),
  node("person", "Hold it for me", "Reserves the item while you pay."),
  node(
    "razorpay",
    "Pay in Test Mode",
    "Use the test details in the Razorpay window. The page shows Completed once Razorpay confirms.",
  ),
  node(
    "person",
    "Come back any time",
    "Find it again under History. Refund it from its page within 7 days.",
  ),
];
