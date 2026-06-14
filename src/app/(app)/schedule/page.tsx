import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { NewJobButton } from "./new-job-button";
import { JobScheduleCard } from "./job-schedule-card";
import { AppointmentButton } from "../appointments/appointment-button";
import { CalendarPanel } from "./calendar-panel";
import { AppointmentsPanel } from "./appointments-panel";
import { MapPanel } from "./map-panel";

export const dynamic = "force-dynamic";

// Unified "Schedule" hub: one screen with a Board / Calendar / Appointments /
// Map view switcher (?view=). The board (default) keeps its own ?week= offset
// and ?span=week|month sub-toggle.
const VIEWS = [
  { id: "board", label: "Board", href: "/schedule" },
  { id: "calendar", label: "Calendar", href: "/schedule?view=calendar" },
  { id: "appointments", label: "Appointments", href: "/schedule?view=appointments" },
  { id: "map", label: "Map", href: "/schedule?view=map" },
];

function ScheduleFrame({ view, children }: { view: string; children: React.ReactNode }) {
  return (
    <div>
      <PageHeader title="Schedule" description="Your jobs board, calendar, appointments and map — all in one place.">
        <div className="flex overflow-x-auto rounded-lg bg-slate-100 p-0.5 text-sm">
          {VIEWS.map((v) => (
            <Link
              key={v.id}
              href={v.href}
              className={`whitespace-nowrap rounded-md px-3 py-1 font-medium ${view === v.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
            >
              {v.label}
            </Link>
          ))}
        </div>
      </PageHeader>
      {children}
    </div>
  );
}

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

function monthRange(offset: number) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // Monday on/before the 1st
  return { first, gridStart };
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; week?: string; span?: string }>;
}) {
  const sp = await searchParams;
  const view = ["calendar", "appointments", "map"].includes(sp.view ?? "")
    ? (sp.view as string)
    : "board";

  if (view === "calendar")
    return (
      <ScheduleFrame view="calendar">
        <CalendarPanel />
      </ScheduleFrame>
    );
  if (view === "appointments")
    return (
      <ScheduleFrame view="appointments">
        <AppointmentsPanel />
      </ScheduleFrame>
    );
  if (view === "map")
    return (
      <ScheduleFrame view="map">
        <MapPanel />
      </ScheduleFrame>
    );

  // ---- Board view (default) ----
  const offset = parseInt(sp.week ?? "0", 10) || 0;
  const isMonth = sp.span === "month";
  const supabase = await createClient();

  const span = isMonth
    ? (() => {
        const { gridStart } = monthRange(offset);
        const end = new Date(gridStart);
        end.setDate(gridStart.getDate() + 42);
        return { start: gridStart, end };
      })()
    : weekRange(offset);

  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  const [{ data: scheduled }, { data: unscheduled }, { data: members }, { data: customers }, { data: segments }] =
    await Promise.all([
      supabase
        .from("jobs")
        .select("id, name, job_number, status, scheduled_start, scheduled_end, assigned_to, customers(name)")
        .gte("scheduled_start", span.start.toISOString())
        .lt("scheduled_start", span.end.toISOString())
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
      supabase
        .from("job_schedule_segments")
        .select("job_id, start_date, end_date")
        .gte("end_date", isoDate(span.start))
        .lte("start_date", isoDate(span.end)),
    ]);

  // Group multi-range segments by job; jobs with segments are placed only on
  // the days their ranges cover (gaps between work weeks stay empty).
  const segByJob = new Map<string, { start_date: string; end_date: string }[]>();
  for (const s of (segments ?? []) as any[]) {
    if (!segByJob.has(s.job_id)) segByJob.set(s.job_id, []);
    segByJob.get(s.job_id)!.push(s);
  }

  // A job's earliest range (its mirrored scheduled_start) can sit before the
  // visible span while a later range lands inside it — fetch those too so they
  // don't vanish from the week/month they actually occur in.
  const haveIds = new Set((scheduled ?? []).map((j: any) => j.id));
  const missingIds = [...segByJob.keys()].filter((id) => !haveIds.has(id));
  let extraJobs: any[] = [];
  if (missingIds.length) {
    const { data } = await supabase
      .from("jobs")
      .select("id, name, job_number, status, scheduled_start, scheduled_end, assigned_to, customers(name)")
      .in("id", missingIds);
    extraJobs = data ?? [];
  }
  const allJobs = [...(scheduled ?? []), ...extraJobs];

  // Place each job on every day it actually spans.
  const byDay = new Map<string, any[]>();
  const place = (j: any, startD: Date, endD: Date) => {
    const d = new Date(startD);
    d.setHours(0, 0, 0, 0);
    const last = new Date(endD);
    last.setHours(0, 0, 0, 0);
    let guard = 0;
    while (d <= last && guard++ < 45) {
      const k = d.toDateString();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(j);
      d.setDate(d.getDate() + 1);
    }
  };
  for (const j of allJobs) {
    const segs = segByJob.get(j.id as string);
    if (segs && segs.length) {
      for (const s of segs) place(j, new Date(`${s.start_date}T00:00:00`), new Date(`${s.end_date}T00:00:00`));
    } else if (j.scheduled_start) {
      place(j, new Date(j.scheduled_start as string), new Date((j.scheduled_end ?? j.scheduled_start) as string));
    }
  }

  const todayKey = new Date().toDateString();
  const baseQ = isMonth ? "span=month&" : "";

  // Options for the "New appointment" button (reuses the appointments module).
  const apptJobMap = new Map<string, any>();
  for (const j of [...(scheduled ?? []), ...(unscheduled ?? [])]) apptJobMap.set(j.id, j);
  const jobOpts = [...apptJobMap.values()].map((j: any) => ({ id: j.id, label: `${j.job_number} · ${j.name}` }));
  const custOpts = (customers ?? []).map((c: any) => ({ id: c.id, label: c.name }));
  const staffOpts = (members ?? []).map((m: any) => ({ id: m.id, label: m.full_name ?? "Unnamed" }));

  let label: string;
  if (isMonth) {
    label = monthRange(offset).first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } else {
    const { start, end } = weekRange(offset);
    label =
      offset === 0
        ? "This week"
        : `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(end.getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const { start } = weekRange(offset);
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const monthCells = (() => {
    const { gridStart } = monthRange(offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  })();
  const monthFirst = monthRange(offset).first;

  return (
    <ScheduleFrame view="board">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
          <Link href="/schedule" className={`rounded-md px-3 py-1 font-medium ${!isMonth ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>Week</Link>
          <Link href="/schedule?span=month" className={`rounded-md px-3 py-1 font-medium ${isMonth ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>Month</Link>
        </div>
        <Link href={`/schedule?${baseQ}week=${offset - 1}`} className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        {offset !== 0 && (
          <Link
            href={`/schedule${isMonth ? "?span=month" : ""}`}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Today
          </Link>
        )}
        <span className="min-w-[140px] text-center text-sm font-medium text-slate-700">{label}</span>
        <Link href={`/schedule?${baseQ}week=${offset + 1}`} className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50">
          <ChevronRight className="h-4 w-4" />
        </Link>
        <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} />
        <NewJobButton customers={customers ?? []} />
      </div>

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

      {isMonth ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {DAY_NAMES.map((d) => <div key={d} className="py-1.5">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {monthCells.map((d, i) => {
              const jobs = byDay.get(d.toDateString()) ?? [];
              const inMonth = d.getMonth() === monthFirst.getMonth();
              const isToday = d.toDateString() === todayKey;
              return (
                <div key={i} className={`min-h-[84px] border-b border-r border-slate-100 p-1 align-top ${inMonth ? "" : "bg-slate-50/60"}`}>
                  <div className={`text-xs ${isToday ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand font-semibold text-white" : inMonth ? "text-slate-500" : "text-slate-300"}`}>
                    {d.getDate()}
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {jobs.slice(0, 3).map((j: any) => (
                      <Link
                        key={j.id}
                        href={`/jobs/${j.id}`}
                        className="block truncate rounded bg-blue-50 px-1 text-[10px] text-blue-700 hover:bg-blue-100"
                        title={`${j.job_number} — ${j.name}`}
                      >
                        {j.name}
                      </Link>
                    ))}
                    {jobs.length > 3 && <div className="text-[10px] text-slate-400">+{jobs.length - 3} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
          {weekDays.map((d) => {
            const jobs = byDay.get(d.toDateString()) ?? [];
            const isToday = d.toDateString() === todayKey;
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
      )}
    </ScheduleFrame>
  );
}
