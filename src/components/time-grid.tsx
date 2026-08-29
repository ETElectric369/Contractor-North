"use client";

import React from "react";
import { todayStrInTz, tzMinutesOfDay } from "@/lib/tz";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * TimeGrid — the shared Google-Calendar-style vertical day-column grid
 * (Erik: "I work a lot better seeing the blocks located in their time
 * allotment"). Hour gutter on the left, N day columns (1 = day view,
 * 7 = week), events as absolutely-positioned rounded pills whose top/height
 * come from their start/end minutes. Overlaps split side-by-side, a "now"
 * line ticks on today, all-day/undated items sit in a thin tray above the
 * columns (never faked into a time slot). DISPLAY-focused v1 — a pill's tap
 * opens its record (href); there is no drag/resize, so a stray touch can
 * never move anything (the deliberate-move law).
 *
 * Dependency-free: pure JSX + Tailwind classes matching the app's slate/glass
 * look. Colors ride IN on each event as a full class string (static strings
 * so the JIT keeps them) — the grid itself is color-agnostic; /timecards
 * colors by person, /schedule colors by record type.
 */

export interface TimeGridDay {
  dayStr: string; // "YYYY-MM-DD"
  label: string; // "Mon 14"
  isToday?: boolean;
  /** WHERE the day's committed work is — "Truckee", or "Truckee · Tahoe City".
   *  Erik's ride-along rule: "if a walk through makes more sense to wait until thursday and do
   *  that job nearby that day then that one gets filtered". Seeing the town on the day, next to a
   *  rail that says "Truckee (5)", answers that without the app pretending to know how long
   *  anything takes. A LABEL, not a capacity model. */
  sublabel?: string;
  /** Heavier left divider on this column — /timecards marks pay-period
   *  boundary days so the payroll week reads against the pay cycle. */
  heavyStart?: boolean;
}

export interface TimeGridEvent {
  id: string;
  dayStr: string; // which column
  startMin: number; // minutes from that day's local midnight
  /** null = still open — the pill runs to the live "now" line on today
   *  (an open clock-in), or to the bottom of the range on a past day. */
  endMin: number | null;
  label: string;
  sub?: string | null;
  /** Full Tailwind class string for the pill (border/bg/text + modifiers). */
  color: string;
  href?: string;
}

export interface TimeGridAllDay {
  id: string;
  dayStr: string;
  label: string;
  color: string;
  href?: string;
}


const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
const MIN_COL_PX = 92; // 7 columns scroll horizontally on a phone; day view is the zoom-in

type Now = { dayStr: string; min: number };

/** Where the live "now" line sits: org-tz day + minutes via the lib/tz SSOT
 *  primitives (the same pair timeEntryGridSpan uses) — not a third hand-rolled
 *  formatToParts copy of the instant→org-day math. No-tz fallback = browser local. */
function computeNow(tz?: string): Now {
  const d = new Date();
  if (tz) return { dayStr: todayStrInTz(tz, d), min: tzMinutesOfDay(d, tz) };
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    dayStr: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    min: d.getHours() * 60 + d.getMinutes(),
  };
}

/** Side-by-side overlap layout: transitively-overlapping events form a
 *  cluster; each takes the first free column, and the cluster's column count
 *  divides the width — the classic calendar packing. */
function layoutColumns<T extends { startMin: number; endMin: number }>(
  evts: T[],
): (T & { col: number; cols: number })[] {
  const sorted = [...evts].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: (T & { col: number; cols: number })[] = [];
  let cluster: (T & { col: number; cols: number })[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const n = colEnds.length || 1;
    for (const e of cluster) e.cols = n;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
    clusterEnd = -1;
  };
  for (const e of sorted) {
    if (cluster.length && e.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= e.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(e.endMin);
    } else colEnds[col] = e.endMin;
    clusterEnd = Math.max(clusterEnd, e.endMin);
    cluster.push({ ...e, col, cols: 1 });
  }
  flush();
  return out;
}

