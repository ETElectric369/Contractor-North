/**
 * WHICH SUBSCRIPTION AN INVOICE BELONGS TO, in either shape Stripe sends it (cn-v1209).
 *
 * A webhook event's shape is decided by the API version of the ENDPOINT that receives it, which is
 * set in the Stripe dashboard, and never by the version this app's own client is pinned to
 * (lib/stripe). Up to the 2025-02 API an invoice named its subscription at `invoice.subscription`.
 * From the 2025-03-31 API on that field is gone and the id lives at
 * `invoice.parent.subscription_details.subscription`.
 *
 * The webhook read only the old place. On an endpoint at the newer shape a declined subscription
 * card was therefore skipped whole: nothing mirrored from that event, and the owner not told.
 * Both places are read here, the old one first. Each may hold the id or the expanded subscription.
 * Anything else answers null, and the caller skips, as it always did for an invoice that belongs
 * to no subscription (a one-off invoice has neither).
 */
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const inv = invoice as
    | { subscription?: unknown; parent?: { subscription_details?: { subscription?: unknown } | null } | null }
    | null
    | undefined;
  return idOf(inv?.subscription) ?? idOf(inv?.parent?.subscription_details?.subscription);
}

/** An id, or the id of an expanded object; an empty string is no id. */
function idOf(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object") {
    const id = (v as { id?: unknown }).id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}
