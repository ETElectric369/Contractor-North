/**
 * Google Calendar sync (server only). OAuth code flow + pushing scheduled
 * jobs as calendar events. Tokens live in calendar_connections (RLS: staff).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

const site = () => process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
const redirectUri = () => `${site()}/api/google/callback`;

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
  if (!r.ok) throw new Error(`Token refresh failed (${r.status})`);
  return r.json();
}

/** A valid access token for the org's connection, refreshing (and persisting)
 *  when it's within 2 minutes of expiry. `supabase` is the caller's client. */
export async function gcalAccessToken(supabase: any): Promise<{ token: string; calendarId: string } | null> {
  const { data: conn } = await supabase
    .from("calendar_connections")
    .select("*")
    .eq("provider", "google")
    .maybeSingle();
  if (!conn) return null;

  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 120_000) {
    return { token: conn.access_token, calendarId: conn.calendar_id || "primary" };
  }
  if (!conn.refresh_token) return null;

  const t = await gcalRefresh(conn.refresh_token);
  await supabase
    .from("calendar_connections")
    .update({
      access_token: t.access_token,
      expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    })
    .eq("id", conn.id);
  return { token: t.access_token, calendarId: conn.calendar_id || "primary" };
}

interface JobForSync {
  id: string;
  job_number: string;
  name: string;
  address: string | null;
  description: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  google_event_id: string | null;
}

/** Create or update one calendar event for a job. Returns the event id. */
export async function gcalUpsertJobEvent(
  token: string,
  calendarId: string,
  job: JobForSync,
): Promise<string> {
  const start = new Date(job.scheduled_start);
  const end = job.scheduled_end ? new Date(job.scheduled_end) : new Date(start.getTime() + 8 * 3600_000);
  const body = {
    summary: `${job.job_number} — ${job.name}`,
    location: job.address ?? undefined,
    description: job.description ?? undefined,
    start: { dateTime: start.toISOString() },
    end: { dateTime: (end > start ? end : new Date(start.getTime() + 8 * 3600_000)).toISOString() },
  };
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  if (job.google_event_id) {
    const r = await fetch(`${base}/${encodeURIComponent(job.google_event_id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    if (r.ok) return job.google_event_id;
    if (r.status !== 404 && r.status !== 410) throw new Error(`Calendar update failed (${r.status})`);
    // Event was deleted in Google — fall through and recreate.
  }
  const r = await fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Calendar create failed (${r.status})`);
  const ev = await r.json();
  return ev.id as string;
}
