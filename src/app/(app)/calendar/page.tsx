import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { CalendarView, type CalEntry, type CalJob, type CalSegment, type CalAppt } from "./calendar-view";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const supabase = await createClient();

  // ±60 days of context; the client handles month/week/day slicing.
  const from = new Date(Date.now() - 60 * 86400_000).toISOString();
  const to = new Date(Date.now() + 60 * 86400_000).toISOString();

  const [{ data: entries }, { data: jobs }, { data: segments }, { data: appointments }] = await Promise.all([
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
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Calendar"
        description="Timecard entries and scheduled jobs — month, week, or day."
      />
      <CalendarView
        entries={(entries ?? []) as unknown as CalEntry[]}
        jobs={(jobs ?? []) as unknown as CalJob[]}
        segments={(segments ?? []) as unknown as CalSegment[]}
        appointments={(appointments ?? []) as unknown as CalAppt[]}
      />
    </div>
  );
}
