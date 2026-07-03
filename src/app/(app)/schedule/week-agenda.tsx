"use client";

import { initialsOf } from "@/lib/employee-color";
import type { ArmedTarget, CalAppt, CalMember, DayData, JobOnDay } from "../calendar/calendar-view";

// THE default /schedule view: a vertical 7-day agenda (lifted from My Day's
// week renderer) — one full-width row per day, Sun–Sat, chips inside. No
// horizontal scroll anywhere; "what's next week" is Schedule → next chevron,
// read top to bottom. Chip color = RECORD TYPE (job blue, appointment violet,
// inspection teal, task slate — amber is reserved for move-mode/needs-
// scheduling); WHO rides as initials text, not chip color — person-color lied
// (a two-man job showed one man). The color code is stated in the legend line
// the calendar shell renders under its zoom control.

// Local copies of the day-key/time helpers: this file only takes TYPES from
// calendar-view (import type), so there is no runtime import cycle between
// the shell and its default view.
const dayKey = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function WeekAgenda({
  days,
  byDay,
  todayK,
  members,
  armedId,
  armedActive,
  onDayTap,
  onArm,
}: {
  /** The 7 dates of the visible week (Sun–Sat). */
  days: Date[];
  byDay: Map<string, DayData>;
  todayK: string;
  members: CalMember[];
  /** Id of the armed job/appointment chip (ring it); tray arms don't ring here. */
  armedId: string | null;
  /** Anything armed → every day row is a move target. */
  armedActive: boolean;
  onDayTap: (d: Date) => void;
  onArm: (t: ArmedTarget) => void;
}) {
  const initials = (ids: string[] | null | undefined) => {
    const found = (ids ?? []).map((id) => members.find((m) => m.id === id)).filter(Boolean);
    const shown = found
      .slice(0, 2)
      .map((m) => initialsOf(m!.full_name))
      .join(" ");
    // Overflow is SAID ("+N"), not silently truncated to the first two.
    return found.length > 2 ? `${shown} +${found.length - 2}` : shown;
  };

  // A job's start time, unless it's the all-day sentinel (8 AM local = "no explicit
  // time" — see setJobScheduleRanges). Lets a job with a real start time show it,
  // like appointments do, while all-day jobs stay time-less.
  const jobStartLabel = (iso: string | null): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (d.getHours() === 8 && d.getMinutes() === 0) return null;
    return fmtTime(iso);
  };
  const jobChip = (k: string, { job, pos }: JobOnDay) => {
    const ini = initials(job.assigned_to);
    const t = jobStartLabel(job.scheduled_start);
    return (
      <button
        key={`j-${job.id}`}
        onClick={(e) => {
          // Chips arm; the surrounding day row is the move target — don't let
          // an arming tap double as a day tap.
          e.stopPropagation();
          onArm({ kind: "job", id: job.id, label: job.name, fromDate: k, href: `/jobs/${job.id}` });
        }}
        className={`flex min-h-[32px] w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-xs transition-colors ${
          armedId === job.id
            ? "border-amber-400 bg-amber-50 ring-1 ring-amber-400"
            : "border-blue-200 bg-blue-50 text-blue-900 hover:border-blue-400"
        }`}
      >
        {t && <span className="shrink-0 text-[10px] font-semibold text-blue-700">{t}</span>}
        <span className="min-w-0 flex-1 truncate font-medium">{job.name}</span>
        {pos && (
          // "d2/3" decoded for hover + screen readers: "Day 2 of 3".
          <span
            className="shrink-0 text-[10px] opacity-60"
            title={`Day ${pos.slice(1).replace("/", " of ")}`}
            aria-label={`Day ${pos.slice(1).replace("/", " of ")}`}
          >
            {pos}
          </span>
        )}
        {ini && <span className="shrink-0 rounded bg-white/80 px-1 text-[10px] font-semibold opacity-80">{ini}</span>}
      </button>
    );
  };

  const apptChip = (k: string, a: CalAppt) => {
    const insp = a.type === "inspection";
    const ini = initials(a.assigned_to ? [a.assigned_to] : null);
    return (
      <button
        key={`a-${a.id}`}
        onClick={(e) => {
          e.stopPropagation();
          onArm({
            kind: "appt",
            id: a.id,
            label: a.title,
            starts_at: a.starts_at,
            ends_at: a.ends_at,
            status: a.status,
            // No appointment page exists — "Open" lands on its day drill,
            // where the edit pencil and quick actions live.
            href: `/schedule?view=day&date=${k}`,
          });
        }}
        className={`flex min-h-[32px] w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-xs transition-colors ${
          armedId === a.id
            ? "border-amber-400 bg-amber-50 ring-1 ring-amber-400"
            : insp
              ? "border-teal-200 bg-teal-50 text-teal-900 hover:border-teal-400"
              : "border-violet-200 bg-violet-50 text-violet-900 hover:border-violet-400"
        } ${a.status === "proposed" ? "border-dashed opacity-80" : ""} ${a.status === "completed" ? "opacity-60" : ""}`}
      >
        {/* ◌ = awaiting the customer's pick — the ONE hollow-ring symbol, same
            as the month view's ring dot and the legend's ◌ entry. */}
        <span className="shrink-0 font-semibold" title={a.status === "proposed" ? "Awaiting customer pick" : undefined}>
          {a.status === "proposed" ? "◌" : fmtTime(a.starts_at)}
        </span>
        <span className="min-w-0 flex-1 truncate">{a.title}</span>
        {ini && <span className="shrink-0 rounded bg-white/80 px-1 text-[10px] font-semibold opacity-80">{ini}</span>}
      </button>
    );
  };

  return (
    <div className="space-y-2">
      {days.map((d) => {
        const k = dayKey(d);
        const data = byDay.get(k);
        const isToday = k === todayK;
        const taskCount = data?.tasks.length ?? 0;
        return (
          <div
            key={k}
            onClick={() => onDayTap(d)}
            className={`min-h-[44px] cursor-pointer rounded-xl border p-2 transition-colors ${
              isToday ? "border-brand/40 bg-brand-light/20" : "border-slate-200 bg-white"
            } ${armedActive ? "border-amber-300" : "hover:border-brand/40"}`}
          >
            <div className="mb-1 flex items-baseline gap-2 px-1">
              <span className={`text-xs font-semibold ${isToday ? "text-brand" : "text-slate-500"}`}>
                {d.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
              {isToday && <span className="text-[10px] font-semibold uppercase tracking-wide text-brand">Today</span>}
            </div>
            {(data?.appts.length || data?.jobs.length || taskCount > 0) ? (
              <div className="space-y-1">
                {/* All-day jobs above timed appointments — the order every
                    calendar uses. */}
                {data?.jobs.map((j) => jobChip(k, j))}
                {data?.appts.map((a) => apptChip(k, a))}
                {taskCount > 0 && (
                  <div className="px-1 pt-0.5 text-[11px] font-medium text-slate-500">
                    {taskCount} task{taskCount > 1 ? "s" : ""} due
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
