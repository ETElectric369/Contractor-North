import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/** Small pure-JS hash (FNV-1a with two seeds → 16 hex chars) for the error_events dedup key.
 *  Deliberately NOT node:crypto: this module is now pulled into the edge bundle by the
 *  instrumentation onRequestError hook, and node: URIs don't bundle for edge. The key only
 *  needs to be stable + unique-ish — a rare collision merely merges two rows in the ops log. */
function dedupKey(s: string): string {
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x9e3779b1);
}

/**
 * Report a background / best-effort failure that must NOT surface to the user but
 * also must not vanish silently. Sends it to (1) the server console and (2) our OWN
 * error_events table so the errors are a queryable ops log the operator + Claude triage
 * each session. Never throws — observability must never break the caller.
 */
export function reportError(where: string, e: unknown, extra?: Record<string, unknown>): void {
  try {
    console.error(`[${where}]`, e instanceof Error ? e.message : e, extra ?? "");
    logToDb(where, e, extra);
  } catch {
    /* never let reporting throw */
  }
}

/** Fire-and-forget upsert into error_events, deduped by a hash of where+message. */
function logToDb(where: string, e: unknown, extra?: Record<string, unknown>): void {
  try {
    const message = (e instanceof Error ? e.message : String(e ?? "")).slice(0, 500);
    const key = dedupKey(`${where}::${message}`);
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
