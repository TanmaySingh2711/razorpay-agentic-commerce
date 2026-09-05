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
 * supposed to be produced by running the flow for real.
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
 * work to do.
 *
 * Three categories, each built the same way: several viable options under the
 * ₹3,000 auto-approve ceiling that differ on the attributes a shopper would
 * actually weigh, plus a premium option above the ceiling so the approval path
 * is reachable, plus an out-of-stock and a discontinued item so the filters are
 * exercised rather than merely present.
 *
 * The category strings are the merchant's own, and they are the ones
 * `@/domain/catalog/categories` canonicalises a shopper's words onto. They are
 * matched by equality, so they are deliberately dull: `mouse`, not
 * `gaming-mice`.
 *
 * Every name here is fictional. The catalog reads like a real shop without
 * borrowing anybody's trademark, which also keeps the demo honest about being a
 * demo.
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

  // -------------------------------------------------------------------------
  // Mice
  //
  // The attribute vocabulary is shared with the keyboards where the concept is
  // shared - `connectivity`, `colour`, `ratingScore` - and specific to the
  // category where it is not (`dpi`, `weightGrams`, `programmableButtons`).
  // Shared spellings matter: the model is told to reuse the catalog's own
  // vocabulary, and a `connectivity` that meant "wireless" here and "bt" there
  // would make an exact attribute filter useless.
  // -------------------------------------------------------------------------
  {
    sku: "MS-DART-LITE",
    name: "Dart Lite Wired Optical Mouse",
    description:
      "Everyday wired optical mouse with a 1200 DPI sensor and a quiet, symmetrical shell. No software, no battery, nothing to charge.",
    category: "mouse",
    unitAmount: 79_900n, // ₹799.00
    inventory: 60,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wired",
      use: "office",
      dpi: 1200,
      programmableButtons: 0,
      weightGrams: 92,
      handedness: "ambidextrous",
      rgb: false,
      colour: "black",
      ratingScore: 3.8,
    },
  },
  {
    sku: "MS-DRIFT-BT",
    name: "Drift Silent Bluetooth Mouse",
    description:
      "Compact Bluetooth mouse with silent switches and a claimed 12-month battery on a single AA cell. Made for shared offices and late nights.",
    category: "mouse",
    unitAmount: 129_900n, // ₹1,299.00
    inventory: 45,
    status: "AVAILABLE",
    attributes: {
      connectivity: "bluetooth",
      use: "office",
      dpi: 1600,
      programmableButtons: 0,
      weightGrams: 78,
      handedness: "ambidextrous",
      batteryLifeHours: 8760,
      silentClick: true,
      rgb: false,
      colour: "grey",
      ratingScore: 4.2,
    },
  },
  {
    sku: "MS-TRACE-2K4",
    name: "Trace 2.4G Wireless Mouse",
    description:
      "Wireless productivity mouse on a 2.4 GHz USB-A receiver, with a four-step DPI switch and a rechargeable USB-C battery.",
    category: "mouse",
    unitAmount: 179_900n, // ₹1,799.00
    inventory: 38,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "2.4ghz",
      use: "productivity",
      dpi: 2400,
      programmableButtons: 2,
      weightGrams: 85,
      handedness: "right-handed",
      batteryLifeHours: 480,
      charging: "usb-c",
      rgb: false,
      colour: "white",
      ratingScore: 4.1,
    },
  },
  {
    sku: "MS-CONTOUR-ERGO",
    name: "Contour Ergo Vertical Mouse",
    description:
      "Vertical ergonomic mouse that holds the wrist in a neutral handshake position. Wireless, right-handed, with a thumb rest.",
    category: "mouse",
    unitAmount: 249_900n, // ₹2,499.00
    inventory: 22,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "2.4ghz",
      use: "productivity",
      ergonomic: true,
      dpi: 3200,
      programmableButtons: 4,
      weightGrams: 118,
      handedness: "right-handed",
      batteryLifeHours: 600,
      charging: "usb-c",
      rgb: false,
      colour: "black",
      ratingScore: 4.5,
    },
  },
  {
    sku: "MS-PULSE-6K",
    name: "Pulse 6K Lightweight Gaming Mouse",
    description:
      "Wired 62 g gaming mouse with a 6400 DPI optical sensor, six programmable buttons and PTFE feet. RGB that can be turned off.",
    category: "mouse",
    unitAmount: 299_900n, // ₹2,999.00 - exactly at the auto-approve ceiling
    inventory: 30,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wired",
      use: "gaming",
      dpi: 6400,
      programmableButtons: 6,
      weightGrams: 62,
      handedness: "ambidextrous",
      rgb: true,
      colour: "black",
      ratingScore: 4.4,
    },
  },
  {
    sku: "MS-VECTOR-12K",
    name: "Vector 12K Wireless Gaming Mouse",
    description:
      "Low-latency 2.4 GHz gaming mouse with a 12000 DPI sensor, seven programmable buttons and around 70 hours of play per charge.",
    category: "mouse",
    unitAmount: 349_900n, // ₹3,499.00
    inventory: 18,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "2.4ghz",
      use: "gaming",
      dpi: 12000,
      programmableButtons: 7,
      weightGrams: 74,
      handedness: "right-handed",
      batteryLifeHours: 70,
      charging: "usb-c",
      rgb: true,
      colour: "black",
      ratingScore: 4.6,
    },
  },
  {
    sku: "MS-APEX-26K",
    name: "Apex 26K Pro Wireless Gaming Mouse",
    description:
      "Competition-grade 58 g wireless mouse with a 26000 DPI sensor, optical switches and dual 2.4 GHz and Bluetooth connectivity.",
    category: "mouse",
    unitAmount: 449_900n, // ₹4,499.00 - above the ceiling, needs approval
    inventory: 10,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "dual",
      use: "gaming",
      dpi: 26000,
      programmableButtons: 8,
      weightGrams: 58,
      handedness: "right-handed",
      batteryLifeHours: 90,
      charging: "usb-c",
      rgb: true,
      colour: "white",
      ratingScore: 4.8,
    },
  },
  {
    sku: "MS-ATLAS-TRACK",
    name: "Atlas Trackball Workstation Mouse",
    description:
      "Stationary thumb-operated trackball for desks with no room to sweep. Bluetooth and 2.4 GHz, with eight mappable buttons.",
    category: "mouse",
    unitAmount: 599_900n, // ₹5,999.00 - above the ceiling, needs approval
    inventory: 6,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "dual",
      use: "productivity",
      ergonomic: true,
      dpi: 4000,
      programmableButtons: 8,
      weightGrams: 145,
      handedness: "right-handed",
      batteryLifeHours: 2880,
      charging: "usb-c",
      rgb: false,
      colour: "graphite",
      ratingScore: 4.7,
    },
  },
  {
    sku: "MS-QUARTZ-MINI",
    name: "Quartz Mini Travel Mouse",
    description:
      "Pocket-sized Bluetooth mouse for laptop bags. Currently awaiting restock.",
    category: "mouse",
    unitAmount: 149_900n, // ₹1,499.00 - within budget but unavailable
    inventory: 0,
    status: "OUT_OF_STOCK",
    attributes: {
      connectivity: "bluetooth",
      use: "office",
      dpi: 1600,
      programmableButtons: 0,
      weightGrams: 55,
      handedness: "ambidextrous",
      batteryLifeHours: 4380,
      rgb: false,
      colour: "silver",
      ratingScore: 3.9,
    },
  },
  {
    sku: "MS-RELIC-BALL",
    name: "Relic Ball Classic Mouse",
    description:
      "Discontinued ball-tracking mouse, retained for historical order references.",
    category: "mouse",
    unitAmount: 99_900n, // ₹999.00
    inventory: 3,
    status: "DISCONTINUED",
    attributes: {
      connectivity: "wired",
      use: "office",
      dpi: 800,
      programmableButtons: 0,
      weightGrams: 130,
      handedness: "ambidextrous",
      rgb: false,
      colour: "beige",
      ratingScore: 3.1,
    },
  },

  // -------------------------------------------------------------------------
  // Headphones
  //
  // `batteryLifeHours` is shared with the wireless mice above so "good battery
  // life" means one comparable thing across the catalog, and wired models omit
  // it entirely rather than claiming zero - an absent attribute is honest,
  // a zero would rank as the worst battery in the shop.
  // -------------------------------------------------------------------------
  {
    sku: "HP-ECHO-WIRED",
    name: "Echo Wired On-Ear Headphones",
    description:
      "Lightweight on-ear headphones with a 3.5 mm cable and an inline microphone. Nothing to pair and nothing to charge.",
    category: "headphones",
    unitAmount: 109_900n, // ₹1,099.00
    inventory: 50,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wired",
      fit: "on-ear",
      use: "music",
      microphone: true,
      noiseCancelling: "none",
      weightGrams: 168,
      foldable: true,
      colour: "black",
      ratingScore: 3.9,
    },
  },
  {
    sku: "HP-CADENCE-BT",
    name: "Cadence BT Wireless Headphones",
    description:
      "Bluetooth 5.3 over-ear headphones with around 40 hours of playback, USB-C fast charging and a foldable frame.",
    category: "headphones",
    unitAmount: 179_900n, // ₹1,799.00
    inventory: 40,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "bluetooth",
      fit: "over-ear",
      use: "music",
      microphone: true,
      noiseCancelling: "none",
      batteryLifeHours: 40,
      charging: "usb-c",
      weightGrams: 210,
      foldable: true,
      colour: "navy",
      ratingScore: 4.0,
    },
  },
  {
    sku: "HP-STUDIO-40",
    name: "Studio 40 Closed-Back Monitor Headphones",
    description:
      "Wired closed-back over-ear headphones with a coiled cable and replaceable velour pads. Made for long listening, not for commuting.",
    category: "headphones",
    unitAmount: 239_900n, // ₹2,399.00
    inventory: 20,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wired",
      fit: "over-ear",
      use: "music",
      microphone: false,
      noiseCancelling: "passive",
      weightGrams: 285,
      foldable: false,
      colour: "black",
      ratingScore: 4.4,
    },
  },
  {
    sku: "HP-RALLY-GAME",
    name: "Rally Gaming Headset",
    description:
      "Wired gaming headset with a detachable boom microphone, 50 mm drivers and an in-line volume dial. USB-A or 3.5 mm.",
    category: "headphones",
    unitAmount: 279_900n, // ₹2,799.00
    inventory: 26,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wired",
      fit: "over-ear",
      use: "gaming",
      microphone: true,
      detachableMic: true,
      noiseCancelling: "passive",
      weightGrams: 320,
      rgb: true,
      colour: "black",
      ratingScore: 4.2,
    },
  },
  {
    sku: "HP-HUSH-ANC",
    name: "Hush ANC Wireless Headphones",
    description:
      "Active noise cancelling over-ear headphones with about 35 hours of playback with ANC on, a transparency mode and USB-C charging.",
    category: "headphones",
    unitAmount: 349_900n, // ₹3,499.00
    inventory: 24,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "bluetooth",
      fit: "over-ear",
      use: "music",
      microphone: true,
      noiseCancelling: "active",
      batteryLifeHours: 35,
      charging: "usb-c",
      weightGrams: 255,
      foldable: true,
      colour: "charcoal",
      ratingScore: 4.5,
    },
  },
  {
    sku: "HP-COMMUTE-ANC",
    name: "Commute ANC Long-Life Headphones",
    description:
      "Noise cancelling wireless headphones built around battery life: roughly 60 hours with ANC on, and a 10-minute charge gives about 5 hours.",
    category: "headphones",
    unitAmount: 449_900n, // ₹4,499.00
    inventory: 16,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "bluetooth",
      fit: "over-ear",
      use: "music",
      microphone: true,
      noiseCancelling: "active",
      batteryLifeHours: 60,
      charging: "usb-c",
      weightGrams: 268,
      foldable: true,
      colour: "sand",
      ratingScore: 4.6,
    },
  },
  {
    sku: "HP-ARENA-LOWLAT",
    name: "Arena Low-Latency Wireless Gaming Headset",
    description:
      "Dual-mode gaming headset: a 2.4 GHz low-latency dongle for play and Bluetooth for everything else, with a flip-to-mute microphone.",
    category: "headphones",
    unitAmount: 549_900n, // ₹5,499.00 - above the ceiling, needs approval
    inventory: 12,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "dual",
      fit: "over-ear",
      use: "gaming",
      microphone: true,
      detachableMic: false,
      lowLatencyMode: true,
      noiseCancelling: "passive",
      batteryLifeHours: 45,
      charging: "usb-c",
      weightGrams: 298,
      rgb: true,
      colour: "black",
      ratingScore: 4.5,
    },
  },
  {
    sku: "HP-SUMMIT-PRO",
    name: "Summit Pro Adaptive ANC Headphones",
    description:
      "Flagship over-ear headphones with adaptive noise cancelling, multipoint pairing to two devices and around 50 hours of playback.",
    category: "headphones",
    unitAmount: 699_900n, // ₹6,999.00 - above the ceiling, needs approval
    inventory: 7,
    status: "AVAILABLE",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "bluetooth",
      fit: "over-ear",
      use: "music",
      microphone: true,
      noiseCancelling: "adaptive",
      multipoint: true,
      batteryLifeHours: 50,
      charging: "usb-c",
      weightGrams: 250,
      foldable: true,
      colour: "silver",
      ratingScore: 4.8,
    },
  },
  {
    sku: "HP-BREEZE-LITE",
    name: "Breeze Lite Wireless Headphones",
    description:
      "Featherweight on-ear Bluetooth headphones for travel. Currently awaiting restock.",
    category: "headphones",
    unitAmount: 199_900n, // ₹1,999.00 - within budget but unavailable
    inventory: 0,
    status: "OUT_OF_STOCK",
    attributes: {
      connectivity: "wireless",
      wirelessMode: "bluetooth",
      fit: "on-ear",
      use: "music",
      microphone: true,
      noiseCancelling: "none",
      batteryLifeHours: 28,
      charging: "usb-c",
      weightGrams: 145,
      foldable: true,
      colour: "mint",
      ratingScore: 4.0,
    },
  },
  {
    sku: "HP-VINTAGE-DJ",
    name: "Vintage DJ Monitor Headphones",
    description:
      "Discontinued DJ monitoring headphones, retained for historical order references.",
    category: "headphones",
    unitAmount: 259_900n, // ₹2,599.00
    inventory: 4,
    status: "DISCONTINUED",
    attributes: {
      connectivity: "wired",
      fit: "over-ear",
      use: "music",
      microphone: false,
      noiseCancelling: "passive",
      weightGrams: 340,
      foldable: true,
      colour: "black",
      ratingScore: 3.7,
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
