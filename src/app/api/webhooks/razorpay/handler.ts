import { jsonData, jsonError } from "@/lib/api-response";
import { createLogger } from "@/lib/logger";
import { AppError } from "@/domain/errors";
import {
  processWebhook,
  defaultWebhookDeps,
  type WebhookServiceDeps,
} from "@/services/payment/webhook-service";
import type { WebhookOutcome } from "@/domain/payment/webhook";

/**
 * HTTP for the inbound provider webhook.
 *
 * Two things make this handler different from every other one in the project,
 * and both come from the same fact: the body is a signed message, not a
 * request.
 *
 * **The raw body is read first, and parsed never.** `request.text()` is called
 * before anything looks at the content, and the string is handed to the
 * verifier untouched. The provider signed bytes, and a JSON round trip does not
 * preserve them - key order, whitespace and unicode escaping all survive a
 * parse but not a re-serialisation. Reading JSON here and re-encoding it for
 * verification would reject authentic events and, far worse, would mean the
 * payload had been interpreted before it was known to be genuine.
 *
 * **The caller is told almost nothing.** Anyone on the internet can POST here.
 * A failure that explained itself would let a stranger learn whether an order
 * exists, whether an amount matched, or which header was wrong - so every
 * refusal answers the same shape, and the detail lives in the audit trail and
 * the operational log where it belongs.
 */

const log = createLogger({ category: "payment" });

/** Razorpay's documented headers. Compared lower-case; Headers is case-insensitive. */
const SIGNATURE_HEADER = "x-razorpay-signature";
const EVENT_ID_HEADER = "x-razorpay-event-id";

/**
 * How each outcome is answered.
 *
 * Everything the provider has no reason to retry is a 200, including the ones
 * that changed nothing. A duplicate, an event type we do not act on, and an
 * authenticated event that did not match our records are all correct, finished
 * decisions - answering 5xx would make Razorpay redeliver them forever.
 *
 * A refused signature is 401: it is an authentication failure and nothing else.
 */
function statusFor(outcome: WebhookOutcome): number {
  return outcome.kind === "REJECTED" ? 401 : 200;
}

export async function handleRazorpayWebhook(
  request: Request,
  deps: WebhookServiceDeps = defaultWebhookDeps(),
): Promise<Response> {
  // The raw body, before anything else. Nothing above this line inspects it.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonData({ status: "rejected" }, {}, 400);
  }

  const signature = request.headers.get(SIGNATURE_HEADER);
  const providerEventId = request.headers.get(EVENT_ID_HEADER);

  let outcome: WebhookOutcome;
  try {
    outcome = await processWebhook({ rawBody, signature, providerEventId }, deps);
  } catch (error) {
    // A transient internal failure. The service rolled its claim back with it,
    // so the provider's retry can still do the work - and it must be told this
    // delivery did not land, or it will never send it again.
    log.error("webhook processing failed", {
      // The event id is a provider reference, not a credential, and it is what
      // makes a failed delivery findable in their dashboard.
      providerEventId: providerEventId ?? "unknown",
      code: error instanceof AppError ? error.code : "UNEXPECTED",
    });
    return jsonError(error);
  }

  if (outcome.kind !== "REJECTED") {
    log.info("webhook processed", {
      providerEventId: outcome.providerEventId,
      outcome: outcome.kind,
      ...(outcome.kind === "RECONCILED"
        ? {
            transactionId: outcome.transactionId,
            transactionState: outcome.transactionState,
          }
        : {}),
    });
  }

  // One shape for every answer. A caller who cannot authenticate learns only
  // that it did not work, and a caller who can learns nothing it did not
  // already know about its own event.
  return jsonData(
    { status: outcome.kind === "REJECTED" ? "rejected" : "ok" },
    {},
    statusFor(outcome),
  );
}
