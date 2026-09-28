import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_JOB_STATUSES, pickJobScheduledToday } from "@/lib/job-status";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

/**
 * WHERE THE SCHEDULE PUTS ONE PERSON ON ONE DAY: tiers 0 and 1 of the clock's precedence law,
 * asked for any day, not only today.
 *
 * The job-less clock-in (resolveTechJobToday in actions.ts) has always answered "which job is this
 * man on today" from the schedule before it guesses. Add Time Entry asks the same question about a
 * day in the past ("what was Brian on last Tuesday?") so it can start the Job field on the right job
 * instead of on nothing, which is how a no-job row used to happen. One answer, two callers, so the
 * punch and the form can never disagree about where the schedule put someone.
 *
 *   0. THE DAY ROW WINS (crew_day_assignments, 0139): the office put him on a job that day. An OFF
 *      row (0170: vacation, sick, a day off) FAILS CLOSED: { off: true }, and no tier below may guess
 *      a job for a day the office marked him off. A day row naming a job that is no longer in
 *      flight (finished, cancelled) falls through, never resurrects it.
 *   1. Else a job he is ROSTERED on (jobs.assigned_to) whose days cover the date: a
 *      job_schedule_segments row, or the job's own scheduled window, read in COMPANY days. Several
 *      match: the earliest scheduled start that day (pickJobScheduledToday, lib/job-status, given
 *      that day's bounds).
 *
 * THE ONE RESOLUTION THAT MOVED (Wave 2). The window used to be sliced out of the UTC timestamp
 * (String(scheduled_start).slice(0, 10)). A job booked at 6 PM Pacific is stored as 01:00 the next
 * morning UTC, so its window read one day late: the job "covered" the day AFTER it was booked, and a
 * punch that next day landed on it. The window is read on the company's own calendar now
 * (windowCoversDay), the same rule the "Which Job Are You On?" sheet already used. Nothing else about
 * the punch changed: same reads, same order, same statuses.
 *
 * Tier 2 (the org's only in-progress job) is the clock's alone and stays in resolveTechJobToday: a
 * form preselecting a job for a past day must not guess from what happens to be running now.
 *
 * A plain module, never "use server": exported from an actions file it would be a client-callable
 * endpoint. It THROWS only when the client throws; a read that answers with an error reads as "no
 * rows" and falls to the next tier, exactly as the clock always did. Each caller decides what a
 * throw means (the clock: no job; the form: no preselect, never a blocked save).
 */
export type ScheduledDay = { off: true; jobId: null } | { off: false; jobId: string | null };

/** Nothing planned: no day row, and no rostered job covering the date. */
export const NOTHING_SCHEDULED: ScheduledDay = { off: false, jobId: null };

/** The UTC instants of the company's midnight that starts `dateStr` and the next one (end exclusive).
 *  The next day is resolved on the calendar, then its own offset, the way todayBoundsInTz does, so a
 *  DST night is 23 or 25 hours and still one day. */
export function dayBoundsInTz(dateStr: string, tz: string): { dayStart: Date; dayEnd: Date } {
  const dayStart = tzDayStartUtc(dateStr, tz);
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { dayStart, dayEnd: tzDayStartUtc(next.toISOString().slice(0, 10), tz) };
}

/** Does a job's own scheduled window cover `dateStr`, read in COMPANY days? No start: no. An end
 *  missing or before the start: the start day alone. */
export function windowCoversDay(
  j: { scheduled_start?: string | null; scheduled_end?: string | null },
  dateStr: string,
  tz: string,
): boolean {
  const s = j.scheduled_start ? Date.parse(String(j.scheduled_start)) : NaN;
  if (!Number.isFinite(s)) return false;
  const e = j.scheduled_end ? Date.parse(String(j.scheduled_end)) : NaN;
  const startDay = todayStrInTz(tz, new Date(s));
  const endDay = todayStrInTz(tz, new Date(Number.isFinite(e) && e >= s ? e : s));
  return startDay <= dateStr && dateStr <= endDay;
}

export async function scheduledJobFor(
  supabase: Pick<SupabaseClient, "from">,
  profileId: string,
  dateStr: string,
  tz: string,
): Promise<ScheduledDay> {
  // TIER 0 — that day's crew day-assignment wins. Fails soft (falls through) when the read answers
  // with an error, as it did before 0139 landed: data null → the next tier.
  const { data: dayRow } = await supabase
    .from("crew_day_assignments")
    .select("job_id, kind")
    .eq("profile_id", profileId)
    .eq("work_date", dateStr)
    .maybeSingle();
  const day = dayRow as { job_id?: string | null; kind?: string } | null;
  // OFF FAILS CLOSED (0170): a deliberate "not on a job that day" beats every guess below it.
  if (day?.kind === "off") return { off: true, jobId: null };
  const dayJobId = day?.job_id ?? null;
  if (dayJobId) {
    const { data: dayJob } = await supabase
      .from("jobs")
      .select("id")
      .eq("id", dayJobId)
      .in("status", ACTIVE_JOB_STATUSES)
      .maybeSingle();
    if (dayJob) return { off: false, jobId: dayJobId };
  }

  // TIER 1 — a job he is rostered on whose days cover the date. The punch and the Clock's Next Up
  // card read the same rows (0266): the segments first, the job's own window as the fallback.
  const { data: mine } = await supabase
    .from("jobs")
    .select("id, scheduled_start, scheduled_end")
    .contains("assigned_to", [profileId])
    .in("status", ACTIVE_JOB_STATUSES);
  const myJobs = (Array.isArray(mine) ? mine : []) as { id: string; scheduled_start: string | null; scheduled_end: string | null }[];
  if (!myJobs.length) return NOTHING_SCHEDULED;
  const { data: segs } = await supabase
    .from("job_schedule_segments")
    .select("job_id")
    .in("job_id", myJobs.map((j) => j.id))
    .lte("start_date", dateStr)
    .gte("end_date", dateStr);
  const covered = new Set((Array.isArray(segs) ? (segs as { job_id: string }[]) : []).map((s) => s.job_id));
  // … or the job's own scheduled window, in company days (windowCoversDay: the one moved answer).
  for (const j of myJobs) {
    if (covered.has(j.id)) continue;
    if (windowCoversDay(j, dateStr, tz)) covered.add(j.id);
  }
  // The shared tier-1 pick (lib/job-status), the one the crew board points members with, given the
  // day asked about rather than today.
  const { dayStart, dayEnd } = dayBoundsInTz(dateStr, tz);
  const pick = pickJobScheduledToday(myJobs, covered, dayStart, dayEnd);
  return { off: false, jobId: pick?.id ?? null };
}
