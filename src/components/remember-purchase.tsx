"use client";

import { useEffect } from "react";
import {
  loadStoredHistory,
  rememberPurchase,
  saveStoredHistory,
} from "@/lib/purchase-history";

/**
 * Adds the purchase on this page to the browser's history. Renders nothing.
 *
 * Opening a purchase page is what saves it, so every purchase a person starts
 * - and any they come back to through a link - shows up under History without
 * them doing anything. If storage is unavailable the page works exactly the
 * same; the purchase is just not remembered here.
 */
export function RememberPurchase({
  transactionId,
}: {
  readonly transactionId: string;
}): null {
  useEffect(() => {
    const stored = loadStoredHistory();
    const next = rememberPurchase(stored, transactionId, new Date());
    if (next.length !== stored.length) saveStoredHistory(next);
  }, [transactionId]);
  return null;
}
