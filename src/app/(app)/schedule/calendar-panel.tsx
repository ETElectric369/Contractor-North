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

  // ±60 days of context; the client handles month/week/day slicing.
  const from = new Date(Date.now() - 60 * 86400_000).toISOString();
  const to = new Date(Date.now() + 60 * 86400_000).toISOString();

  const [{ data: entries }, { data: jobs }, { data: segments }, { data: appointments }, { data: org }] =
    await Promise.all([
      supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, lunch_minutes, status, job_code, job_id, profiles(full_name), jobs(job_number, name)")
        .gte("clock_in", from)
        .lte("clock_in", to)
        .order("clock_in"),
      supabase
        .from("jobs")
        .select("id, job_number, name, status, scheduled_start, scheduled_end")
        .gte("scheduled_start", from)
        .lte("scheduled_start", to)
        .order("scheduled_start"),
      supabase
        .from("job_schedule_segments")
        .select("job_id, start_date, end_date")
        .gte("end_date", from.slice(0, 10))
        .lte("start_date", to.slice(0, 10)),
      supabase
        .from("appointments")
        .select("id, type, title, starts_at, ends_at, status, job_id")
        .gte("starts_at", from)
        .lte("starts_at", to)
        .neq("status", "cancelled"),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);

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
        workStart={workStart}
        workEnd={workEnd}
      />
    </div>
  );
}
