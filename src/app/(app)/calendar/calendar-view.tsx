"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Clock, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";

export interface CalEntry {
  id: string;
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
}: {
  entries: CalEntry[];
  jobs: CalJob[];
  segments?: CalSegment[];
  appointments?: CalAppt[];
}) {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(() => new Date());

  const byDay = useMemo(() => {
    const m = new Map<string, { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] }>();
    const get = (k: string) => {
      if (!m.has(k)) m.set(k, { entries: [], jobs: [], appts: [] });
      return m.get(k)!;
    };
    for (const e of entries) get(dayKey(new Date(e.clock_in))).entries.push(e);
    for (const a of appointments) get(dayKey(new Date(a.starts_at))).appts.push(a);

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
        let guard = 0;
        while (d <= last && guard++ < 45) {
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
    for (const j of jobs) spanDays(j.id, (k) => get(k).jobs.push(j));
    return m;
  }, [entries, jobs, segments, appointments]);

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
        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
          {(["month", "week", "day"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1 text-sm font-medium capitalize ${view === v ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "month" && (
        <MonthGrid anchor={anchor} byDay={byDay} onPick={(d) => { setAnchor(d); setView("day"); }} />
      )}
      {view === "week" && <WeekGrid anchor={anchor} byDay={byDay} onPick={(d) => { setAnchor(d); setView("day"); }} />}
      {view === "day" && <DayDetail date={anchor} data={byDay.get(dayKey(anchor))} />}
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
}: {
  anchor: Date;
  byDay: Map<string, { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] }>;
  onPick: (d: Date) => void;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const todayK = dayKey(new Date());
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
          const totalHrs = data ? data.entries.reduce((s, e) => s + hrs(e), 0) : 0;
          const inMonth = d.getMonth() === anchor.getMonth();
          return (
            <div
              key={i}
              onClick={() => onPick(d)}
              className={`min-h-[72px] cursor-pointer border-b border-r border-slate-100 p-1 text-left align-top hover:bg-slate-50 ${inMonth ? "" : "bg-slate-50/60 text-slate-300"}`}
            >
              <div className={`text-xs ${k === todayK ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand font-semibold text-white" : "text-slate-500"}`}>
                {d.getDate()}
              </div>
              <div className="mt-0.5 space-y-0.5">
                {data?.jobs.slice(0, 2).map((j) => (
                  <Link
                    key={j.id}
                    href={`/jobs/${j.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="block truncate rounded bg-blue-50 px-1 text-[10px] text-blue-700 hover:bg-blue-100"
                    title={`${j.job_number} — ${j.name} (open job)`}
                  >
                    {j.name}
                  </Link>
                ))}
                {(data?.jobs.length ?? 0) > 2 && (
                  <div className="text-[10px] text-slate-400">+{data!.jobs.length - 2} more</div>
                )}
                {data?.appts.slice(0, 2).map((a) => (
                  <div
                    key={a.id}
                    className={`truncate rounded px-1 text-[10px] ${a.type === "inspection" ? "bg-amber-50 text-amber-700" : "bg-purple-50 text-purple-700"}`}
                    title={a.title}
                  >
                    {a.type === "inspection" ? "🔍" : "📅"} {a.title}
                  </div>
                ))}
                {totalHrs > 0 && (
                  <div className="truncate rounded bg-green-50 px-1 text-[10px] text-green-700">
                    ⏱ {totalHrs.toFixed(1)}h
                  </div>
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
}: {
  anchor: Date;
  byDay: Map<string, { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] }>;
  onPick: (d: Date) => void;
}) {
  const start = startOfWeek(anchor);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const todayK = dayKey(new Date());
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
                    {data?.jobs.map((j) => {
                      if (!j.scheduled_start) return null;
                      const seg = segment(d, j.scheduled_start, j.scheduled_end, 8);
                      if (!seg) return null;
                      return (
                        <Link
                          key={j.id}
                          href={`/jobs/${j.id}`}
                          className="absolute inset-x-0.5 z-10 overflow-hidden rounded-md border border-blue-300 bg-blue-100/90 px-1 py-0.5 text-[10px] leading-tight text-blue-900 shadow-sm hover:bg-blue-200"
                          style={seg}
                          title={`${j.job_number} — ${j.name} (open job)`}
                        >
                          <span className="font-semibold">{j.name}</span>
                          <span className="block text-[9px] text-blue-700/80">{j.job_number}</span>
                        </Link>
                      );
                    })}
                    {data?.entries.map((e) => {
                      const seg = segment(d, e.clock_in, e.clock_out, 1);
                      if (!seg) return null;
                      return (
                        <div
                          key={e.id}
                          className="absolute right-0.5 z-20 w-[46%] overflow-hidden rounded-md border border-green-300 bg-green-100/90 px-1 py-0.5 text-[9px] leading-tight text-green-900"
                          style={seg}
                          title={`${e.profiles?.full_name ?? "Crew"} · ${fmtTime(e.clock_in)}${e.clock_out ? `–${fmtTime(e.clock_out)} · ${hrs(e).toFixed(2)} h` : " (open)"}`}
                        >
                          <span className="font-semibold">{e.profiles?.full_name?.split(" ")[0] ?? "Crew"}</span>
                          <span className="block text-[8px] text-green-700/90">{e.clock_out ? `${hrs(e).toFixed(1)}h` : "open"}</span>
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

function DayDetail({ date, data }: { date: Date; data?: { entries: CalEntry[]; jobs: CalJob[]; appts: CalAppt[] } }) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
          <Briefcase className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold text-slate-900">Scheduled jobs</h3>
        </div>
        <ul className="divide-y divide-slate-100">
          {(data?.jobs ?? []).map((j) => (
            <li key={j.id}>
              <Link href={`/jobs/${j.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                <span className="font-medium text-slate-900">{j.job_number} — {j.name}</span>
                <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
              </Link>
            </li>
          ))}
          {!data?.jobs.length && <li className="px-5 py-5 text-center text-sm text-slate-400">Nothing scheduled.</li>}
        </ul>
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
          {(data?.entries ?? []).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
              <div>
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
          ))}
          {!data?.entries.length && <li className="px-5 py-5 text-center text-sm text-slate-400">No time logged.</li>}
        </ul>
      </Card>
    </div>
  );
}
