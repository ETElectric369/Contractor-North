"use server";

import { reportError } from "@/lib/observe";
import { rateLimited } from "@/lib/rate-limit";

/**
 * Bridge that lets CLIENT error boundaries land a crash in the error_events ops sink.
 * They can't import "@/lib/observe" directly (it's server-only), so they call this server
 * action instead — it forwards to reportError → record_app_error. Fire-and-forget; never
 * throws (observability must not break UI).
 *
 * ── WHY THIS FILE NEEDED A DOOR (audit v800 wave B) ────────────────────────────────────────
 *
 * A "use server" action is a PUBLIC POST ENDPOINT. Its id ships in the client bundle, so anyone
 * can call it, signed in or not — and it forwards to record_app_error on the SERVICE client,
 * which is precisely the function 0182 revoked from anon because `on conflict do update` means a
 * forged key OVERWRITES a real production row in the log Erik triages every session. The revoke
 * was correct and this action walked around it.
 *
 * NOT FIXED WITH AN AUTH CHECK. Two of the five callers are the ROOT error boundaries, which fire
 * on the marketing site, on /c/<token> and on /q/<token> — pages with no session by design. A
 * signed-in gate here would silence exactly the crashes that matter most: the ones a customer
 * hits on a public door, where nobody is watching. Fixed at the shape of what can be written:
 *
 *   1. A CLOSED SET OF SOURCES. The callers are a known list, so `where` is validated against it
 *      rather than passed through. A stranger cannot invent a row, and — the actual attack —
 *      cannot forge a server-side `where` like "app-layout:org" to collide with its dedup key.
 *   2. NAMESPACED ANYWAY. Everything from here is written under `client:<source>`, so even an
 *      identical message can never hash onto a row that server code wrote.
 *   3. A SHARED CEILING. The DB-backed limiter spans instances and survives restarts, so the
 *      ops log can't be flooded into uselessness. Fails CLOSED: if the limiter is down we drop
 *      the report, because a log that can't be rate-limited is the thing being protected.
 *
 * What a stranger can still do is add noise to one of five known buckets, up to the cap. That is
 * the irreducible cost of logging errors from pages that have no session, and it is a fair trade
 * for seeing a crash on a customer's quote link.
 */

/** The five error boundaries + the one widget that report from the client. Anything else is
 *  not a caller of ours, whatever it claims to be. */
const CLIENT_SOURCES = new Set([
  "global-error",
  "error-boundary",
  "app-boundary",
  "assistant-boundary",
  "weather-widget",
]);

/** Well above a real crash loop on a bad deploy, well below "the log is now useless". */
const CLIENT_REPORTS_PER_HOUR = 500;

export async function reportClientError(
  where: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const source = CLIENT_SOURCES.has(where) ? where : "unknown";
    if (await rateLimited("client-error:hour", CLIENT_REPORTS_PER_HOUR, 3600, { failClosed: true })) return;
    reportError(`client:${source}`, new Error(String(message || "client error").slice(0, 500)), {
      ...safeExtra(extra),
      // Keep what was CLAIMED when it wasn't one of ours — an unknown source is itself a finding.
      ...(source === "unknown" ? { claimed_where: String(where).slice(0, 120) } : {}),
    });
  } catch {
    /* never let reporting throw */
  }
}

/** A crash report is a handful of short strings (digest, componentStack, url). Anything longer,
 *  deeper or wider than that is not debugging information — it's payload. */
function safeExtra(extra?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!extra || typeof extra !== "object") return out;
  for (const [k, v] of Object.entries(extra)) {
    if (Object.keys(out).length >= 8) break;
    if (!/^[a-z0-9_]{1,40}$/i.test(k)) continue;
    if (v === null || v === undefined) continue;
    out[k] = (typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, 2000);
  }
  return out;
}
