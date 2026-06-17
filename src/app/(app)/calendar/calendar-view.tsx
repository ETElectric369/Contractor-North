"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock, Briefcase, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { setJobSchedule } from "../schedule/actions";
import { JobScheduleCard } from "../schedule/job-schedule-card";
import { colorForMember, initialsOf, firstNameOf } from "@/lib/employee-color";

export interface CalEntry {
  id: string;
  profile_id: string;
  clock_in: string;
  clock_out: string | null;
  lunch_minutes: number;
  status: string;
  job_code: string | null;
  job_id: string | null;
  profiles?: { full_name: string | null } | null;
  jobs?: { job_number: string; name: string } | null;
}

export interface CalJob {
  id: string;
  job_number: string;
  name: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  assigned_to?: string[] | null;
  customers?: { name: string } | null;
}

export interface CalMember {
  id: string;
  full_name: string | null;
}

export interface CalSegment {
  job_id: string;
  start_date: string; // yyyy-mm-dd
  end_date: string;
}

export interface CalAppt {
  id: string;
  type: string; // appointment | inspection
  title: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
  job_id: string | null;
}

/** A job with no date yet — shown in the "To schedule" rail. */
export interface CalUnscheduled {
  id: string;
  job_number: string;
  name: string;
  customer: string | null;
}

type View = "month" | "week" | "day";

