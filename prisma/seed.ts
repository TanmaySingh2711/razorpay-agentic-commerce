import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "../src/generated/prisma/client";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Deterministic, idempotent demo seed.
 *
 * Running it repeatedly must converge on the same rows rather than accumulate
 * duplicates, so every write is an upsert against a stable key.
 *
 * Two singleton entities - the demo buyer and their policy - have no natural
 * unique key, because a demo BuyerProfile deliberately carries no email,
 * handle or credential. They therefore use fixed UUIDs declared here. That is
 * the whole reason these constants exist; nothing else should reference them.
 *
 * What is deliberately NOT seeded: transactions, quotes, payment attempts,
 * approvals or audit events. Fabricating completed purchases would make the
 * demo look finished while proving nothing, and every one of those rows is
 * supposed to be produced by the flow later objectives build.
 *
 * Seeding is bulk administrative work, so it uses the DIRECT connection, the
 * same endpoint migrations use.
 */
const DEMO_BUYER_ID = "01930000-0000-7000-8000-00000000b001";
const DEMO_POLICY_ID = "01930000-0000-7000-8000-00000000a001";
const MERCHANT_SLUG = "keebworks-india";

const INR = "INR";

/**
 * ₹3,000.00 - the demo buyer's automatic spending ceiling, in paise.
 *
 * Chosen to sit *inside* the catalog rather than above it, so both halves of
 * the policy engine are exercised by the demo instead of only the happy one:
 * the three keyboards at ₹1,999, ₹2,499 and ₹2,899 are authorized outright,
 * while the ₹6,499 Meridian Pro produces APPROVAL_REQUIRED and hands the
 * decision to a person. A ceiling above every price would make the approval
 * path unreachable and the demo quietly meaningless.
 *
 * The boundary is inclusive: a total of exactly 300000 is allowed.
 */
const AUTO_APPROVE_CEILING = 300_000n;

interface SeedProduct {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  /** Integer minor units - paise. ₹2,499.00 is 249900. */
  readonly unitAmount: bigint;
  readonly inventory: number;
  readonly status: "AVAILABLE" | "OUT_OF_STOCK" | "DISCONTINUED";
  readonly attributes: Record<string, string | number | boolean>;
}

/**
 * A catalog with enough genuine variation that a later ranking step has real
 * work to do: three viable keyboards under ₹3,000 that differ on switch type,
 * layout, connectivity and rating - plus a premium option above budget, an
 * out-of-stock item, and a discontinued one, so filtering is also exercised.
 */
const PRODUCTS: readonly SeedProduct[] = [
  {
    sku: "KB-AURORA-TKL",
    name: "Aurora TKL Mechanical Keyboard",
    description:
      "Tenkeyless hot-swappable mechanical keyboard with linear red switches, PBT double-shot keycaps and a detachable USB-C cable.",
    category: "mechanical-keyboard",
    unitAmount: 249_900n, // ₹2,499.00
    inventory: 25,
    status: "AVAILABLE",
    attributes: {
      switchType: "linear-red",
      layout: "tkl-87",
      connectivity: "wired",
      hotSwappable: true,
      keycapMaterial: "pbt",
      backlight: "white",
      colour: "black",
      ratingScore: 4.4,
    },
  },
  {
    sku: "KB-NIMBUS-65",
    name: "Nimbus 65 Wireless Mechanical Keyboard",
    description:
      "Compact 65% wireless mechanical keyboard with tactile brown switches, Bluetooth and 2.4 GHz dual connectivity.",
    category: "mechanical-keyboard",
    unitAmount: 289_900n, // ₹2,899.00
    inventory: 12,
    status: "AVAILABLE",
    attributes: {
      switchType: "tactile-brown",
      layout: "compact-65",
      connectivity: "wireless",
      hotSwappable: true,
      keycapMaterial: "pbt",
      backlight: "rgb",
      colour: "white",
      ratingScore: 4.6,
    },
  },
  {
    sku: "KB-VOLT-60",
    name: "Volt Compact 60 Mechanical Keyboard",
    description:
      "Budget 60% mechanical keyboard with clicky blue switches and ABS keycaps. Wired, no software required.",
    category: "mechanical-keyboard",
    unitAmount: 199_900n, // ₹1,999.00
    inventory: 40,
    status: "AVAILABLE",
    attributes: {
      switchType: "clicky-blue",
      layout: "compact-60",
      connectivity: "wired",
      hotSwappable: false,
      keycapMaterial: "abs",
      backlight: "none",
      colour: "black",
      ratingScore: 3.9,
    },
  },
  {
    sku: "KB-MERIDIAN-PRO",
    name: "Meridian Pro 87 Hot-Swap Mechanical Keyboard",
    description:
      "Premium gasket-mounted tenkeyless keyboard with silent red switches, aluminium case and per-key RGB.",
    category: "mechanical-keyboard",
    unitAmount: 649_900n, // ₹6,499.00 - deliberately above the ₹3,000 budget
    inventory: 8,
    status: "AVAILABLE",
    attributes: {
      switchType: "silent-red",
      layout: "tkl-87",
      connectivity: "wireless",
      hotSwappable: true,
      keycapMaterial: "pbt",
      backlight: "per-key-rgb",
      colour: "silver",
      ratingScore: 4.8,
    },
  },
  {
    sku: "KB-COBALT-104",
    name: "Cobalt Classic 104 Mechanical Keyboard",
    description:
      "Full-size 104-key mechanical keyboard with tactile brown switches. Currently awaiting restock.",
    category: "mechanical-keyboard",
    unitAmount: 275_000n, // ₹2,750.00 - within budget but unavailable
    inventory: 0,
    status: "OUT_OF_STOCK",
    attributes: {
      switchType: "tactile-brown",
      layout: "full-104",
      connectivity: "wired",
      hotSwappable: false,
      keycapMaterial: "abs",
      backlight: "white",
      colour: "grey",
      ratingScore: 4.1,
    },
  },
  {
    sku: "KB-LEGACY-101",
    name: "Legacy Retro 101 Mechanical Keyboard",
    description:
      "Discontinued retro mechanical keyboard, retained for historical order references.",
    category: "mechanical-keyboard",
    unitAmount: 219_900n, // ₹2,199.00
    inventory: 5,
    status: "DISCONTINUED",
    attributes: {
      switchType: "clicky-blue",
      layout: "full-101",
      connectivity: "wired",
      hotSwappable: false,
      keycapMaterial: "abs",
      backlight: "none",
      colour: "beige",
      ratingScore: 3.5,
    },
  },
];

