"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { TimeGrid, type TimeGridEvent } from "@/components/time-grid";
import { useEndlessStack } from "@/components/use-endless-stack";
import { spanLabel } from "@/lib/schedule/span-label";
import {
  hoursInPeriod,
  periodLabel,
  periodOpeningIn,
  type PaySchedule,
} from "@/lib/schedule/pay-period-stack";

/**
 * THE WEEKS, RUNNING, WITH THE PAY PERIODS MARKED.
 *
 * Erik: "continuous scroll which should also be on timecards with pay period break lines."
 *
 * Timecards paged one week at a time behind two arrows, so answering "what did we actually pay him
 * for last period" meant clicking back, reading, clicking back, reading, and holding both halves in
 * your head — for the one number the whole page exists to produce. Scrolling removes the clicking;
 * the break lines make the scroll legible, because past a certain speed weeks all look alike.
 *
 * Deliberately the SAME TimeGrid and the SAME scroll hook as the calendar. Not similar — the same.
 * A second scroll latch would mean fixing the "six months in half a second" bug twice, and a second
 * grid would mean the timecards drift away from the schedule they are the record of.
 */
export type StackEntry = {
  id: string;
  dayStr: string;
  startMin: number;
  /** null = still on the clock; TimeGrid runs it to the live now line. */
  endMin: number | null;
  hours: number;
  label: string;
  sub: string;
  color: string;
  href: string;
};

export function TimecardStack({
  entries,
  anchorWeek,
  todayStr,
  workStartMin,
  workEndMin,
  tz,
  nowMin,
  paySchedule,
  payAnchor,
}: {
  entries: StackEntry[];
  /** The seven day-strings of the week the page is anchored on. */
  anchorWeek: string[];
  todayStr: string;
  workStartMin: number;
  workEndMin: number;
  tz: string;
  nowMin: number;
  paySchedule: PaySchedule;
  payAnchor: string;
}) {
  const stack = useEndlessStack(anchorWeek[0] ?? todayStr, 26, 8);

  /** The weeks on screen, oldest first. Pure day-string arithmetic at local noon so a DST change
   *  can't shunt a whole week by a day. */
  const weeks = useMemo(() => {
    const out: string[][] = [];
    const base = anchorWeek[0];
    if (!base) return out;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(base);
    if (!m) return out;
    for (let w = -stack.back; w <= stack.fwd; w++) {
      const days: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        d.setDate(d.getDate() + w * 7 + i);
        days.push(
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        );
      }
      out.push(days);
    }
    return out;
  }, [anchorWeek, stack.back, stack.fwd]);

  const byDay = useMemo(() => {
    const m = new Map<string, StackEntry[]>();
    for (const e of entries) {
      if (!m.has(e.dayStr)) m.set(e.dayStr, []);
      m.get(e.dayStr)!.push(e);
    }
    return m;
  }, [entries]);

  const hourRows = useMemo(
    () => entries.map((e) => ({ dayStr: e.dayStr, hours: e.hours })),
    [entries],
  );

  if (!weeks.length) return null;

  return (
    <div
      ref={stack.scrollRef}
      onScroll={stack.onScroll}
      className="max-h-[calc(100dvh-20rem)] space-y-3 overflow-y-auto overscroll-contain"
    >
      {weeks.map((days) => {
        const mark = periodOpeningIn(days, paySchedule, payAnchor);
        const events: TimeGridEvent[] = [];
        let weekHours = 0;
        for (const d of days) {
          for (const e of byDay.get(d) ?? []) {
            events.push(e);
            weekHours += e.hours;
          }
        }
        weekHours = Math.round(weekHours * 100) / 100;
        const hasToday = days.includes(todayStr);

        return (
          <div key={days[0]}>
            {/* ── THE BREAK LINE ─────────────────────────────────────────────────────────────
                Drawn only where a pay period actually opens, which for biweekly is every other
                week — so it stays a signal instead of becoming a rule that repeats until nobody
                reads it. It carries the period's hours, because at a boundary that is the number
                somebody is about to be paid on, and the dates INCLUSIVE of the last day worked
                (payPeriodBounds is half-open, and naming the wrong last day is how payroll
                arguments start). */}
            {mark && (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t-2 border-brand/50 pt-2">
                <span className="text-xs font-bold uppercase tracking-wide text-brand">
                  Pay period
                </span>
                <span className="text-sm font-semibold text-slate-800">{periodLabel(mark)}</span>
                <span className="font-mono text-xs tabular-nums text-slate-500">
                  {hoursInPeriod(hourRows, mark).toFixed(2)} h
                </span>
                {mark.midWeek && (
                  // Semimonthly starts on the 16th, mid-week. Say so rather than letting the line
                  // above a Monday imply the period began there.
                  <span className="text-xs text-slate-400">starts mid-week</span>
                )}
              </div>
            )}

            <Card className="overflow-clip">
              <div
                className={`sticky top-0 z-20 flex items-baseline gap-2 border-b px-3 py-1.5 text-xs font-semibold backdrop-blur ${
                  hasToday
                    ? "border-brand/30 bg-brand-light/70 text-brand"
                    : "border-slate-100 bg-white/90 text-slate-500"
                }`}
              >
                <span>{weekSpan(days)}</span>
                {hasToday && (
                  <span className="text-[10px] font-bold uppercase tracking-wide">this week</span>
                )}
                <span className="ml-auto font-mono tabular-nums text-slate-500">
                  {weekHours.toFixed(2)} h
                </span>
              </div>
              <TimeGrid
                days={days.map((ds) => ({
                  dayStr: ds,
                  label: labelFor(ds),
                  isToday: ds === todayStr,
                  // The heavy divider stays: it marks the exact DAY a period starts, which the
                  // break line above the week cannot do on a mid-week boundary.
                  heavyStart: !!mark && mark.start === ds,
                }))}
                events={events}
                workStartMin={workStartMin}
                workEndMin={workEndMin}
                tz={tz}
                initialNow={{ dayStr: todayStr, min: nowMin }}
              />
            </Card>
          </div>
        );
      })}
      {/* NOTHING SILENT: say where the scroll stops rather than just refusing to grow. */}
      {stack.back >= 26 && (
        <p className="py-2 text-center text-xs text-slate-400">
          Six months back. Use the arrows above to jump further.
        </p>
      )}
    </div>
  );
}

const weekSpan = (days: string[]): string => {
  const a = parseLocal(days[0]);
  const z = parseLocal(days[6]);
  return a && z ? spanLabel(a, z, { month: "long" }) : days[0];
};

const labelFor = (ds: string): string => {
  const d = parseLocal(ds);
  return d ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : ds;
};

/** Local, never `new Date(ymd)` — UTC midnight reads as yesterday west of Greenwich. */
function parseLocal(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
