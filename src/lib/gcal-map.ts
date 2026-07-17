/**
 * Pure Google-Calendar mapping for the two-way sync — NO server imports, so
 * these run in plain-Node unit tests and in client components alike.
 *
 * OWNERSHIP RULE: CN records (jobs/appointments) are CN-owned — pushed to
 * Google tagged extendedProperties.private.cn="1", and re-pushed over any
 * Google-side edit on the next sync. Google events from the org's own
 * calendars are Google-owned — mirrored read-only into external_events. The
 * cn tag is what keeps the mirror from echoing our own pushes back as
 * "external" events (the feedback-loop guard).
 */

import { appointmentTypeLabel } from "@/lib/statuses";

/** The private extendedProperty that marks an event as CN-pushed. */
export const CN_TAG_KEY = "cn";
export const CN_TAG_VALUE = "1";

/** The (subset of the) Google Calendar API event resource we consume. */
export interface GoogleEvent {
  id?: string;
  status?: string; // "confirmed" | "tentative" | "cancelled"
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/** Echo-skip: true when this Google event is one of OUR pushes (cn="1") —
 *  the pull must never mirror it back as an external event. */
export function isCnEvent(ev: GoogleEvent | null | undefined): boolean {
  return ev?.extendedProperties?.private?.[CN_TAG_KEY] === CN_TAG_VALUE;
}

/** An external_events row (sans org_id — the writer stamps that). */
export interface ExternalEventRow {
  google_calendar_id: string;
  google_event_id: string;
  title: string;
  starts_at: string; // ISO; for all_day this is <date>T00:00:00Z (a DATE carrier, not an instant)
  ends_at: string | null; // for all_day: the EXCLUSIVE end date as <date>T00:00:00Z
  all_day: boolean;
}

/**
 * Map a Google event to an external_events row, or null when it can't be
 * mirrored (no id / no start / cancelled — cancelled means DELETE, which the
 * sync handles separately). All-day events carry Google's date strings as
 * <date>T00:00:00Z: that string's DATE PART is the truth (readers must slice
 * the date out, never local-parse it, or a west-of-UTC viewer sees the
 * previous day).
 */
export function mapGoogleEvent(ev: GoogleEvent, calendarId: string): ExternalEventRow | null {
  if (!ev?.id || ev.status === "cancelled") return null;
  const startDate = ev.start?.date;
  const startDateTime = ev.start?.dateTime;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const endDate = ev.end?.date && /^\d{4}-\d{2}-\d{2}$/.test(ev.end.date) ? ev.end.date : null;
    return {
      google_calendar_id: calendarId,
      google_event_id: ev.id,
      title: (ev.summary ?? "").trim() || "(busy)",
      starts_at: `${startDate}T00:00:00Z`,
      ends_at: endDate ? `${endDate}T00:00:00Z` : null,
      all_day: true,
    };
  }
  if (!startDateTime) return null;
  const start = new Date(startDateTime);
  if (isNaN(start.getTime())) return null;
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
  return {
    google_calendar_id: calendarId,
    google_event_id: ev.id,
    title: (ev.summary ?? "").trim() || "(busy)",
    starts_at: start.toISOString(),
    ends_at: end && !isNaN(end.getTime()) && end.getTime() > start.getTime() ? end.toISOString() : null,
    all_day: false,
  };
}

/** The day keys ("YYYY-MM-DD") an ALL-DAY event covers. Google's end.date is
 *  EXCLUSIVE (a one-day event has end = start + 1 day). Pure string/UTC math —
 *  never local-parses the dates — capped at 60 days so a corrupt range can't
 *  flood the calendar. */
export function allDayEventDays(startYmd: string, endYmdExclusive: string | null): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startYmd)) return [];
  const out: string[] = [];
  const start = new Date(`${startYmd}T00:00:00Z`);
  const endMs =
    endYmdExclusive && /^\d{4}-\d{2}-\d{2}$/.test(endYmdExclusive)
      ? new Date(`${endYmdExclusive}T00:00:00Z`).getTime()
      : start.getTime() + 86_400_000;
  const d = new Date(start);
  let guard = 0;
  while (d.getTime() < endMs && guard++ < 60) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ── CN → Google event bodies ────────────────────────────────────────────────

/** The CN-ownership tag every pushed event carries (echo-skip + provenance). */
function cnTag(kind: "job" | "appointment", id: string) {
  return { private: { [CN_TAG_KEY]: CN_TAG_VALUE, cn_kind: kind, cn_id: id } };
}

export interface JobForEvent {
  id: string;
  job_number: string | null;
  name: string | null;
  address: string | null;
  description: string | null;
  scheduled_start: string; // must be present — an unscheduled job is a DELETE, not a push
  scheduled_end: string | null;
}

/**
 * A CN job's Google event body: the job's OVERALL scheduled window (a
 * multi-segment job is v1'd as one event spanning min-start → max-end, marked
 * "(multi-day)" — one-event-per-segment is the known upgrade). End defaults
 * to start + 8h (the historic push behavior) and is forced after start.
 */
export function jobEventBody(job: JobForEvent, opts?: { multiSegment?: boolean; linkUrl?: string | null }) {
  const start = new Date(job.scheduled_start);
  let end = job.scheduled_end ? new Date(job.scheduled_end) : new Date(start.getTime() + 8 * 3600_000);
  if (!(end.getTime() > start.getTime())) end = new Date(start.getTime() + 8 * 3600_000);
  const summaryBase = [job.job_number, job.name].filter(Boolean).join(" — ") || "Job";
  const description = [job.description, opts?.linkUrl ? `Contractor North: ${opts.linkUrl}` : null]
    .filter(Boolean)
    .join("\n\n");
  return {
    summary: opts?.multiSegment ? `${summaryBase} (multi-day)` : summaryBase,
    location: job.address ?? undefined,
    description: description || undefined,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: cnTag("job", job.id),
  };
}

export interface ApptForEvent {
  id: string;
  type: string | null;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  notes: string | null;
}

/** A CN appointment's Google event body: starts_at → ends_at (default +1h),
 *  location, notes + a link back to the appointment in the app. */
export function apptEventBody(appt: ApptForEvent, opts?: { linkUrl?: string | null }) {
  const start = new Date(appt.starts_at);
  let end = appt.ends_at ? new Date(appt.ends_at) : new Date(start.getTime() + 3600_000);
  if (!(end.getTime() > start.getTime())) end = new Date(start.getTime() + 3600_000);
  // Label from the statuses.ts spine (pure/import-safe, so the file's no-server-imports
  // rule holds) — an inline replace(/_/g," ") pushed "[final inspection]" while the app
  // says "Final inspection".
  const typeLabel = appt.type && appt.type !== "appointment" ? `[${appointmentTypeLabel(appt.type)}] ` : "";
  const description = [appt.notes, opts?.linkUrl ? `Contractor North: ${opts.linkUrl}` : null]
    .filter(Boolean)
    .join("\n\n");
  return {
    summary: `${typeLabel}${(appt.title ?? "").trim() || "Appointment"}`,
    location: appt.location ?? undefined,
    description: description || undefined,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: cnTag("appointment", appt.id),
  };
}
