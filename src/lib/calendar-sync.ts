import "server-only";

/**
 * Two-way Google Calendar sync core (0132).
 *
 * PUSH (CN → Google, live): pushCalendarItem/deleteCalendarItem are called
 * from the job/appointment mutation actions AFTER their write succeeds. They
 * are FIRE-SAFE: everything is try/caught into reportError — a Google 4xx/5xx
 * (or no connection at all) must NEVER fail a CN mutation. CN records are
 * CN-owned: pushed tagged cn="1", re-pushed over any Google-side edit.
 *
 * PULL (Google → CN, cron): syncOrgCalendars runs per org connection —
 * incremental events.list per selected calendar → mirror into external_events
 * (read-only in CN), skipping our own cn-tagged echoes. It also runs the
 * BACKSTOP push sweep of CN items changed since last_synced_at, which covers
 * the paths that mutate schedule state in SQL (the customer pick-a-time
 * confirm, choose_schedule_slot) where no server action runs to fire the live
 * push. Used by both /api/google/sync (cron) and the settings "Sync now".
 */

import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import {
  gcalConnection,
  gcalTokenForConnection,
  gcalUpsertEvent,
  gcalDeleteEvent,
  gcalListEvents,
} from "@/lib/google-calendar";
import { jobEventBody, apptEventBody, mapGoogleEvent, isCnEvent } from "@/lib/gcal-map";

export type CalendarItemKind = "job" | "appointment";

const appBase = () =>
  (process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app").replace(/\/+$/, "");

/** Appointment statuses that should EXIST as a Google event. `proposed` stays
 *  off Google until the customer picks (the confirm flips it to `scheduled`,
 *  which the cron sweep catches); `cancelled` deletes the event. */
const APPT_PUSH_STATUSES = ["scheduled", "completed"];

const JOB_PUSH_COLS =
  "id, org_id, job_number, name, address, description, status, scheduled_start, scheduled_end, google_event_id";
const APPT_PUSH_COLS =
  "id, org_id, type, title, starts_at, ends_at, location, notes, status, google_event_id";

/** Push (or reconcile away) ONE job row. `supabase` must be able to see/write
 *  the row and the connection (staff RLS client, or service client). */
async function pushJobRow(supabase: any, token: string, calendarId: string, job: any): Promise<void> {
  const shouldHave = Boolean(job.scheduled_start) && (ACTIVE_JOB_STATUSES as string[]).includes(job.status);
  if (!shouldHave) {
    if (job.google_event_id) {
      await gcalDeleteEvent(token, calendarId, job.google_event_id);
      await supabase.from("jobs").update({ google_event_id: null }).eq("id", job.id);
    }
    return;
  }
  // Multi-segment jobs: v1 pushes ONE event spanning the overall window (the
  // scheduled_start/end mirror), marked "(multi-day)". One-event-per-segment
  // is the known upgrade; the mirror is maintained by setJobScheduleRanges.
  const { count } = await supabase
    .from("job_schedule_segments")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id);
  const body = jobEventBody(job, {
    multiSegment: (count ?? 0) > 1,
    linkUrl: `${appBase()}/jobs/${job.id}`,
  });
  const eventId = await gcalUpsertEvent(token, calendarId, job.google_event_id ?? null, body);
  if (eventId !== job.google_event_id) {
    await supabase.from("jobs").update({ google_event_id: eventId }).eq("id", job.id);
  }
}

/** Push (or reconcile away) ONE appointment row. */
async function pushApptRow(supabase: any, token: string, calendarId: string, appt: any): Promise<void> {
  const shouldHave = Boolean(appt.starts_at) && APPT_PUSH_STATUSES.includes(appt.status);
  if (!shouldHave) {
    if (appt.google_event_id) {
      await gcalDeleteEvent(token, calendarId, appt.google_event_id);
      await supabase.from("appointments").update({ google_event_id: null }).eq("id", appt.id);
    }
    return;
  }
  const body = apptEventBody(appt, { linkUrl: `${appBase()}/appointments/${appt.id}` });
  const eventId = await gcalUpsertEvent(token, calendarId, appt.google_event_id ?? null, body);
  if (eventId !== appt.google_event_id) {
    await supabase.from("appointments").update({ google_event_id: eventId }).eq("id", appt.id);
  }
}

/** The org's connection + a fresh token, or null when not connected/refreshable. */
async function connectionAuth(
  supabase: any,
  orgId?: string,
): Promise<{ conn: any; token: string; calendarId: string } | null> {
  const conn = await gcalConnection(supabase, orgId);
  if (!conn) return null;
  const token = await gcalTokenForConnection(supabase, conn);
  if (!token) return null;
  return { conn, token, calendarId: conn.calendar_id || "primary" };
}

