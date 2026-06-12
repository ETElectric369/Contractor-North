import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { CalendarView, type CalEntry, type CalJob } from "./calendar-view";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const supabase = await createClient();

  // ±60 days of context; the client handles month/week/day slicing.
  const from = new Date(Date.now() - 60 * 86400_000).toISOString();
  const to = new Date(Date.now() + 60 * 86400_000).toISOString();

  const [{ data: entries }, { data: jobs }] = await Promise.all([
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
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Calendar"
        description="Timecard entries and scheduled jobs — month, week, or day."
      />
      <CalendarView entries={(entries ?? []) as unknown as CalEntry[]} jobs={(jobs ?? []) as unknown as CalJob[]} />
    </div>
  );
}