const dayKey = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const hrs = (e: CalEntry) =>
  e.clock_out
    ? Math.max(0, (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - (e.lunch_minutes ?? 0) / 60)
    : 0;
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function CalendarView({
  entries,
  jobs,
  segments = [],
  appointments = [],
  unscheduled = [],
  members = [],
  workStart = 8,
  workEnd = 17,
  now,
}: {
  entries: CalEntry[];
  jobs: CalJob[];
  segments?: CalSegment[];
  appointments?: CalAppt[];
  unscheduled?: CalUnscheduled[];
  members?: CalMember[];
  workStart?: number;
  workEnd?: number;
  /** Server's "now" (ISO) — keeps SSR and first client render in sync. */
  now: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [view, setView] = useState<View>("week");
  // Seed date state from the SERVER clock so SSR and hydration agree (no flash /
  // hydration warning on the "today" highlight), then correct to the user's
  // actual local day on mount.
  const [anchor, setAnchor] = useState(() => new Date(now));
  const [today, setToday] = useState(() => new Date(now));
  useEffect(() => {
    const d = new Date();
    setToday(d);
    setAnchor(d);
  }, []);
  const todayK = dayKey(today);
  // Selectable layers — one calendar, show/hide what you want on it.
  const [layers, setLayers] = useState({ jobs: true, appts: true, time: true });
  // The "armed" unscheduled job: tap a chip to arm, then tap an open day to place
  // it there (the one canonical scheduling gesture).
  const [armed, setArmed] = useState<string | null>(null);
  const armedJob = armed ? unscheduled.find((u) => u.id === armed) : null;

  function handlePick(d: Date) {
    if (armed) {
      const ymd = dayKey(d);
      start(async () => {
        await setJobSchedule(
          armed,
          new Date(`${ymd}T08:00`).toISOString(),
          new Date(`${ymd}T16:00`).toISOString(),
        );
        setArmed(null);
        router.refresh();
      });
      return;
    }
    setAnchor(d);
    setView("day");
  }

  const byDay = useMemo(() => {
    const m = new Map<string, { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] }>();
    const get = (k: string) => {
      if (!m.has(k)) m.set(k, { entries: [], jobs: [], appts: [] });
      return m.get(k)!;
    };
    if (layers.time) for (const e of entries) get(dayKey(new Date(e.clock_in))).entries.push(e);
    if (layers.appts) for (const a of appointments) get(dayKey(new Date(a.starts_at))).appts.push(a);

    // Group multi-range segments by job; a job with segments is placed only on
    // the days its ranges cover, so gaps (e.g. between two work weeks) stay empty.
    const segByJob = new Map<string, CalSegment[]>();
    for (const s of segments) {
      if (!segByJob.has(s.job_id)) segByJob.set(s.job_id, []);
      segByJob.get(s.job_id)!.push(s);
    }
    const spanDays = (jobId: string, push: (k: string) => void) => {
      const segs = segByJob.get(jobId);
      const j = jobs.find((x) => x.id === jobId);
      const place = (startD: Date, endD: Date) => {
        const d = new Date(startD);
        d.setHours(0, 0, 0, 0);
        const last = new Date(endD);
        last.setHours(0, 0, 0, 0);
        // Backstop against a runaway loop; sized above the widest fetch window
        // so legitimate long jobs aren't silently clipped.
        let guard = 0;
        while (d <= last && guard++ < 540) {
          push(dayKey(d));
          d.setDate(d.getDate() + 1);
        }
      };
      if (segs && segs.length) {
        for (const s of segs) place(new Date(`${s.start_date}T00:00:00`), new Date(`${s.end_date}T00:00:00`));
      } else if (j?.scheduled_start) {
        place(new Date(j.scheduled_start), new Date(j.scheduled_end ?? j.scheduled_start));
      }
    };
    if (layers.jobs) for (const j of jobs) spanDays(j.id, (k) => get(k).jobs.push(j));
    return m;
  }, [entries, jobs, segments, appointments, layers]);

  function shift(dir: -1 | 1) {
    const d = new Date(anchor);
    if (view === "month") d.setMonth(d.getMonth() + dir);
    else if (view === "week") d.setDate(d.getDate() + 7 * dir);
    else d.setDate(d.getDate() + dir);
    setAnchor(d);
  }

  const title =
    view === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : view === "week"
        ? `Week of ${startOfWeek(anchor).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
        : anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => shift(-1)} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <Button size="sm" variant="outline" onClick={() => shift(1)} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-2 text-sm font-semibold text-slate-900">{title}</span>
        </div>
        <SegmentedControl
          activeId={view}
          onSelect={(id) => setView(id as View)}
          items={[
            { id: "month", label: "Month" },
            { id: "week", label: "Week" },
            { id: "day", label: "Day" },
          ]}
        />
      </div>

      {/* Selectable layers */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">Show:</span>
        {(
          [
            ["jobs", "Jobs", "bg-blue-500"],
            ["appts", "Appointments", "bg-violet-500"],
            ["time", "Clocked time", "bg-emerald-500"],
          ] as const
        ).map(([k, label, dot]) => (
          <button
            key={k}
            onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
              layers[k] ? "bg-slate-100 text-slate-700" : "text-slate-400"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${layers[k] ? dot : "bg-slate-300"}`} /> {label}
          </button>
        ))}
      </div>

      {/* Crew legend — read the calendar's per-person colors off this. */}
      {members.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-400">Crew:</span>
          {members.map((m) => {
            const c = colorForMember(m.id, members);
            return (
              <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-slate-600">
                <span className={`h-2 w-2 rounded-full ${c.dot}`} /> {firstNameOf(m.full_name)}
              </span>
            );
          })}
        </div>
      )}

      {/* "To schedule" rail — always shown (discoverable); tap a job to arm it,
          then tap an open day to place it. */}
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-2">
        <div className="mb-1.5 flex items-center justify-between px-1 text-xs">
          <span className="font-semibold text-amber-700">To schedule · {unscheduled.length}</span>
          {unscheduled.length === 0 ? null : armedJob ? (
              <span className="flex items-center gap-1 text-amber-700">
                Tap an open day to place <span className="font-medium">{armedJob.name}</span>
                <button onClick={() => setArmed(null)} className="rounded p-0.5 hover:bg-amber-100" aria-label="Cancel">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <span className="text-slate-400">Tap a job, then tap a day</span>
            )}
          </div>
          {unscheduled.length === 0 ? (
            <p className="px-1 py-1 text-xs text-slate-400">Nothing waiting — jobs created without a date land here to drop onto the calendar.</p>
          ) : (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {unscheduled.map((j) => (
              <button
                key={j.id}
                onClick={() => setArmed(armed === j.id ? null : j.id)}
                disabled={pending}
                className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  armed === j.id
                    ? "border-amber-500 bg-amber-100 ring-1 ring-amber-400"
                    : "border-slate-200 bg-white hover:border-amber-300"
                }`}
              >
                <div className="max-w-[160px] truncate font-medium text-slate-800">{j.name}</div>
                <div className="truncate text-[11px] text-slate-400">{j.customer ?? j.job_number}</div>
              </button>
              ))}
            </div>
          )}
        </div>

      {view === "month" && <MonthGrid anchor={anchor} byDay={byDay} onPick={handlePick} arming={!!armed} members={members} todayK={todayK} />}
      {view === "week" && <WeekGrid anchor={anchor} byDay={byDay} onPick={handlePick} workStart={workStart} workEnd={workEnd} members={members} todayK={todayK} />}
      {view === "day" && (
        <DayDetail
          date={anchor}
          data={byDay.get(dayKey(anchor))}
          members={members}
          canPlace={!!armed}
          onPlace={() => handlePick(anchor)}
        />
      )}
    </div>
  );
}

function startOfWeek(d: Date) {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay()); // Sunday start
  r.setHours(0, 0, 0, 0);
  return r;
}

function MonthGrid({
  anchor,
  byDay,
  onPick,
  arming = false,
  members,
  todayK,
}: {
  anchor: Date;
  byDay: Map<string, { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] }>;
  onPick: (d: Date) => void;
  arming?: boolean;
  members: CalMember[];
  todayK: string;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    cells.push(d);
  }

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-1.5">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const k = dayKey(d);
          const data = byDay.get(k);
          // Hours per person on this day (drives the per-employee colored chips).
          const perPerson = (() => {
            const m = new Map<string, { name: string | null; hrs: number }>();
            for (const e of data?.entries ?? []) {
              const cur = m.get(e.profile_id) ?? { name: e.profiles?.full_name ?? null, hrs: 0 };
              cur.hrs += hrs(e);
              m.set(e.profile_id, cur);
            }
            return [...m.entries()].filter(([, v]) => v.hrs > 0);
          })();
          const inMonth = d.getMonth() === anchor.getMonth();
          const isOpen = (data?.jobs.length ?? 0) === 0;
          return (
            <div
              key={i}
              onClick={() => onPick(d)}
              className={`min-h-[72px] cursor-pointer border-b border-r border-slate-100 p-1 text-left align-top hover:bg-slate-50 ${
                inMonth ? "" : "bg-slate-50/60 text-slate-300"
              } ${arming && inMonth ? (isOpen ? "bg-emerald-50/70 ring-1 ring-inset ring-emerald-300" : "bg-amber-50/40") : ""}`}
            >
              <div className={`text-xs ${k === todayK ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand font-semibold text-white" : "text-slate-500"}`}>
                {d.getDate()}
              </div>
              <div className="mt-0.5 space-y-0.5">
                {data?.jobs.slice(0, 2).map((j) => {
                  const c = colorForMember(j.assigned_to?.[0], members);
                  return (
                    <Link
                      key={j.id}
                      href={`/jobs/${j.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className={`block truncate rounded px-1 text-[10px] hover:opacity-80 ${c.bg} ${c.text}`}
                      title={`${j.job_number} — ${j.name} (open job)`}
                    >
                      {j.name}
                    </Link>
                  );
                })}
                {(data?.jobs.length ?? 0) > 2 && (
                  <div className="text-[10px] text-slate-400">+{data!.jobs.length - 2} more</div>
                )}
                {data?.appts.slice(0, 2).map((a) => (
                  <div
                    key={a.id}
                    className={`truncate rounded px-1 text-[10px] ${a.type === "inspection" ? "bg-amber-50 text-amber-700" : "bg-purple-50 text-purple-700"} ${a.status === "proposed" ? "border border-dashed border-current opacity-70" : ""}`}
                    title={a.status === "proposed" ? `${a.title} (pending pick)` : a.title}
                  >
                    {a.status === "proposed" ? "⧗" : a.type === "inspection" ? "🔍" : "📅"} {a.title}
                  </div>
                ))}
                {perPerson.slice(0, 3).map(([pid, v]) => {
                  const c = colorForMember(pid, members);
                  return (
                    <div key={pid} className={`flex items-center gap-1 truncate rounded px-1 text-[10px] ${c.bg} ${c.text}`}>
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
                      {initialsOf(v.name)} {v.hrs.toFixed(1)}h
                    </div>
                  );
                })}
                {perPerson.length > 3 && (
                  <div className="px-1 text-[10px] text-slate-400">+{perPerson.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const ROW_PX = 48;
// Show the workday only — no empty overnight hours to scroll past.
const WORK_START = 6; // 6 AM
const WORK_END = 19; // 7 PM
const WORK_HOURS = WORK_END - WORK_START;
const DAY_H = WORK_HOURS * ROW_PX;

/** Google-style week: workday hours down the left, days across the top,
 *  jobs/timecards drawn as boxes clamped into each day they touch. */
function WeekGrid({
  anchor,
  byDay,
  onPick,
  workStart,
  workEnd,
  members,
  todayK,
}: {
  anchor: Date;
  byDay: Map<string, { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] }>;
  onPick: (d: Date) => void;
  workStart: number;
  workEnd: number;
  members: CalMember[];
  todayK: string;
}) {
  const start = startOfWeek(anchor);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const hours = Array.from({ length: WORK_HOURS }, (_, i) => WORK_START + i);

  /** Clamp a start/end span into THIS day's workday window. */
  const segment = (day: Date, startIso: string, endIso: string | null, fallbackHrs: number) => {
    const dayStart = new Date(day);
    dayStart.setHours(0, 0, 0, 0);
    const winStart = dayStart.getTime() + WORK_START * 3_600_000;
    const winEnd = dayStart.getTime() + WORK_END * 3_600_000;
    const s = new Date(startIso);
    const e = endIso ? new Date(endIso) : new Date(s.getTime() + fallbackHrs * 3_600_000);
    const from = Math.max(s.getTime(), winStart);
    const to = Math.min(e.getTime(), winEnd);
    if (to <= from) return null;
    const top = ((from - winStart) / 3_600_000) * ROW_PX;
    const height = Math.max(22, ((to - from) / 3_600_000) * ROW_PX);
    return { top, height: Math.min(height, DAY_H - top) };
  };

  // Scheduled jobs are date-based; show each one as a block over the configured
  // work day (e.g. 9–5) within the visible window — not the whole 6a–7p grid.
  // Clamp into [6a,7p]; if org hours are inverted or fall entirely outside the
  // window, fall back to a sane block so jobs never disappear from the week.
  const jobBlock = (() => {
    const lo = Math.min(workStart, workEnd);
    const hi = Math.max(workStart, workEnd);
    const from = Math.min(Math.max(lo, WORK_START), WORK_END - 1);
    const to = Math.max(Math.min(hi, WORK_END), from + 1);
    return { top: (from - WORK_START) * ROW_PX, height: Math.max(22, (to - from) * ROW_PX) };
  })();

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          {/* Day headers (stay put while the timeline scrolls) */}
          <div className="grid border-b border-slate-100 bg-slate-50" style={{ gridTemplateColumns: `52px repeat(7, 1fr)` }}>
            <div />
            {days.map((d) => {
              const k = dayKey(d);
              return (
                <button
                  key={k}
                  onClick={() => onPick(d)}
                  className={`py-2 text-center text-xs font-semibold hover:bg-slate-100 ${k === todayK ? "text-brand" : "text-slate-500"}`}
                >
                  {d.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                  <span className={k === todayK ? "rounded-full bg-brand px-1.5 py-0.5 text-white" : ""}>{d.getDate()}</span>
                </button>
              );
            })}
          </div>
          {/* Workday timeline */}
          <div className="max-h-[62vh] overflow-y-auto">
            <div className="grid" style={{ gridTemplateColumns: `52px repeat(7, 1fr)` }}>
              {/* Hour rail */}
              <div className="relative" style={{ height: DAY_H }}>
                {hours.map((h) => (
                  <div key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-slate-400" style={{ top: (h - WORK_START) * ROW_PX }}>
                    {h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`}
                  </div>
                ))}
              </div>
              {days.map((d) => {
                const k = dayKey(d);
                const data = byDay.get(k);
                return (
                  <div key={k} className={`relative border-l border-slate-100 ${k === todayK ? "bg-brand/[0.03]" : ""}`} style={{ height: DAY_H }}>
                    {hours.map((h) => (
                      <div key={h} className="absolute inset-x-0 border-t border-slate-100" style={{ top: (h - WORK_START) * ROW_PX }} />
                    ))}
                    {data?.jobs.map((j, ji, arr) => {
                      if (!j.scheduled_start || !jobBlock) return null;
                      // Split width when several jobs land on the same day so they don't stack.
                      const w = 100 / arr.length;
                      const c = colorForMember(j.assigned_to?.[0], members);
                      return (
                        <Link
                          key={j.id}
                          href={`/jobs/${j.id}`}
                          className={`absolute z-10 overflow-hidden rounded-md border px-1 py-0.5 text-[10px] leading-tight shadow-sm hover:opacity-80 ${c.border} ${c.bg} ${c.text}`}
                          style={{ ...jobBlock, left: `${ji * w}%`, width: `calc(${w}% - 2px)` }}
                          title={`${j.job_number} — ${j.name} (open job)`}
                        >
                          <span className="font-semibold">{j.name}</span>
                          <span className="block text-[9px] opacity-70">{j.job_number}</span>
                        </Link>
                      );
                    })}
                    {data?.entries.map((e) => {
                      const seg = segment(d, e.clock_in, e.clock_out, 1);
                      if (!seg) return null;
                      const c = colorForMember(e.profile_id, members);
                      return (
                        <div
                          key={e.id}
                          className={`absolute right-0.5 z-20 w-[46%] overflow-hidden rounded-md border px-1 py-0.5 text-[9px] leading-tight ${c.border} ${c.bg} ${c.text}`}
                          style={seg}
                          title={`${e.profiles?.full_name ?? "Crew"} · ${fmtTime(e.clock_in)}${e.clock_out ? `–${fmtTime(e.clock_out)} · ${hrs(e).toFixed(2)} h` : " (open)"}`}
                        >
                          <span className="font-semibold">{firstNameOf(e.profiles?.full_name)}</span>
                          <span className="block text-[8px] opacity-80">{e.clock_out ? `${hrs(e).toFixed(1)}h` : "open"}</span>
                        </div>
                      );
                    })}
                    {data?.appts.map((a) => {
                      const seg = segment(d, a.starts_at, a.ends_at, 1);
                      if (!seg) return null;
                      const insp = a.type === "inspection";
                      return (
                        <div
                          key={a.id}
                          className={`absolute left-0.5 z-30 w-[52%] overflow-hidden rounded-md border px-1 py-0.5 text-[9px] leading-tight ${insp ? "border-amber-300 bg-amber-100/95 text-amber-900" : "border-purple-300 bg-purple-100/95 text-purple-900"}`}
                          style={seg}
                          title={`${a.title} · ${fmtTime(a.starts_at)}`}
                        >
                          <span className="font-semibold">{insp ? "🔍" : "📅"} {a.title}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function DayDetail({
  date,
  data,
  members = [],
  canPlace = false,
  onPlace,
}: {
  date: Date;
  data?: { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] };
  members?: CalMember[];
  canPlace?: boolean;
  onPlace?: () => void;
}) {
  return (
    <div className="space-y-4">
      {canPlace && (
        <button
          onClick={onPlace}
          className="w-full rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
        >
          Schedule the armed job on {date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
        </button>
      )}
      <Card>
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
          <Briefcase className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold text-slate-900">Scheduled jobs</h3>
        </div>
        <div className="grid gap-2 p-3 sm:grid-cols-2">
          {(data?.jobs ?? []).map((j) => (
            <JobScheduleCard
              key={j.id}
              job={{
                id: j.id,
                name: j.name,
                job_number: j.job_number,
                status: j.status,
                scheduled_start: j.scheduled_start,
                assigned_to: j.assigned_to ?? null,
                customers: j.customers ?? null,
              }}
              members={members}
            />
          ))}
          {!data?.jobs.length && (
            <div className="col-span-full py-5 text-center text-sm text-slate-400">Nothing scheduled.</div>
          )}
        </div>
      </Card>

      {(data?.appts.length ?? 0) > 0 && (
        <Card>
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
            <span className="text-sm">📅</span>
            <h3 className="text-sm font-semibold text-slate-900">Appointments &amp; inspections</h3>
          </div>
          <ul className="divide-y divide-slate-100">
            {data!.appts.map((a) => (
              <li key={a.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span>
                  <span className="font-medium text-slate-900">{a.title}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {fmtTime(a.starts_at)}{a.ends_at ? `–${fmtTime(a.ends_at)}` : ""}
                  </span>
                </span>
                <Badge tone={a.type === "inspection" ? "amber" : "blue"}>{a.type}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
          <Clock className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold text-slate-900">
            Timecard entries · {(data?.entries ?? []).reduce((s, e) => s + hrs(e), 0).toFixed(1)} hrs
          </h3>
        </div>
        <ul className="divide-y divide-slate-100">
          {(data?.entries ?? []).map((e) => {
            const c = colorForMember(e.profile_id, members);
            return (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
              <div>
                <span className={`mr-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full align-middle ${c.dot}`} />
                <span className="font-medium text-slate-900">{e.profiles?.full_name ?? "Crew"}</span>
                <span className="ml-2 text-slate-500">
                  {fmtTime(e.clock_in)}{e.clock_out ? ` – ${fmtTime(e.clock_out)}` : " (open)"}
                </span>
                {e.jobs && (
                  <Link href={`/jobs/${e.job_id}`} className="ml-2 text-xs text-brand hover:underline">
                    {e.jobs.job_number} {e.jobs.name}
                  </Link>
                )}
                {e.job_code && <Badge tone="slate" className="ml-2">{e.job_code}</Badge>}
              </div>
              <span className="font-medium text-slate-800">{e.clock_out ? `${hrs(e).toFixed(2)} h` : "—"}</span>
            </li>
            );
          })}
          {!data?.entries.length && <li className="px-5 py-5 text-center text-sm text-slate-400">No time logged.</li>}
        </ul>
      </Card>
    </div>
  );
}
