import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { NewJobButton } from "./new-job-button";
import { JobScheduleCard } from "./job-schedule-card";

export const dynamic = "force-dynamic";

function weekRange(offset: number) {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Monday = 0
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() - day + offset * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const offset = parseInt(week ?? "0", 10) || 0;
  const supabase = await createClient();
  const { start, end } = weekRange(offset);

  const [{ data: scheduled }, { data: unscheduled }, { data: members }, { data: customers }] =
    await Promise.all([
      supabase
        .from("jobs")
        .select("id, name, job_number, status, scheduled_start, assigned_to, customers(name)")
        .gte("scheduled_start", start.toISOString())
        .lt("scheduled_start", end.toISOString())
        .order("scheduled_start"),
      supabase
        .from("jobs")
        .select("id, name, job_number, status, scheduled_start, assigned_to, customers(name)")
        .is("scheduled_start", null)
        .in("status", ["estimate", "scheduled", "in_progress", "on_hold"])
        .order("created_at", { ascending: false })
        .limit(30),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
      supabase.from("customers").select("id, name").order("name"),
    ]);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const todayKey = new Date().toDateString();

  function dayKey(d: Date) {
    return d.toDateString();
  }
  const byDay = new Map<string, any[]>();
  for (const j of scheduled ?? []) {
    const k = new Date(j.scheduled_start as string).toDateString();
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(j);
  }

  const label = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(
    end.getTime() - 1,
  ).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div>
      <PageHeader title="Scheduler" description="Assign and schedule jobs for the week.">
        <div className="flex items-center gap-2">
          <Link href={`/schedule?week=${offset - 1}`} className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50">
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[150px] text-center text-sm font-medium text-slate-700">
            {offset === 0 ? "This week" : label}
          </span>
          <Link href={`/schedule?week=${offset + 1}`} className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50">
            <ChevronRight className="h-4 w-4" />
          </Link>
          <NewJobButton customers={customers ?? []} />
        </div>
      </PageHeader>

      {unscheduled && unscheduled.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700">
            Unscheduled ({unscheduled.length}) — set a date to place on the calendar
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {unscheduled.map((j: any) => (
              <JobScheduleCard key={j.id} job={j} members={members ?? []} />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
        {days.map((d) => {
          const jobs = byDay.get(dayKey(d)) ?? [];
          const isToday = dayKey(d) === todayKey;
          return (
            <div key={d.toISOString()} className="rounded-xl border border-slate-200 bg-slate-50/50">
              <div className={`rounded-t-xl px-3 py-2 text-center text-xs font-semibold ${isToday ? "bg-brand text-white" : "text-slate-500"}`}>
                {DAY_NAMES[(d.getDay() + 6) % 7]} {d.getDate()}
              </div>
              <div className="space-y-2 p-2">
                {jobs.length === 0 ? (
                  <p className="py-3 text-center text-[11px] text-slate-300">—</p>
                ) : (
                  jobs.map((j: any) => <JobScheduleCard key={j.id} job={j} members={members ?? []} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
