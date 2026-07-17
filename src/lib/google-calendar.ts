/**
 * Google Calendar sync (server only). OAuth code flow + the raw Calendar API
 * calls the two-way sync is built on. Tokens live in calendar_connections
 * (RLS: staff). All raw fetch — no SDK dependency.
 *
 * Two-way model (0132): CN pushes jobs/appointments as events tagged
 * extendedProperties.private.cn="1" (CN-owned; re-pushed over Google edits);
 * the pull cron mirrors the org's selected calendars into external_events
 * read-only, skipping cn-tagged echoes. See src/lib/calendar-sync.ts.
 *
 * (Audit 2026-07-16: the sync_tokens lifecycle is COMPLETE — written per calendar
 * after each sweep, pruned on deselect, 30-day re-baseline, reauth marker set here
 * on 400/401 and cleared only by the OAuth callback. 0128–0132 create no SQL
 * functions, so there are no uncalled RPCs. Don't re-flag.)
 */

import { jobEventBody, type JobForEvent } from "@/lib/gcal-map";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
// calendar.events: read/write events (the push + the per-calendar pull).
// calendar.readonly: calendarList.list — the settings picker of which of the
// user's calendars to mirror. A connection granted before this scope was added
// must RECONNECT once for the picker/pull to work.
const SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const CAL_BASE = "https://www.googleapis.com/calendar/v3";

// The OAuth callback must EXACTLY match a redirect URI registered in the Google
// console. OAUTH_REDIRECT_BASE pins it there so NEXT_PUBLIC_SITE_URL (the address
// the app prints on invites/links) can move domains without breaking the calendar
// connect. Drop the env once the new domain's /api/google/callback is registered.
const oauthBase = () =>
  process.env.OAUTH_REDIRECT_BASE || process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
const redirectUri = () => `${oauthBase()}/api/google/callback`;

export function gcalConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function gcalAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // we need a refresh token
    prompt: "consent",
    state, // CSRF nonce — verified on the callback
  });
  return `${AUTH_URL}?${p}`;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export async function gcalExchangeCode(code: string): Promise<GoogleTokens> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status})`);
  return r.json();
}

export async function gcalRefresh(refreshToken: string): Promise<GoogleTokens> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) {
    // Carry the HTTP status so callers can tell a DEAD grant (400 invalid_grant /
    // 401 revoked — reconnect required) from a transient failure worth retrying.
    const err = new Error(`Token refresh failed (${r.status})`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** The schema-free "this connection is dead, stop trying" marker: sync_tokens
 *  (JSONB) carries {"error":"reauth"} instead of per-calendar sync tokens. Set
 *  when a refresh comes back 400/401 (revoked/expired grant); cleared by the
 *  OAuth callback on reconnect. While set, every token ask short-circuits to
 *  null — no Google call, no sentry row — so a dead June-era token can't spam
 *  "Token refresh failed (400)" from the 15-min cron forever. */
export function connectionNeedsReauth(conn: any): boolean {
  return (conn?.sync_tokens as { error?: string } | null | undefined)?.error === "reauth";
}

/** The org's calendar_connections row (RLS-scoped for a user client; pass
 *  orgId to scope a SERVICE client, which sees every org's row). */
export async function gcalConnection(supabase: any, orgId?: string): Promise<any | null> {
  let q = supabase.from("calendar_connections").select("*").eq("provider", "google");
  if (orgId) q = q.eq("org_id", orgId);
  const { data } = await q.maybeSingle();
  return data ?? null;
}

/** A valid access token for a fetched connection row, refreshing (and
 *  persisting) when it's within 2 minutes of expiry. Returns null when the
 *  connection needs a reconnect — already marked broken, no refresh token, or
 *  a refresh that just came back 400/401 (dead grant → marked broken HERE, with
 *  ONE reportError on the transition; later calls skip silently until the OAuth
 *  callback clears the marker). Only TRANSIENT refresh failures still throw. */
export async function gcalTokenForConnection(supabase: any, conn: any): Promise<string | null> {
  if (connectionNeedsReauth(conn)) return null; // broken until reconnect — don't retry a dead token every 15 min
  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 120_000) return conn.access_token as string;
  if (!conn.refresh_token) return null;
  let t: GoogleTokens;
  try {
    t = await gcalRefresh(conn.refresh_token);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 400 || status === 401) {
      // invalid_grant / revoked — permanently dead. Mark the connection broken so
      // every future ask (cron, live push/delete, settings) skips it quietly.
      await supabase.from("calendar_connections").update({ sync_tokens: { error: "reauth" } }).eq("id", conn.id);
      try {
        const { reportError } = await import("@/lib/observe"); // dynamic: keeps this module importable in unit tests
        reportError("gcal-token-reauth", e, { connectionId: conn.id, orgId: conn.org_id });
      } catch {
        /* reporting must never break the caller */
      }
      return null;
    }
    throw e; // transient (5xx / network) — leave the connection alone and retry next run
  }
  await supabase
    .from("calendar_connections")
    .update({
      access_token: t.access_token,
      expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    })
    .eq("id", conn.id);
  return t.access_token;
}

/** A valid access token for the org's connection (legacy shape kept for the
 *  settings push action). `supabase` is the caller's client. */
export async function gcalAccessToken(supabase: any): Promise<{ token: string; calendarId: string } | null> {
  const conn = await gcalConnection(supabase);
  if (!conn) return null;
  const token = await gcalTokenForConnection(supabase, conn);
  if (!token) return null;
  return { token, calendarId: conn.calendar_id || "primary" };
}

const jsonHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

/** Create or update one event (PATCH the existing id, falling back to a
 *  create when Google deleted it). Returns the event id. */
export async function gcalUpsertEvent(
  token: string,
  calendarId: string,
  existingEventId: string | null,
  body: Record<string, unknown>,
): Promise<string> {
  const base = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
  if (existingEventId) {
    const r = await fetch(`${base}/${encodeURIComponent(existingEventId)}`, {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
    });
    if (r.ok) return existingEventId;
    if (r.status !== 404 && r.status !== 410) throw new Error(`Calendar update failed (${r.status})`);
    // Event was deleted in Google — fall through and recreate.
  }
  const r = await fetch(base, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Calendar create failed (${r.status})`);
  const ev = await r.json();
  return ev.id as string;
}

