"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarSync } from "lucide-react";
import { MoveToDay } from "@/components/move-to-day";
import { initialsOf } from "@/lib/employee-color";
import { shiftApptToDay } from "@/lib/appt-time";
import { moveJobDay } from "./actions";
import { rescheduleAppointment } from "../appointments/actions";
import type { CalAppt, CalMember, DayData, JobOnDay } from "../calendar/calendar-view";

// THE default /schedule view: a vertical 7-day agenda (lifted from My Day's
// week renderer) — one full-width row per day, Sun–Sat, chips inside. No
// horizontal scroll anywhere; "what's next week" is Schedule → next chevron,
// read top to bottom. Chip color = RECORD TYPE (job blue, appointment violet,
// inspection teal, task slate — amber is reserved for needs-scheduling); WHO
// rides as initials text, not chip color — person-color lied (a two-man job
// showed one man). The color code is stated in the legend line the calendar
// shell renders under its zoom control.
//
// SAFETY: a chip's MAIN tap is non-mutating — it OPENS the record (a job chip
// navigates to /jobs/[id]; an appointment chip opens its day drill where the
// edit pencil lives). Rescheduling takes deliberate intent through the small
// move handle (the CalendarSync glyph) → the MoveToDay sheet. A stray tap can
// never silently reschedule a real appointment; there is no armed mode to leave
// dangling.

// Local copy of the day-key helper: this file only takes TYPES from
// calendar-view (import type), so there is no runtime import cycle between
// the shell and its default view.
const dayKey = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const PROPOSED_CONFIRM =
  "A pick-a-time link is out to the customer for this — moving it withdraws that link. Move it anyway?";

// The move handle: a >=44px touch target holding a ~26px CalendarSync glyph,
// stopPropagation so it can't double as the chip's open-the-record tap.
const moveHandle =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-white/70 hover:text-slate-700";

export function WeekAgenda({
  days,
  byDay,
  todayK,
  members,
  onDayTap,
  workDayStart = "08:00",
}: {
  /** The 7 dates of the visible week (Sun–Sat). */
  days: Date[];
  byDay: Map<string, DayData>;
  todayK: string;
  members: CalMember[];
  /** Open the day drill for a day (the row's main tap — never a move). */
  onDayTap: (d: Date) => void;
  /** The org's work_day_start ("HH:MM") — the all-day sentinel time to hide. */
  workDayStart?: string;
}) {
  const router = useRouter();

  const initials = (ids: string[] | null | undefined) => {
    const found = (ids ?? []).map((id) => members.find((m) => m.id === id)).filter(Boolean);
    const shown = found
      .slice(0, 2)
      .map((m) => initialsOf(m!.full_name))
      .join(" ");
    // Overflow is SAID ("+N"), not silently truncated to the first two.
    return found.length > 2 ? `${shown} +${found.length - 2}` : shown;
  };

  // A job's start time, unless it's the all-day sentinel (the org's configured
  // work_day_start, default 8 AM local = "no explicit time" — see
  // setJobScheduleRanges). Lets a job with a real start time show it, like
  // appointments do, while all-day jobs stay time-less.
  const [wdHour, wdMin] = workDayStart.split(":").map(Number);
  const jobStartLabel = (iso: string | null): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (d.getHours() === wdHour && d.getMinutes() === wdMin) return null;
    return fmtTime(iso);
  };

  const jobChip = (k: string, { job, pos }: JobOnDay) => {
    const ini = initials(job.assigned_to);
    const t = jobStartLabel(job.scheduled_start);
    return (
      <div
        key={`j-${job.id}`}
        className="flex min-h-[44px] w-full items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 pl-2 text-blue-900 transition-colors hover:border-blue-400"
      >
        {/* Main tap OPENS the job — a chip is a link to its record, never a
            move. onClick stops here so the day row's drill tap doesn't fire. */}
        <Link
          href={`/jobs/${job.id}`}
          onClick={(e) => e.stopPropagation()}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs"
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
        </Link>
        {/* Deliberate-move handle → the shared MoveToDay sheet. */}
        <div onClick={(e) => e.stopPropagation()}>
          <MoveToDay
            label={`Move ${job.name} to a day`}
            triggerClassName={moveHandle}
            onPick={async (dateISO) => {
              if (!dateISO) return { ok: false, error: "Pick a day." };
              let res = await moveJobDay(job.id, k, dateISO);
              if (!res.ok && res.needsProposalConfirm) {
                if (!confirm(PROPOSED_CONFIRM)) return { ok: true, note: "Left it alone — the link is still live." };
                res = await moveJobDay(job.id, k, dateISO, { cancelProposals: true });
              }
              if (res.ok) router.refresh();
              return res;
            }}
          >
            <CalendarSync className="h-4 w-4" />
          </MoveToDay>
        </div>
      </div>
    );
  };

  const apptChip = (k: string, a: CalAppt) => {
    const insp = a.type === "inspection";
    const ini = initials(a.assigned_to ? [a.assigned_to] : null);
    return (
      <div
        key={`a-${a.id}`}
        className={`flex min-h-[44px] w-full items-center gap-1 rounded-lg border pl-2 transition-colors ${
          insp
            ? "border-teal-200 bg-teal-50 text-teal-900 hover:border-teal-400"
            : "border-violet-200 bg-violet-50 text-violet-900 hover:border-violet-400"
        } ${a.status === "proposed" ? "border-dashed opacity-80" : ""} ${a.status === "completed" ? "opacity-60" : ""}`}
      >
        {/* Main tap OPENS the appointment's day drill (no appointment page
            exists — the edit pencil + quick actions live there). */}
        <Link
          href={`/schedule?view=day&date=${k}`}
          onClick={(e) => e.stopPropagation()}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs"
        >
          {/* ◌ = awaiting the customer's pick — the ONE hollow-ring symbol, same
              as the month view's ring dot and the legend's ◌ entry. */}
          <span className="shrink-0 font-semibold" title={a.status === "proposed" ? "Awaiting customer pick" : undefined}>
            {a.status === "proposed" ? "◌" : fmtTime(a.starts_at)}
          </span>
          <span className="min-w-0 flex-1 truncate">{a.title}</span>
          {ini && <span className="shrink-0 rounded bg-white/80 px-1 text-[10px] font-semibold opacity-80">{ini}</span>}
        </Link>
        {/* Deliberate-move handle → the shared MoveToDay sheet (DST-safe via
            shiftApptToDay; a live pick-a-time link is confirmed away first). */}
        <div onClick={(e) => e.stopPropagation()}>
          <MoveToDay
            label={`Move ${a.title} to a day`}
            triggerClassName={moveHandle}
            onPick={async (dateISO) => {
              if (!dateISO) return { ok: false, error: "Pick a day." };
              if (a.status === "proposed" && !confirm(PROPOSED_CONFIRM))
                return { ok: true, note: "Left it alone — the link is still live." };
              const t = shiftApptToDay(a.starts_at, a.ends_at, dateISO);
              const res = await rescheduleAppointment(a.id, t.start, t.end);
              if (res.ok) router.refresh();
              return res; // a withdrawn pick-a-time link surfaces via `note`
            }}
          >
            <CalendarSync className="h-4 w-4" />
          </MoveToDay>
        </div>
      </div>
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
              isToday ? "border-brand/40 bg-brand-light/20" : "border-slate-200 bg-white hover:border-brand/40"
            }`}
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