/**
 * Live push of one CN record to Google — FIRE-SAFE (never throws, never blocks
 * the mutation's outcome; failures land in reportError → sentry_events). Call
 * AFTER the CN write succeeds, from a staff server action (uses the caller's
 * RLS client, so a cross-org id is invisible and a no-op). No connection = no-op.
 */
export async function pushCalendarItem(kind: CalendarItemKind, id: string): Promise<void> {
  try {
    const supabase = await createClient();
    const auth = await connectionAuth(supabase);
    if (!auth) return;
    if (kind === "job") {
      const { data: job } = await supabase.from("jobs").select(JOB_PUSH_COLS).eq("id", id).maybeSingle();
      if (job) await pushJobRow(supabase, auth.token, auth.calendarId, job);
    } else {
      const { data: appt } = await supabase.from("appointments").select(APPT_PUSH_COLS).eq("id", id).maybeSingle();
      if (appt) await pushApptRow(supabase, auth.token, auth.calendarId, appt);
    }
  } catch (e) {
    reportError("gcal-push", e, { kind, id });
  }
}

/**
 * Live delete of one CN record's Google event — FIRE-SAFE. Call BEFORE the DB
 * row is deleted (it reads google_event_id off the row). If the row delete then
 * fails, the event is already gone from Google but the next push recreates it
 * (the upsert falls back to create on 404/410) — self-healing, documented.
 */
export async function deleteCalendarItem(kind: CalendarItemKind, id: string): Promise<void> {
  try {
    const supabase = await createClient();
    const auth = await connectionAuth(supabase);
    if (!auth) return;
    const table = kind === "job" ? "jobs" : "appointments";
    const { data: row } = await supabase.from(table).select("id, google_event_id").eq("id", id).maybeSingle();
    if (!row?.google_event_id) return;
    await gcalDeleteEvent(auth.token, auth.calendarId, row.google_event_id);
    await supabase.from(table).update({ google_event_id: null }).eq("id", id);
  } catch (e) {
    reportError("gcal-delete", e, { kind, id });
  }
}

export interface OrgSyncResult {
  org_id: string;
  pulled: number;
  removed: number;
  swept: number;
  errors: string[];
}

/** How long an incremental sync token stays trusted before we re-baseline with
 *  a fresh full-window sync. The initial sync bakes an ABSOLUTE timeMax into
 *  the token (Google's rule), so without a re-baseline the mirror would stop
 *  seeing events past that fixed date as time marches on. */
const TOKEN_MAX_AGE_MS = 30 * 86400_000;

/**
 * One org's full sync sweep: pull the selected Google calendars into
 * external_events, then the backstop push sweep of CN items changed since
 * last_synced_at. `service` MUST be the service-role client (external_events
 * is service-write-only) with `conn` its calendar_connections row. Per-calendar
 * and per-item failures are reported and skipped — one bad apple never stalls
 * the sweep, and nothing here throws.
 */