/** Delete one event. Already-gone (404/410) counts as success. */
export async function gcalDeleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
  const r = await fetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`Calendar delete failed (${r.status})`);
}

/** Create or update one calendar event for a job (the settings "Push Schedule
 *  to Google" action). Body now carries the cn="1" ownership tag, so re-running
 *  the push re-tags pre-two-way events too. Returns the event id. */
export async function gcalUpsertJobEvent(
  token: string,
  calendarId: string,
  job: JobForEvent & { google_event_id: string | null },
): Promise<string> {
  return gcalUpsertEvent(token, calendarId, job.google_event_id, jobEventBody(job));
}

export interface GcalCalendarEntry {
  id: string;
  summary: string;
  primary?: boolean;
}

/** The user's calendar list (settings picker). Needs the calendar.readonly
 *  scope — a pre-0132 connection throws a 403 here until reconnected. */
export async function gcalListCalendars(token: string): Promise<GcalCalendarEntry[]> {
  const out: GcalCalendarEntry[] = [];
  let pageToken: string | null = null;
  let guard = 0;
  do {
    const p = new URLSearchParams({ maxResults: "250", minAccessRole: "reader" });
    if (pageToken) p.set("pageToken", pageToken);
    const r = await fetch(`${CAL_BASE}/users/me/calendarList?${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Calendar list failed (${r.status})`);
    const j = await r.json();
    for (const it of j.items ?? []) {
      if (it?.id) out.push({ id: it.id, summary: it.summary ?? it.id, primary: !!it.primary });
    }
    pageToken = j.nextPageToken ?? null;
  } while (pageToken && guard++ < 10);
  return out;
}

/** One incremental (or initial) events.list sweep of a calendar. */
export interface GcalEventsPage {
  events: any[];
  nextSyncToken: string | null;
  /** True when the provided syncToken was rejected (410 GONE) — the caller
   *  must clear it and run a fresh full-window sync. */
  syncTokenExpired: boolean;
}

/**
 * events.list with incremental sync. With a syncToken Google returns only the
 * delta since the last sweep (including cancelled events); without one this is
 * the INITIAL full-window sync (now-60d → now+400d, singleEvents so recurring
 * series arrive as concrete instances — the window params are baked into the
 * returned sync token, which is why the caller re-baselines periodically:
 * a token minted with an absolute timeMax stops seeing events past it).
 * Handles pagination; a 410 GONE reports syncTokenExpired instead of throwing.
 */
export async function gcalListEvents(
  token: string,
  calendarId: string,
  syncToken: string | null,
): Promise<GcalEventsPage> {
  const events: any[] = [];
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  let guard = 0;
  do {
    const p = new URLSearchParams({ maxResults: "250", singleEvents: "true" });
    if (pageToken) p.set("pageToken", pageToken);
    else if (syncToken) p.set("syncToken", syncToken);
    else {
      p.set("timeMin", new Date(Date.now() - 60 * 86400_000).toISOString());
      p.set("timeMax", new Date(Date.now() + 400 * 86400_000).toISOString());
    }
    const r = await fetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 410) return { events: [], nextSyncToken: null, syncTokenExpired: true };
    if (!r.ok) throw new Error(`Calendar events list failed (${r.status})`);
    const j = await r.json();
    events.push(...(j.items ?? []));
    pageToken = j.nextPageToken ?? null;
    if (j.nextSyncToken) nextSyncToken = j.nextSyncToken;
  } while (pageToken && guard++ < 40);
  return { events, nextSyncToken, syncTokenExpired: false };
}
