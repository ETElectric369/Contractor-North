"use server";

import { reportError } from "@/lib/observe";

/**
 * Bridge that lets CLIENT error boundaries land a crash in the sentry_events ops sink.
 * They can't import "@/lib/observe" directly (it's server-only), so they call this server
 * action instead — it forwards to reportError → record_app_error. This is why the sink was
 * empty: React/Next auto-caught RSC + hydration errors only ever hit the DSN-less Sentry
 * no-op, never our own table. Fire-and-forget; never throws (observability must not break UI).
 */
export async function reportClientError(
  where: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    reportError(where, new Error(message || "client error"), extra);
  } catch {
    /* never let reporting throw */
  }
}
