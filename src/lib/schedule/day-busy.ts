/**
 * WHAT FILLS A DAY: the ONE rule (cn-v1185).
 *
 * Lifted verbatim from the schedule's planDayTimes (src/app/(app)/schedule/actions.ts), which still
 * calls it, so the office's "morning" fitter and the website's open times read a day the same way:
 * appointments by OVERLAP (a multi-day visit fills the middle day; a visit with no end holds the hour
 * the calendar draws), placed jobs by the block the calendar draws (lib/schedule/job-block
 * jobDayBlock), and a day's own hours from job_schedule_segments (0370). A call, a cancelled visit,
 * an absorbed visit and an unsized all-day job never fill a day; neither does a job being placed (or
 * its own visit).
 *
 * TWO CALLERS, ONE RULE.
 *   - The staff caller (planDayTimes) passes no `orgId`: the reads are exactly what they always were,
 *     scoped by RLS, and a failed read reads as nothing there (as it always did; that caller lands
 *     the visit anyway and the office sees the day).
 *   - A signed-out caller on the service client (the website's open times) passes `orgId`: every read
 *     names the company by hand (no RLS there), and a failed read THROWS: "nothing is busy" from a
 *     read that never happened would offer a time that is not open.
 *
 * Not a "use server" file: it exports a plain function and a type.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { tzDayStartUtc, tzMinutesOfDay } from "@/lib/tz";
import type { Busy } from "./fit-day";
import { jobDayBlock, workDayMinutes } from "./job-block";
import { ownHoursByJobDay, segmentCols, withDayHours, type SegmentRow } from "./segment-hours";

export type DayBusyInput = {
  /** The company day, "YYYY-MM-DD". */
  dateISO: string;
  /** The company's IANA timezone. */
  tz: string;
  /** The company's WORKING day ("HH:MM"), where an untimed, sized job is drawn. */
  dayStartHm: string;
  dayEndHm: string;
  /** Jobs being placed: never in their own way (their block and their visits are skipped). */
  ownJobIds?: string[];
  /** The company, for a caller without RLS: every read adds .eq("org_id", orgId) and a failed read throws. */
  orgId?: string;
};

