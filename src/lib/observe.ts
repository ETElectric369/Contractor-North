import "server-only";
import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Report a background / best-effort failure that must NOT surface to the user but
 * also must not vanish silently. Sends it to (1) the server console, (2) Sentry (a
 * no-op until NEXT_PUBLIC_SENTRY_DSN is set), and (3) our OWN sentry_events table so
 * the errors are a queryable ops log the operator + Claude triage each session — no
 * Sentry webhook to configure. Never throws — observability must never break the caller.
 */
export function reportError(where: string, e: unknown, extra?: Record<string, unknown>): void {
  try {
    console.error(`[${where}]`, e instanceof Error ? e.message : e, extra ?? "");
    Sentry.captureException(e, { tags: { where }, extra });
    logToDb(where, e, extra);
  } catch {
    /* never let reporting throw */
  }
}

/** Fire-and-forget upsert into sentry_events, deduped by a hash of where+message. */
function logToDb(where: string, e: unknown, extra?: Record<string, unknown>): void {
  try {
    const message = (e instanceof Error ? e.message : String(e ?? "")).slice(0, 500);
    const key = createHash("sha1").update(`${where}::${message}`).digest("hex").slice(0, 40);
    const sb = createServiceClient();
    void sb
      .rpc("record_app_error", {
        p_key: key,
        p_title: message || where,
        p_where: where,
        p_level: "error",
        p_payload: { where, message, extra: extra ?? null } as Record<string, unknown>,
      })
      .then(() => {}, () => {}); // swallow — logging must never throw or block
  } catch {
    /* never let reporting throw */
  }
}