export async function syncOrgCalendars(service: any, conn: any): Promise<OrgSyncResult> {
  const res: OrgSyncResult = { org_id: conn.org_id, pulled: 0, removed: 0, swept: 0, errors: [] };
  const startedAt = new Date().toISOString();

  let token: string | null = null;
  try {
    token = await gcalTokenForConnection(service, conn);
  } catch (e) {
    reportError("gcal-sync-token", e, { orgId: conn.org_id });
  }
  if (!token) {
    res.errors.push("No valid Google token — reconnect Google Calendar in Settings.");
    return res;
  }

  // ── PULL: mirror each selected calendar ───────────────────────────────────
  const selected: string[] = Array.isArray(conn.selected_calendars)
    ? conn.selected_calendars.filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
    : [];
  const tokens: Record<string, { token: string; at: string }> =
    conn.sync_tokens && typeof conn.sync_tokens === "object" ? { ...conn.sync_tokens } : {};

  // A deselected calendar's mirror rows + sync token go away.
  for (const key of Object.keys(tokens)) if (!selected.includes(key)) delete tokens[key];
  if (selected.length) {
    const { error } = await service
      .from("external_events")
      .delete()
      .eq("org_id", conn.org_id)
      .not("google_calendar_id", "in", `(${selected.map((s) => `"${s.replace(/"/g, "")}"`).join(",")})`);
    if (error) res.errors.push(`prune: ${error.message}`);
  } else {
    await service.from("external_events").delete().eq("org_id", conn.org_id);
  }

  for (const calId of selected) {
    try {
      const prior = tokens[calId];
      const staleBaseline = prior?.at ? Date.now() - new Date(prior.at).getTime() > TOKEN_MAX_AGE_MS : true;
      let syncToken: string | null = prior?.token && !staleBaseline ? prior.token : null;

      let page = await gcalListEvents(token, calId, syncToken);
      if (page.syncTokenExpired) {
        syncToken = null; // 410 GONE → full resync
        page = await gcalListEvents(token, calId, null);
      }
      const fullSync = syncToken === null;

      // A full (re)sync replaces the calendar's mirror wholesale — deletions
      // that happened while we had no token would otherwise linger forever.
      if (fullSync) {
        await service.from("external_events").delete().eq("org_id", conn.org_id).eq("google_calendar_id", calId);
      }

      const upserts: any[] = [];
      const removals: string[] = [];
      for (const ev of page.events) {
        if (isCnEvent(ev)) continue; // our own echo — never mirror it back
        if (ev?.status === "cancelled") {
          if (ev.id) removals.push(ev.id);
          continue;
        }
        const row = mapGoogleEvent(ev, calId);
        if (row) upserts.push({ ...row, org_id: conn.org_id, updated_at: new Date().toISOString() });
      }
      if (upserts.length) {
        const { error } = await service
          .from("external_events")
          .upsert(upserts, { onConflict: "org_id,google_calendar_id,google_event_id" });
        if (error) throw new Error(error.message);
        res.pulled += upserts.length;
      }
      if (removals.length) {
        const { error } = await service
          .from("external_events")
          .delete()
          .eq("org_id", conn.org_id)
          .eq("google_calendar_id", calId)
          .in("google_event_id", removals);
        if (error) throw new Error(error.message);
        res.removed += removals.length;
      }
      if (page.nextSyncToken) {
        // Keep the baseline timestamp across incrementals; reset it on a full sync.
        tokens[calId] = {
          token: page.nextSyncToken,
          at: fullSync ? startedAt : (prior?.at ?? startedAt),
        };
      }
    } catch (e) {
      res.errors.push(`pull ${calId}: ${e instanceof Error ? e.message : "failed"}`);
      reportError("gcal-sync-pull", e, { orgId: conn.org_id, calendarId: calId });
    }
  }

  // ── BACKSTOP push sweep: CN changes the live hooks couldn't see ──────────
  // Covers choose_schedule_slot/choose_schedule_date (pure SQL — no action
  // runs) and any hook that failed transiently. Jobs stamp updated_at in the
  // SQL confirm; appointments don't, but a confirm flips proposed→scheduled
  // and proposed items are never pushed, so "scheduled with no event id" is
  // the reliable catch for them.
  const calendarId = conn.calendar_id || "primary";
  const since = new Date(
    (conn.last_synced_at ? new Date(conn.last_synced_at).getTime() : Date.now() - 86400_000) - 5 * 60_000,
  ).toISOString();
  try {
    const [{ data: jobs }, { data: appts }, { data: unpushedAppts }] = await Promise.all([
      service.from("jobs").select(JOB_PUSH_COLS).eq("org_id", conn.org_id).gte("updated_at", since).limit(200),
      service
        .from("appointments")
        .select(APPT_PUSH_COLS)
        .eq("org_id", conn.org_id)
        .gte("updated_at", since)
        .limit(200),
      service
        .from("appointments")
        .select(APPT_PUSH_COLS)
        .eq("org_id", conn.org_id)
        .eq("status", "scheduled")
        .is("google_event_id", null)
        .gte("starts_at", new Date(Date.now() - 86400_000).toISOString())
        .limit(200),
    ]);
    const apptById = new Map<string, any>();
    for (const a of [...(appts ?? []), ...(unpushedAppts ?? [])]) apptById.set(a.id, a);
    for (const j of jobs ?? []) {
      try {
        await pushJobRow(service, token, calendarId, j);
        res.swept++;
      } catch (e) {
        reportError("gcal-sync-sweep-job", e, { orgId: conn.org_id, jobId: j.id });
      }
    }
    for (const a of apptById.values()) {
      try {
        await pushApptRow(service, token, calendarId, a);
        res.swept++;
      } catch (e) {
        reportError("gcal-sync-sweep-appt", e, { orgId: conn.org_id, apptId: a.id });
      }
    }
  } catch (e) {
    res.errors.push(`sweep: ${e instanceof Error ? e.message : "failed"}`);
    reportError("gcal-sync-sweep", e, { orgId: conn.org_id });
  }

  await service
    .from("calendar_connections")
    .update({ sync_tokens: tokens, last_synced_at: startedAt })
    .eq("id", conn.id);

  return res;
}
