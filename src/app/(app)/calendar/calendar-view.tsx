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

export function CalendarView({ entries, jobs }: { entries: CalEntry[]; jobs: CalJob[] }) {
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => new Date());

  const byDay = useMemo(() => {
    const m = new Map<string, { entries: CalEntry[]; jobs: CalJob[] }>();
    const get = (k: string) => {
      if (!m.has(k)) m.set(k, { entries: [], jobs: [] });
      return m.get(k)!;
    };
    for (const e of entries) get(dayKey(new Date(e.clock_in))).entries.push(e);
    for (const j of jobs) if (j.scheduled_start) get(dayKey(new Date(j.scheduled_start))).jobs.push(j);
    return m;
  }, [entries, jobs]);

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
  byDay: Map<string, { entries: CalEntry[]; jobs: CalJob[] }>;
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

const GRID_START = 6; // 6 AM
const GRID_END = 20; // 8 PM
const ROW_PX = 48;

/** Vertical week: hours down the left, days across the top, blocks placed by time. */
function WeekGrid({
  anchor,
  byDay,
  onPick,
}: {
  anchor: Date;
  byDay: Map<string, { entries: CalEntry[]; jobs: CalJob[] }>;
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
  const hours = Array.from({ length: GRID_END - GRID_START }, (_, i) => GRID_START + i);
  const colH = hours.length * ROW_PX;

  const topOf = (iso: string) => {
    const d = new Date(iso);
    const h = d.getHours() + d.getMinutes() / 60;
    return Math.max(0, Math.min(colH - 24, (h - GRID_START) * ROW_PX));
  };
  const heightOf = (startIso: string, endIso: string | null, fallbackHrs: number) => {
    const dur = endIso
      ? (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000
      : fallbackHrs;
    return Math.max(24, Math.min(colH, dur * ROW_PX));
  };

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          {/* Day headers */}
          <div className="grid border-b border-slate-100 bg-slate-50" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
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
          {/* Time grid */}
          <div className="grid" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
            {/* Hour labels */}
            <div className="relative" style={{ height: colH }}>
              {hours.map((h, i) => (
                <div key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-slate-400" style={{ top: i * ROW_PX }}>
                  {h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`}
                </div>
              ))}
            </div>
            {days.map((d) => {
              const k = dayKey(d);
              const data = byDay.get(k);
              return (
                <div key={k} className={`relative border-l border-slate-100 ${k === todayK ? "bg-brand/[0.03]" : ""}`} style={{ height: colH }}>
                  {hours.map((h, i) => (
                    <div key={h} className="absolute inset-x-0 border-t border-slate-100" style={{ top: i * ROW_PX }} />
                  ))}
                  {data?.jobs.map((j) =>
                    j.scheduled_start ? (
                      <Link
                        key={j.id}
                        href={`/jobs/${j.id}`}
                        className="absolute inset-x-0.5 z-10 overflow-hidden rounded border border-blue-200 bg-blue-50 px-1 py-0.5 text-[10px] leading-tight text-blue-800 hover:bg-blue-100"
                        style={{ top: topOf(j.scheduled_start), height: heightOf(j.scheduled_start, j.scheduled_end, 8) }}
                        title={`${j.job_number} — ${j.name}`}
                      >
                        <span className="font-semibold">{j.name}</span>
                      </Link>
                    ) : null,
                  )}
                  {data?.entries.map((e) => (
                    <div
                      key={e.id}
                      className="absolute right-0.5 z-10 w-[42%] overflow-hidden rounded border border-green-200 bg-green-50 px-1 py-0.5 text-[9px] leading-tight text-green-800"
                      style={{ top: topOf(e.clock_in), height: heightOf(e.clock_in, e.clock_out, 1) }}
                      title={`${e.profiles?.full_name ?? "Crew"} ${fmtTime(e.clock_in)}${e.clock_out ? `–${fmtTime(e.clock_out)}` : ""}`}
                    >
                      {e.profiles?.full_name?.split(" ")[0] ?? "⏱"}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}

function DayDetail({ date, data }: { date: Date; data?: { entries: CalEntry[]; jobs: CalJob[] } }) {
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
