import { handleMerchantRequest } from "@/app/api/catalog/handlers";

/**
 * Public merchant metadata.
 *
 * Node runtime because the handler reaches PostgreSQL through Prisma, and
 * force-dynamic because catalog data is authoritative and changes: this
 * endpoint must read the database on every request, never a build-time
 * snapshot. The handler also sets `cache-control: no-store`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleMerchantRequest();
}