const hourLabel = (h: number) => {
  const hh = ((h + 11) % 12) + 1;
  return `${hh} ${h < 12 || h === 24 ? "AM" : "PM"}`;
};

function TimeGridInner({
  days,
  events,
  allDay = [],
  workStartMin = 480, // 08:00
  workEndMin = 960, // 16:00
  tz,
  initialNow,
  onDayClick,
  placement,
}: {
  days: TimeGridDay[];
  events: TimeGridEvent[];
  allDay?: TimeGridAllDay[];
  /** Org work-day window (minutes) — the default visible range is this ±2h,
   *  expanded to fit outlier events. */
  workStartMin?: number;
  workEndMin?: number;
  /** IANA tz the grid's "now" ticks in (org tz on /timecards). Default:
   *  the browser's local time. */
  tz?: string;
  /** Server-computed now (same tz) so SSR and hydration agree — without it
   *  the now line appears after mount. */
  initialNow?: Now;
  /** Tap a day header → drill (never a move). */
  onDayClick?: (dayStr: string) => void;
  /**
   * ARMED: the calendar is being used as a day picker right now.
   *
   * Erik: "being able to click the day on the calendar to pick it once the jobs are checked."
   * When this is set, a tap on a day PLACES the picked work instead of drilling into that day —
   * the same tap, a different meaning. That is a trap unless the mode is impossible to miss, so
   * armed days wear a target ring and say what tapping them will do. See lib/schedule/placement-plan.
   */
  placement?: { label: string; onPlace: (dayStr: string) => void };
}) {
  const [now, setNow] = useState<Now | null>(initialNow ?? null);
  useEffect(() => {
    const tick = () => setNow(computeNow(tz));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [tz]);

  // Scroll today into view once (week view on a phone shows ~4 columns).
  const scrollRef = useRef<HTMLDivElement>(null);
  const todayColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scrollRef.current;
    const col = todayColRef.current;
    if (!box || !col || box.scrollWidth <= box.clientWidth) return;
    box.scrollLeft = Math.max(0, col.offsetLeft - 48 /* gutter */);
  }, []);

  // Visible range: work window ±2h, stretched to cover outliers (an early
  // clock-in, a 7 PM inspection), snapped to whole hours. Deterministic
  // across SSR/hydration: uses initialNow (a prop), never the ticking state.
  let lo = workStartMin - 120;
  let hi = workEndMin + 120;
  for (const e of events) {
    lo = Math.min(lo, e.startMin);
    hi = Math.max(hi, e.endMin ?? (initialNow && e.dayStr === initialNow.dayStr ? initialNow.min : e.startMin + 60));
  }
  const startHour = Math.max(0, Math.floor(lo / 60));
  const endHour = Math.min(24, Math.ceil(hi / 60));
  const rangeStart = startHour * 60;
  const rangeEnd = endHour * 60;
  const gridH = (rangeEnd - rangeStart) * PX_PER_MIN;

  /** An event's effective end: open entries run to the (live) now line on
   *  today, or to the bottom of the range when they're a stale past-day open. */
  const effEnd = (e: TimeGridEvent): number => {
    if (e.endMin != null) return Math.min(e.endMin, rangeEnd);
    if (now && e.dayStr === now.dayStr) return Math.min(rangeEnd, Math.max(e.startMin + 15, now.min));
    return rangeEnd;
  };

  const byDay = new Map<string, (TimeGridEvent & { endMin: number })[]>();
  for (const e of events) {
    if (!byDay.has(e.dayStr)) byDay.set(e.dayStr, []);
    byDay.get(e.dayStr)!.push({ ...e, endMin: Math.max(e.startMin + 1, effEnd(e)) });
  }

  const allDayByDay = new Map<string, TimeGridAllDay[]>();
  for (const a of allDay) {
    if (!allDayByDay.has(a.dayStr)) allDayByDay.set(a.dayStr, []);
    allDayByDay.get(a.dayStr)!.push(a);
  }
  const hasAllDay = allDay.length > 0;

  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);

  const colBorder = (d: TimeGridDay) =>
    d.heavyStart ? "border-l-2 border-l-slate-400" : "border-l border-l-slate-100";

  const pillBody = (label: string, sub?: string | null) => (
    <>
      <div className="truncate font-semibold">{label}</div>
      {sub && <div className="truncate opacity-70">{sub}</div>}
    </>
  );

  return (
    <div ref={scrollRef} className="overflow-x-auto">
      <div style={{ minWidth: days.length > 1 ? 48 + days.length * MIN_COL_PX : undefined }}>
        {/* Day headers */}
        <div className="flex border-b border-slate-100">
          <div className="w-12 shrink-0" />
          {days.map((d) => {
            const head = (
              <span className={d.isToday ? "font-bold text-brand" : ""}>
                {d.label}
                {d.isToday && (
                  <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide">today</span>
                )}
                {d.sublabel && (
                  <span className="block truncate text-[10px] font-medium text-slate-400" title={d.sublabel}>
                    {d.sublabel}
                  </span>
                )}
              </span>
            );
            /* ARMED — the header is the drop zone and says so. Not a hover-only affordance:
               on a phone there is no hover, and this is a phone-in-a-truck screen. */
            if (placement) {
              return (
                <button
                  key={d.dayStr}
                  onClick={() => placement.onPlace(d.dayStr)}
                  title={`${placement.label} — ${d.label}`}
                  className={`group min-w-0 flex-1 truncate border-t-2 border-t-brand/60 bg-brand-light/30 px-1 py-1.5 text-center text-xs font-medium text-slate-600 hover:bg-brand-light ${colBorder(d)}`}
                >
                  {head}
                  <span className="mt-0.5 block truncate text-[10px] font-semibold text-brand">
                    {placement.label}
                  </span>
                </button>
              );
            }
            return onDayClick ? (
              <button
                key={d.dayStr}
                onClick={() => onDayClick(d.dayStr)}
                className={`min-w-0 flex-1 truncate px-1 py-1.5 text-center text-xs font-medium text-slate-600 hover:bg-slate-50 ${colBorder(d)}`}
              >
                {head}
              </button>
            ) : (
              <div
                key={d.dayStr}
                className={`min-w-0 flex-1 truncate px-1 py-1.5 text-center text-xs font-medium text-slate-600 ${colBorder(d)}`}
              >
                {head}
              </div>
            );
          })}
        </div>

        {/* All-day tray — timeless items stay timeless (never faked into a slot). */}
        {hasAllDay && (
          <div className="flex border-b border-slate-100 bg-slate-50/50">
            <div className="flex w-12 shrink-0 items-start justify-end pr-1 pt-1 text-[9px] font-medium uppercase tracking-wide text-slate-400">
              all day
            </div>
            {days.map((d) => (
              <div key={d.dayStr} className={`min-w-0 flex-1 space-y-0.5 p-0.5 ${colBorder(d)}`}>
                {(allDayByDay.get(d.dayStr) ?? []).map((a) =>
                  a.href ? (
                    <Link
                      key={a.id}
                      href={a.href}
                      title={a.label}
                      className={`block truncate rounded border px-1 py-px text-[10px] font-medium leading-snug hover:opacity-80 ${a.color}`}
                    >
                      {a.label}
                    </Link>
                  ) : (
                    <div
                      key={a.id}
                      title={a.label}
                      className={`truncate rounded border px-1 py-px text-[10px] font-medium leading-snug ${a.color}`}
                    >
                      {a.label}
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
        )}

        {/* The grid: hour gutter + one positioned column per day */}
        <div className="flex">
          <div className="relative w-12 shrink-0" style={{ height: gridH }}>
            {hours.slice(0, -1).map((h) => (
              <div
                key={h}
                className="absolute right-1 text-right text-[10px] leading-none text-slate-400"
                style={{ top: (h * 60 - rangeStart) * PX_PER_MIN + (h === startHour ? 2 : -4) }}
              >
                {hourLabel(h)}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const laid = layoutColumns(byDay.get(d.dayStr) ?? []);
            const showNow = now && now.dayStr === d.dayStr && now.min >= rangeStart && now.min <= rangeEnd;
            return (
              <div
                key={d.dayStr}
                ref={d.isToday ? todayColRef : undefined}
                className={`relative min-w-0 flex-1 ${colBorder(d)} ${d.isToday ? "bg-brand-light/15" : ""}`}
                style={{ height: gridH }}
              >
                {/* THE WHOLE COLUMN IS THE TARGET while armed — a 12px header strip is a hard
                    thing to hit with a thumb, and the column is the shape he is aiming at anyway.
                    The pills above it place too (see below): while armed, every tap on the day
                    means the day. */}
                {placement && (
                  <button
                    type="button"
                    onClick={() => placement.onPlace(d.dayStr)}
                    aria-label={`${placement.label} on ${d.label}`}
                    className="absolute inset-0 bg-brand-light/20 transition-colors hover:bg-brand-light/60"
                  />
                )}

                {/* hour rules */}
                {hours.slice(1, -1).map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-slate-100"
                    style={{ top: (h * 60 - rangeStart) * PX_PER_MIN }}
                  />
                ))}

                {/* event pills */}
                {laid.map((e) => {
                  const top = (Math.max(e.startMin, rangeStart) - rangeStart) * PX_PER_MIN;
                  const height = Math.max(16, (e.endMin - Math.max(e.startMin, rangeStart)) * PX_PER_MIN);
                  const style: React.CSSProperties = {
                    top,
                    height,
                    left: `calc(${(e.col / e.cols) * 100}% + 2px)`,
                    width: `calc(${100 / e.cols}% - 4px)`,
                  };
                  const cls = `absolute overflow-hidden rounded-md border px-1 py-0.5 text-[10px] leading-tight shadow-sm ${e.color}`;
                  const title = e.sub ? `${e.label} · ${e.sub}` : e.label;
                  /* ARMED, A PILL PLACES TOO. On a busy day the pills cover most of the column,
                     so the natural tap landed on a Link, navigated to that job, unmounted the
                     provider and silently threw away every pick and the AM/PM choice — the worst
                     possible answer to the exact tap the mode invites. While armed, the whole
                     column means one thing. */
                  return placement ? (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => placement.onPlace(d.dayStr)}
                      style={style}
                      title={`${placement.label} — ${d.label}`}
                      className={`${cls} text-left opacity-60`}
                    >
                      {pillBody(e.label, e.sub)}
                    </button>
                  ) : e.href ? (
                    <Link key={e.id} href={e.href} style={style} title={title} className={`${cls} hover:opacity-80`}>
                      {pillBody(e.label, e.sub)}
                    </Link>
                  ) : (
                    <div key={e.id} style={style} title={title} className={cls}>
                      {pillBody(e.label, e.sub)}
                    </div>
                  );
                })}

                {/* the now line */}
                {showNow && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10"
                    style={{ top: (now!.min - rangeStart) * PX_PER_MIN }}
                  >
                    <div className="relative border-t-2 border-rose-500">
                      <span className="absolute -left-0.5 -top-[5px] h-2 w-2 rounded-full bg-rose-500" />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


/**
 * Memoized: the endless stacks mount one of these per week/month, and every growth of the stack
 * re-renders the parent — without memo, all N mounted grids reconciled on every single growth
 * (O(N²) over a scroll-back), which on a phone is the difference between scrolling and freezing.
 * Callers keep per-week props referentially stable (see timecard-stack's weekData cache) so the
 * bailout actually fires.
 */
export const TimeGrid = React.memo(TimeGridInner);
