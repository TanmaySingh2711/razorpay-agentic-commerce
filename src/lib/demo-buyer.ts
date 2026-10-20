/**
 * The demo buyer: the one person this demo shops as.
 *
 * There is no login, so every request from the shop is made on behalf of the
 * buyer `prisma/seed.ts` creates under this id, with the ₹3,000 automatic
 * spending limit the pages describe. The id is fixed because a demo buyer
 * deliberately carries no email or handle that could be its key.
 *
 * Other buyers can exist in the same database - the checkout smoke test
 * creates its own, with a lower limit - so the shop must ask for this one by
 * id rather than take whichever row the database returns first.
 */
export const DEMO_BUYER_ID = "01930000-0000-7000-8000-00000000b001";
