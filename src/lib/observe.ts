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
 * THE THREE LEVELS (cn-v1136, migration 0399). `error` is the everyday row: filed, counted, read at
 * the morning sweep. `blocker` is platform-wide — a dead key, every webhook refused, the whole cron
 * fallen over — and its first sighting (or its return after a fix) pages North's own team (see
 * observe-blocker.ts). `trace` is a diagnostic the client ships (Nort's voice loop): kept a week by
 * the sweep, never paged, never counted as an error.
 */
export type ErrorLevel = "error" | "blocker" | "trace";

/** What record_app_error answers (0399): whether this call made the row, whether it reopened a fixed
 *  one, whether it ESCALATED a known error to a blocker for the first time (skeptic #42 S2 — false
 *  when the database does not say), the count so far, and the level the row now holds (upgraded to
 *  blocker, never downgraded). */
export type RecordedError = { id: string; inserted: boolean; reopened: boolean; escalated: boolean; event_count: number; level: string };

/**
 * Report a background / best-effort failure that must NOT surface to the user but
 * also must not vanish silently. Sends it to (1) the server console and (2) our OWN
 * error_events table so the errors are a queryable ops log the operator + Claude triage
 * each session. Never throws — observability must never break the caller.
 */
export function reportError(where: string, e: unknown, extra?: Record<string, unknown>): void {
  try {
    void recordAppError(where, e, extra, "error");
  } catch {
    /* never let reporting throw */
  }
}

/**
 * THE SAME REPORT, WAITED FOR (cn-v1129): a route that answers on the very tick it files — the
 * Stripe webhook's refusals — can have its function frozen the moment the response is out, and
 * a fire-and-forget write may never leave. This one awaits the sink's write, two seconds at most,
 * and still never throws. Use it only where the caller is about to return with nothing after.
 */
export async function reportErrorAwaited(where: string, e: unknown, extra?: Record<string, unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([recordAppError(where, e, extra, "error"), new Promise<void>((r) => { timer = setTimeout(r, 2000); })]);
  } catch {
    /* never let reporting throw */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The message of ANYTHING thrown. postgrest-js hands back errors as PLAIN OBJECTS (PostgrestError
 *  is only thrown under throwOnError), so `String(e)` logged every Supabase failure as
 *  "[object Object]" — and, because the dedup key is where::message, every distinct DB error at
 *  one call site collapsed into ONE row. Now: message · details · hint · code, else JSON. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = [o.message, o.details, o.hint, o.code].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (parts.length) return parts.join(" · ");
    try {
      return JSON.stringify(e).slice(0, 500);
    } catch {
      /* circular — fall through */
    }
  }
  return String(e ?? "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** THE TENANT, FOR FREE (0399 error_events.org_id): 68 call sites already pass `orgId` (a few
 *  `org_id`) in the extras. It is lifted onto the row's own column only when it is UUID-shaped —
 *  a job id, a number, "unknown" or nothing stays in the payload and the column stays null, so a
 *  Bug Watch filter by company never joins on a word. */
function orgOf(extra?: Record<string, unknown>): string | null {
  const v = extra?.orgId ?? extra?.org_id;
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

function parseRecorded(data: unknown): RecordedError | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  return {
    id: o.id,
    inserted: o.inserted === true,
    reopened: o.reopened === true,
    escalated: o.escalated === true,
    event_count: Number(o.event_count ?? 0),
    level: typeof o.level === "string" ? o.level : "error",
  };
}

/**
 * THE ONE WRITE INTO THE SINK (cn-v1136): the console line, then record_app_error, AWAITED, with
 * the level and the tenant. Deduped by a hash of where+message (the level is not in the key: a
 * repeat at a higher level upgrades the row, 0399). Answers what the database said — inserted,
 * reopened, the count — or null when the write failed or could not be read, and NEVER throws:
 * observability must never break the caller. reportError / reportErrorAwaited are this at
 * "error"; the blocker doors (observe-blocker.ts) read the answer to decide whether to page.
 */
export async function recordAppError(
  where: string,
  e: unknown,
  extra: Record<string, unknown> | undefined,
  level: ErrorLevel,
): Promise<RecordedError | null> {
  try {
    console.error(`[${where}]`, errorMessage(e), extra ?? "");
    const message = errorMessage(e).slice(0, 500);
    const key = dedupKey(`${where}::${message}`);
    const sb = createServiceClient();
    const { data, error } = await sb.rpc("record_app_error", {
      p_key: key,
      p_title: message || where,
      p_where: where,
      p_level: level,
      p_payload: { where, message, extra: extra ?? null } as Record<string, unknown>,
      p_org: orgOf(extra),
    });
    if (error) {
      // THE SINK'S OWN FAILURE IS SAID ON THE CONSOLE, AND NOWHERE ELSE (skeptic #42, N5): a broken
      // sink — or new code against an old function signature — used to be a silent null. Never a
      // second write: a sink that cannot write would file about itself forever.
      console.error("[error-sink] write failed", errorMessage(error));
      return null;
    }
    return parseRecorded(data);
  } catch {
    return null; // never let reporting throw
  }
}
