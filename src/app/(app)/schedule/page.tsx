import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { TabBar } from "@/components/tabs";
import { SegmentedControl } from "@/components/ui/segmented";
import { NewJobButton } from "./new-job-button";
import { AppointmentButton } from "../appointments/appointment-button";
import { CalendarPanel } from "./calendar-panel";
import { AppointmentsPanel } from "./appointments-panel";
import { MapPanel } from "./map-panel";
import { DayTimeline } from "./day-timeline";
import { WeekTimeline } from "./week-timeline";

export const dynamic = "force-dynamic";

// Unified "Scheduler" hub: one screen with a Day timeline / Board / Calendar /
// Appointments / Map view switcher (?view=). The board keeps its own ?week=
// offset and ?span=week|month sub-toggle.
const VIEWS = [
  { id: "day", label: "Day", href: "/schedule?view=day" },
  { id: "week", label: "Week", href: "/schedule?view=week" },
  { id: "calendar", label: "Calendar", href: "/schedule" },
  { id: "appointments", label: "Appointments", href: "/schedule?view=appointments" },
  { id: "map", label: "Map", href: "/schedule?view=map" },
];

function ScheduleFrame({ view, children }: { view: string; children: React.ReactNode }) {
  return (
    <div>
      <PageHeader title="Scheduler" description="Everyone's day, the jobs board, calendar, appointments and map — all in one place." />
      <TabBar items={VIEWS} activeId={view} />
      {children}
    </div>
  );
}

function addDays(dateStr: string, n: number) {
  const d = new Date(`${dateStr}T12:00:00`); // noon keeps the date stable across tz/DST
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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


const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; week?: string; span?: string; date?: string; person?: string }>;
}) {
  const sp = await searchParams;
  const view = ["day", "week", "calendar", "appointments", "map"].includes(sp.view ?? "")
    ? (sp.view as string)
    : "calendar";

  if (view === "day") {
    const today = new Date().toISOString().slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? (sp.date as string) : today;
    const supabase = await createClient();
    const [{ data: jobs }, { data: customers }, { data: members }] = await Promise.all([
      supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(200),
      supabase.from("customers").select("id, name").order("name"),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    ]);
    const jobOpts = (jobs ?? []).map((j: any) => ({ id: j.id, label: `${j.job_number} · ${j.name}` }));
    const custOpts = (customers ?? []).map((c: any) => ({ id: c.id, label: c.name }));
    const staffOpts = (members ?? []).map((m: any) => ({ id: m.id, label: m.full_name ?? "Unnamed" }));
    const label = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    return (
      <ScheduleFrame view="day">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link
            href={`/schedule?view=day&date=${addDays(date, -1)}`}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          {date !== today && (
            <Link
              href="/schedule?view=day"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Today
            </Link>
          )}
          <span className="min-w-[150px] text-center text-sm font-medium text-slate-700">
            {date === today ? `Today · ${label}` : label}
          </span>
          <Link
            href={`/schedule?view=day&date=${addDays(date, 1)}`}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
          <div className="ml-auto flex gap-2">
            <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} />
            <NewJobButton customers={customers ?? []} />
          </div>
        </div>
        <DayTimeline date={date} />
      </ScheduleFrame>
    );
  }

  if (view === "week") {
    const offset = parseInt(sp.week ?? "0", 10) || 0;
    const { start, end } = weekRange(offset);
    const weekStart = start.toISOString().slice(0, 10);
    const person = sp.person || "";
    const supabase = await createClient();
    const [{ data: jobs }, { data: customers }, { data: members }] = await Promise.all([
      supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(200),
      supabase.from("customers").select("id, name").order("name"),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    ]);
    const jobOpts = (jobs ?? []).map((j: any) => ({ id: j.id, label: `${j.job_number} · ${j.name}` }));
    const custOpts = (customers ?? []).map((c: any) => ({ id: c.id, label: c.name }));
    const staffOpts = (members ?? []).map((m: any) => ({ id: m.id, label: m.full_name ?? "Unnamed" }));
    const label =
      offset === 0
        ? "This week"
        : `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(end.getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    const pq = person ? `&person=${person}` : "";
    return (
      <ScheduleFrame view="week">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link
            href={`/schedule?view=week&week=${offset - 1}${pq}`}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          {offset !== 0 && (
            <Link
              href={`/schedule?view=week${pq}`}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              This week
            </Link>
          )}
          <span className="min-w-[150px] text-center text-sm font-medium text-slate-700">{label}</span>
          <Link
            href={`/schedule?view=week&week=${offset + 1}${pq}`}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
          <div className="ml-auto flex gap-2">
            <AppointmentButton jobs={jobOpts} customers={custOpts} staff={staffOpts} />
            <NewJobButton customers={customers ?? []} />
          </div>
        </div>
        {(members ?? []).length > 1 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
            <Link
              href={`/schedule?view=week&week=${offset}`}
              className={`rounded-full px-2.5 py-1 font-medium ${!person ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              Everyone
            </Link>
            {(members ?? []).map((m: any) => (
              <Link
                key={m.id}
                href={`/schedule?view=week&week=${offset}&person=${m.id}`}
                className={`rounded-full px-2.5 py-1 font-medium ${person === m.id ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {m.full_name ?? "Unnamed"}
              </Link>
            ))}
          </div>
        )}
        <WeekTimeline weekStart={weekStart} person={person || undefined} />
      </ScheduleFrame>
    );
  }

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

  // Default → the Calendar (the one scheduling surface).
  return (
    <ScheduleFrame view="calendar">
      <CalendarPanel />
    </ScheduleFrame>
  );
}
