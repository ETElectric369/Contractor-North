import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import {
  CalendarView,
  type CalEntry,
  type CalJob,
  type CalSegment,
  type CalAppt,
} from "../calendar/calendar-view";

/** "08:00" → 8, "09:30" → 9.5 */
function hourOf(hm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm ?? "");
  if (!m) return fallback;
  return Number(m[1]) + Number(m[2]) / 60;
}

/** Calendar view of the unified Schedule hub (was /calendar). */
export async function CalendarPanel() {
  const supabase = await createClient();

  const now = Date.now();
  // Clocked time is historical context — ±60 days is plenty.
  const from = new Date(now - 60 * 86400_000).toISOString();
  const to = new Date(now + 60 * 86400_000).toISOString();
  // Jobs/appointments/segments use a MUCH wider window so far-future bookings
  // and long in-flight jobs don't silently vanish when you page the calendar
  // forward (the client handles month/week/day slicing).
  const jobFrom = new Date(now - 120 * 86400_000).toISOString();
  const jobTo = new Date(now + 400 * 86400_000).toISOString();

  const [{ data: entries }, { data: jobs }, { data: segments }, { data: appointments }, { data: unschedRows }, { data: org }] =
    await Promise.all([
      supabase
        .from("time_entries")
        .select("id, profile_id, clock_in, clock_out, lunch_minutes, status, job_code, job_id, profiles(full_name), jobs(job_number, name)")
        .gte("clock_in", from)
        .lte("clock_in", to)
        .order("clock_in"),
      // Overlap test, not a point test on scheduled_start: a job shows if it
      // STARTS before the window end AND (ends after the window start, or is an
      // open-ended job that started within the window). Closes the "job booked
      // far out / long job started a while ago" disappearance.
      supabase
        .from("jobs")
        .select("id, job_number, name, status, scheduled_start, scheduled_end, assigned_to, customers(name)")
        .lte("scheduled_start", jobTo)
        .or(`scheduled_end.gte.${jobFrom},and(scheduled_end.is.null,scheduled_start.gte.${jobFrom})`)
        .order("scheduled_start"),
      supabase
        .from("job_schedule_segments")
        .select("job_id, start_date, end_date")
        .gte("end_date", jobFrom.slice(0, 10))
        .lte("start_date", jobTo.slice(0, 10)),
      supabase
        .from("appointments")
        .select("id, type, title, starts_at, ends_at, status, job_id")
        .gte("starts_at", jobFrom)
        .lte("starts_at", jobTo)
        .neq("status", "cancelled"),
      // Jobs with no date yet — the "To schedule" rail. Any still-open job
      // missing a date (not just estimate/scheduled) — excludes only pre-sale
      // leads/quotes and finished/cancelled jobs.
      supabase
        .from("jobs")
        .select("id, job_number, name, customers(name)")
        .is("scheduled_start", null)
        .not("status", "in", "(lead,quoted,complete,cancelled,invoiced)")
        .order("created_at", { ascending: false })
        .limit(40),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);

  const { data: memberRows } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("active", true)
    .order("full_name");
  const activeMembers = (memberRows ?? []) as { id: string; full_name: string | null }[];
  // Union in any FORMER employee who still has time entries in the window, so
  // their coloured blocks get a stable slot + legend entry rather than an
  // off-roster hash colour that can collide with active crew.
  const seen = new Set(activeMembers.map((m) => m.id));
  const formerWithTime: { id: string; full_name: string | null }[] = [];
  for (const e of (entries ?? []) as any[]) {
    if (e.profile_id && !seen.has(e.profile_id)) {
      seen.add(e.profile_id);
      formerWithTime.push({ id: e.profile_id, full_name: e.profiles?.full_name ?? null });
    }
  }
  const members = [...activeMembers, ...formerWithTime];

  const unscheduled = (unschedRows ?? []).map((j: any) => ({
    id: j.id,
    job_number: j.job_number,
    name: j.name,
    customer: j.customers?.name ?? null,
  }));

  // Scheduled jobs block off the configured work day (e.g. 9–5), not the whole grid.
  const s = getOrgSettings((org as any)?.settings);
  const workStart = hourOf(s.work_day_start, 8);
  const workEnd = hourOf(s.work_day_end, 17);

  return (
    <div className="mx-auto max-w-5xl">
      <CalendarView
        entries={(entries ?? []) as unknown as CalEntry[]}
        jobs={(jobs ?? []) as unknown as CalJob[]}
        segments={(segments ?? []) as unknown as CalSegment[]}
        appointments={(appointments ?? []) as unknown as CalAppt[]}
        unscheduled={unscheduled}
        members={members}
        workStart={workStart}
        workEnd={workEnd}
        now={new Date().toISOString()}
      />
    </div>
  );
}
