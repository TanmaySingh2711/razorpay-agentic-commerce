import { z } from "zod";
import { checkRequestOrigin } from "@/lib/http/same-origin";
import { getRuntimeConfig } from "@/config/env";
import { jsonData, respond } from "@/lib/api-response";
import { InvalidBuyerRequestError } from "@/domain/buyer-agent/errors";
import {
  MAX_REQUEST_LENGTH,
  defaultBuyerAgentDeps,
  runBuyerAgent,
  type BuyerAgentDeps,
} from "@/services/buyer-agent/buyer-agent-service";
import type { JsonValue } from "@/lib/json";

/**
 * HTTP for the Buyer Agent.
 *
 * Kept out of `route.ts` for the same reason as the catalog handlers: a route
 * file may only export HTTP methods and segment config, leaving nowhere for a
 * dependency seam. Here the handler takes its dependencies as an argument, so
 * tests drive the real handler with a deterministic provider fake and never
 * spend a live Gemini request.
 *
 * The endpoint proposes. It creates no transaction, no quote and no payment,
 * and returns a decision the caller may act on later.
 */

/**
 * Strict: an unexpected field is a refusal, not something quietly dropped.
 *
 * The only thing this endpoint accepts from a browser is a sentence. A caller
 * that also sends `budget`, `productId`, `approved` or `policy` is probing for
 * authority it does not have, and must be told no rather than left unable to
 * tell whether the extra field did anything.
 */
const requestSchema = z.strictObject({
  message: z.string().min(1).max(MAX_REQUEST_LENGTH),
});

export function handleBuyerAgentRequest(
  request: Request,
  deps: BuyerAgentDeps = defaultBuyerAgentDeps(),
): Promise<Response> {
  return respond(async () => {
    // A model call costs quota and money. A page on another site must not be
    // able to spend either through a visitor's browser.
    const verdict = checkRequestOrigin(request, getRuntimeConfig().APP_URL);
    if (!verdict.allowed) {
      throw new InvalidBuyerRequestError("the request did not come from this site");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new InvalidBuyerRequestError("the request body was not valid JSON");
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidBuyerRequestError(
        `message must be a string of 1-${String(MAX_REQUEST_LENGTH)} characters`,
      );
    }

    const decision = await runBuyerAgent({ message: parsed.data.message }, deps);
    return jsonData(decision as unknown as JsonValue);
  });
}