/** The UTC instants a company day runs between (a clock-change day is 23 or 25 hours long). */
export function companyDayBounds(dateISO: string, tz: string): { dayStart: Date; dayEnd: Date } {
  const dayStart = tzDayStartUtc(dateISO, tz);
  // The day ends at the NEXT local midnight, resolved on the calendar: a clock-change day is 23 or 25
  // hours long, and start + 24h cut it or ran an hour into tomorrow.
  const next = new Date(`${dateISO}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayEnd = tzDayStartUtc(next.toISOString().slice(0, 10), tz);
  return { dayStart, dayEnd };
}

/** Everything already holding time on `dateISO`, as minutes of the company day. */
export async function readDayBusy(supabase: SupabaseClient, input: DayBusyInput): Promise<Busy[]> {
  const { dateISO, tz, dayStartHm, dayEndHm, orgId } = input;
  const own = new Set((input.ownJobIds ?? []).map(String));
  const { dayStart, dayEnd } = companyDayBounds(dateISO, tz);
  // The company, by hand, only for the caller without RLS; the staff caller's reads stay as they were.
  const scoped = <Q,>(q: Q): Q => (orgId ? ((q as any).eq("org_id", orgId) as Q) : q);
  const failed = (what: string, error: unknown) => {
    if (orgId && error) throw new Error(`readDayBusy: the ${what} read failed`);
  };

  // Everything already holding time on this day. A CALL is excluded — it is pinned to the top and
  // costs the route nothing, so it must not push a real visit later.
  /* OVERLAP, NOT A POINT TEST. A three-day service call booked Monday OCCUPIES Tuesday, but a
     starts_at-within-the-day filter could not see it — so the fitter read Tuesday as empty and
     booked an inspection at 9am inside a day the calendar draws as full. Anything that STARTS
     before the day ends and ENDS after it starts is busy here; rows with no end are caught by the
     second arm (they start within the day and occupy their drawn hour). */
  const { data: appts, error: apptsError } = await scoped(
    supabase
      .from("appointments")
      .select("starts_at, ends_at, type, status, job_id, absorbed") // PROJECTION LAW: every column read below
      .lt("starts_at", dayEnd.toISOString())
      .or(`ends_at.gte.${dayStart.toISOString()},and(ends_at.is.null,starts_at.gte.${dayStart.toISOString()})`),
  ).limit(200);
  failed("appointments", apptsError);

  /* PLACED JOBS ARE BUSY TOO. Three audit lenses independently caught the fitter reading only
     appointments — so the day after the a-service-call-is-a-job ruling, the work it now places as
     JOBS was invisible here, and "morning" would fit a new visit straight on top of a placed job:
     the Nora double-booking, resurrected through the very change that fixed her page. Rules:
       timed job (real clock)      → busy for its real span
       untimed but sized           → busy from open for its size
       bare all-day, unsized       → ELASTIC, not busy: an unsized all-day job is exactly the day
                                     Erik squeezes a visit into ("the visit is on the way"), and
                                     blocking it would fight the workflow the rail exists for.
     A work-type appointment SUPERSEDED by its job is skipped — its job now carries the block, and
     counting both would double-width the day.
     THE SAME BLOCK THE CALENDAR DRAWS (lib/schedule/job-block jobDayBlock): a sized job is busy for its
     size, a timed one for its real span, and an all-day one that nobody sized stays elastic. */
  const wd = workDayMinutes({ start: dayStartHm, end: dayEndHm });
  const { data: dayJobs, error: jobsError } = await scoped(
    supabase
      .from("jobs")
      .select("id, scheduled_start, scheduled_end, planned_minutes, status") // PROJECTION LAW: every column read below
      .lt("scheduled_start", dayEnd.toISOString())
      .or(`scheduled_end.gte.${dayStart.toISOString()},and(scheduled_end.is.null,scheduled_start.gte.${dayStart.toISOString()})`)
      .in("status", ["scheduled", "in_progress"]),
  ).limit(100);
  failed("jobs", jobsError);

  /* A DAY'S OWN HOURS (0370) are the block that day holds: Honeysuckle's noon to 5 beside its other
     days is busy noon to 5, never its usual full day. Before 0370 there are none (the read without
     the columns), and every job holds its usual block, as before. */
  const { data: daySegs, error: segsError } = await withDayHours((h) =>
    scoped(
      supabase
        .from("job_schedule_segments")
        .select(segmentCols("job_id, start_date, end_date", h))
        .lte("start_date", dateISO)
        .gte("end_date", dateISO),
    ),
  );
  failed("job day", segsError);
  const ownHere = ownHoursByJobDay((daySegs ?? []) as unknown as SegmentRow[]);

  const busy: Busy[] = [];
  for (const j of (dayJobs ?? []) as { id?: string; scheduled_start: string | null; scheduled_end: string | null; planned_minutes: number | null }[]) {
    if (!j.scheduled_start || own.has(String(j.id ?? ""))) continue;
    const dayHours = ownHere.get(String(j.id ?? ""))?.get(dateISO) ?? null;
    const b = jobDayBlock({
      day: dateISO,
      scheduledStart: j.scheduled_start,
      scheduledEnd: j.scheduled_end,
      plannedMinutes: j.planned_minutes,
      tz,
      wd,
      dayHours,
    });
    // Elastic all-day (unsized, no hours of its own) — open to a squeezed visit.
    if (!dayHours && b.allDay && !(Number(j.planned_minutes ?? 0) > 0)) continue;
    busy.push({ startMin: b.startMin, endMin: Math.max(b.startMin + 15, b.endMin) });
  }

  for (const a of (appts ?? []) as { starts_at: string; ends_at: string | null; type: string | null; status: string | null; job_id?: string | null; absorbed?: boolean }[]) {
    if (a.status === "cancelled" || a.type === "call") continue;
    // Absorbed = its JOB owns the slot now (0237), and the jobs loop above already counted it —
    // reading both would double-book the same block against itself.
    if (a.absorbed) continue;
    // The visit of a job being placed is that job's own, never a reason to push it later.
    if (a.job_id && own.has(String(a.job_id))) continue;
    // CLAMPED TO THIS DAY: a span that started yesterday is busy from midnight; one that runs on
    // past tonight is busy to midnight. Only the middle of a multi-day booking reads as full.
    const startsToday = new Date(a.starts_at) >= dayStart;
    const startMin = startsToday ? tzMinutesOfDay(a.starts_at, tz) : 0;
    // An appointment with no end is drawn as an hour, so it occupies an hour. Reading it as a point
    // would let the next visit land inside a block he can see on his screen.
    const endsToday = a.ends_at ? new Date(a.ends_at) < dayEnd : true;
    const endMin = a.ends_at && new Date(a.ends_at) > new Date(a.starts_at)
      ? endsToday ? Math.min(24 * 60, tzMinutesOfDay(a.ends_at, tz) || 24 * 60) : 24 * 60
      : startMin + 60;
    busy.push({ startMin, endMin: Math.max(startMin + 15, endMin) });
  }
  return busy;
}
