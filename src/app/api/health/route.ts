import { getRuntimeConfig } from "@/config/env";

/**
 * Liveness endpoint.
 *
 * The only route Objective 1 ships. It is not a placeholder for a future
 * domain endpoint: it answers "is the process up and is its configuration
 * valid", which is exactly what a demo and a deployment need.
 *
 * It deliberately reports no credential state and no version of any secret.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface HealthPayload {
  readonly status: "ok";
  readonly service: "razorpay-agentic-commerce";
  readonly environment: string;
  readonly timestamp: string;
}

export function buildHealthPayload(now: Date = new Date()): HealthPayload {
  return {
    status: "ok",
    service: "razorpay-agentic-commerce",
    environment: getRuntimeConfig().NODE_ENV,
    timestamp: now.toISOString(),
  };
}

export function GET(): Response {
  return Response.json(buildHealthPayload(), {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