async function main(): Promise<void> {
  const connectionString = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("Neither DIRECT_URL nor DATABASE_URL is set. See .env.example.");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const buyer = await prisma.buyerProfile.upsert({
      where: { id: DEMO_BUYER_ID },
      create: { id: DEMO_BUYER_ID, displayName: "Demo Buyer" },
      update: { displayName: "Demo Buyer" },
    });

    // The policy's `version` is load-bearing, not decoration: every policy
    // evaluation records the version it decided under, so a past decision can
    // be replayed against the exact rule that produced it. That only holds if
    // the version moves when the rule moves.
    //
    // So the seed reads before it writes. Nothing changed means no write at all
    // (the seed stays idempotent); a genuine change to the ceiling, currency or
    // switch bumps the version with it. A blind upsert could do neither - it
    // would either leave the version stale after a real change, or increment it
    // on every reseed until the number meant nothing.
    const existingPolicy = await prisma.authorizationPolicy.findUnique({
      where: { id: DEMO_POLICY_ID },
    });

    if (existingPolicy === null) {
      await prisma.authorizationPolicy.create({
        data: {
          id: DEMO_POLICY_ID,
          buyerProfileId: buyer.id,
          maxAutoApproveAmount: AUTO_APPROVE_CEILING,
          currency: INR,
          autoPurchaseAllowed: true,
          status: "ACTIVE",
          version: 1,
        },
      });
    } else if (
      existingPolicy.maxAutoApproveAmount !== AUTO_APPROVE_CEILING ||
      existingPolicy.currency !== INR ||
      !existingPolicy.autoPurchaseAllowed ||
      existingPolicy.status !== "ACTIVE"
    ) {
      await prisma.authorizationPolicy.update({
        where: { id: DEMO_POLICY_ID },
        data: {
          maxAutoApproveAmount: AUTO_APPROVE_CEILING,
          currency: INR,
          autoPurchaseAllowed: true,
          status: "ACTIVE",
          version: { increment: 1 },
        },
      });
    }

    const merchant = await prisma.merchant.upsert({
      where: { slug: MERCHANT_SLUG },
      create: { slug: MERCHANT_SLUG, name: "Keebworks India", status: "ACTIVE" },
      update: { name: "Keebworks India", status: "ACTIVE" },
    });

    for (const product of PRODUCTS) {
      await prisma.product.upsert({
        where: { merchantId_sku: { merchantId: merchant.id, sku: product.sku } },
        create: {
          merchantId: merchant.id,
          sku: product.sku,
          name: product.name,
          description: product.description,
          category: product.category,
          unitAmount: product.unitAmount,
          currency: INR,
          inventory: product.inventory,
          status: product.status,
          attributes: product.attributes,
        },
        // Price, stock and status are re-asserted so a reseed restores the
        // known-good demo state without creating a second row.
        update: {
          name: product.name,
          description: product.description,
          category: product.category,
          unitAmount: product.unitAmount,
          currency: INR,
          inventory: product.inventory,
          status: product.status,
          attributes: product.attributes,
        },
      });
    }

    const [buyers, policies, merchants, products] = await Promise.all([
      prisma.buyerProfile.count(),
      prisma.authorizationPolicy.count(),
      prisma.merchant.count(),
      prisma.product.count(),
    ]);

    console.log("Seed complete");
    console.log(`  buyers    : ${String(buyers)}`);
    console.log(`  policies  : ${String(policies)}`);
    console.log(`  merchants : ${String(merchants)}`);
    console.log(`  products  : ${String(products)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
