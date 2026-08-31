import { toAppError } from "@/domain/errors";
import { createLogger } from "@/lib/logger";
import type { JsonObject, JsonValue } from "@/lib/json";
import type { PublicErrorPayload } from "@/domain/errors";

/**
 * The HTTP envelope every API route shares.
 *
 * One shape for success, one for failure, across every endpoint. A machine
 * client should be able to write its response handling once - checking for
 * `error` and branching on `error.code` - rather than learning a new shape per
 * route. Consistency is a feature of an API meant to be consumed by software.
 *
 * The error path is the security-critical half. Anything thrown inside a
 * handler is funnelled through the project's error taxonomy and answered with
 * `toPublicPayload()`: a stable code, a category, and a dull message. Stack
 * traces, Prisma errors, SQL fragments, connection strings and internal
 * messages stop here. Operators still get the full detail, through the logger.
 */

export interface SuccessEnvelope<TData extends JsonValue> {
  readonly data: TData;
  readonly meta: JsonObject;
}

export interface ErrorEnvelope {
  readonly error: PublicErrorPayload;
}

/**
 * Catalog responses must never be cached: price, stock and availability are
 * authoritative facts that change, and a stale one could send an agent to buy
 * something at a price that no longer exists.
 */
const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

const log = createLogger({ category: "http" });

export function jsonData<TData extends JsonValue>(
  data: TData,
  meta: JsonObject = {},
  status = 200,
): Response {
  return Response.json({ data, meta } satisfies SuccessEnvelope<TData>, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

/**
 * Renders any thrown value as a safe error response.
 *
 * The status comes from the error's category, so a validation failure is a 400
 * and a missing product a 404 without a handler choosing numbers by hand. An
 * unrecognised throwable becomes an `internal` error whose original message is
 * logged and never sent.
 */
export function jsonError(thrown: unknown): Response {
  const error = toAppError(thrown);

  // Operators get everything; the caller gets the public face. Server faults
  // are worth a louder line than a caller simply sending a bad query.
  if (error.httpStatus >= 500) {
    log.error("api request failed", error.toLogPayload());
  } else {
    log.warn("api request rejected", error.toLogPayload());
  }

  return Response.json({ error: error.toPublicPayload() } satisfies ErrorEnvelope, {
    status: error.httpStatus,
    headers: NO_STORE_HEADERS,
  });
}

/**
 * Runs a handler, converting any failure into a safe error response.
 *
 * Wrapping is not optional politeness: without it, an unexpected throw inside a
 * route becomes a framework error page whose body is outside our control. This
 * guarantees every response from these endpoints is a documented envelope.
 */
export async function respond(produce: () => Promise<Response>): Promise<Response> {
  try {
    return await produce();
  } catch (error) {
    return jsonError(error);
  }
}
