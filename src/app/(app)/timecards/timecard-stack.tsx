"use client";

import { useMemo, useRef } from "react";
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

type WeekData = {
  days: { dayStr: string; label: string; isToday: boolean; heavyStart: boolean }[];
  events: TimeGridEvent[];
  weekHours: number;
  mark: ReturnType<typeof periodOpeningIn>;
};

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

  /* STABLE PROPS PER WEEK, or the memo on TimeGrid is decoration. Every growth re-renders this
     component and `weeks` is a fresh array — but a week's days/events/mark only actually change
     when the DATA changes, so they're built once per (week, data) and handed back by reference.
     That's what lets 25 already-mounted grids bail out while the 26th mounts. */
  /* The cache lives in a ref so it SURVIVES growths — `weeks` is a fresh array every time the
     stack grows, and a plain useMemo keyed on it would rebuild every entry and churn every
     reference, leaving the memo on TimeGrid with nothing to bail out on. Only a change in the
     DATA empties it; a growth merely fills in the one new week. */
  const cacheRef = useRef(new Map<string, WeekData>());
  const cacheKeyRef = useRef<unknown[]>([]);
  const weekData = useMemo(() => {
    const key = [byDay, paySchedule, payAnchor, todayStr];
    if (key.some((v, i) => v !== cacheKeyRef.current[i])) {
      cacheRef.current = new Map();
      cacheKeyRef.current = key;
    }
    const cache = cacheRef.current;
    for (const days of weeks) {
      if (cache.has(days[0])) continue;
      const mark = periodOpeningIn(days, paySchedule, payAnchor);
      const events: TimeGridEvent[] = [];
      let weekHours = 0;
      for (const d of days) {
        for (const e of byDay.get(d) ?? []) {
          events.push(e);
          weekHours += e.hours;
        }
      }
      cache.set(days[0], {
        days: days.map((ds) => ({
          dayStr: ds,
          label: labelFor(ds),
          isToday: ds === todayStr,
          heavyStart: !!mark && mark.start === ds,
        })),
        events,
        weekHours: Math.round(weekHours * 100) / 100,
        mark,
      });
    }
    return cache;
  }, [weeks, byDay, paySchedule, payAnchor, todayStr]);

  if (!weeks.length) return null;

  return (
    <div
      ref={stack.scrollRef}
      onScroll={stack.onScroll}
      /* No overscroll-contain: with it, a thumb landing on this scroller could ONLY scroll the
         stack — and since the stack grows as you near its bottom, the page below it was
         unreachable by normal scrolling. At the edges the gesture chains to the page now, which is
         the escape. And the height floors at 70dvh everywhere: the old sm: calc left a 55px slit
         on a landscape phone (640px wide IS sm:, but only ~375px tall). */
      className="max-h-[70dvh] space-y-3 overflow-y-auto sm:max-h-[max(70dvh,calc(100dvh-20rem))]"
    >
      {weeks.map((days) => {
        const wd = weekData.get(days[0])!;
        const { mark, events, weekHours } = wd;
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
              {/* THE GRID IS A DESKTOP INSTRUMENT. Erik: "timecard scroll on my phone froze up
                  and doesnt show me the calendar so we may need a better layout for small
                  devices." On a 375px screen each week is seven columns scrolling SIDEWAYS inside
                  a stack scrolling DOWN — nested opposing scrollers that iOS handles badly, for a
                  grid where each column is 50px of unreadable slivers anyway. A phone gets the
                  answers as a list: who, when, how long, tap to fix. Same data, same links. */}
              <div className="sm:hidden">
                {days
                  .filter((ds) => (byDay.get(ds) ?? []).length > 0)
                  .map((ds) => (
                    <div key={ds} className="border-b border-slate-100 last:border-b-0">
                      <div className={`flex items-baseline justify-between px-3 pt-2 text-xs font-semibold ${ds === todayStr ? "text-brand" : "text-slate-500"}`}>
                        <span>
                          {labelFor(ds)}
                          {!!mark && mark.start === ds && (
                            <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-brand">new pay period</span>
                          )}
                        </span>
                        <span className="font-mono tabular-nums text-slate-400">
                          {(Math.round((byDay.get(ds) ?? []).reduce((t, e) => t + e.hours, 0) * 100) / 100).toFixed(2)} h
                        </span>
                      </div>
                      <ul>
                        {(byDay.get(ds) ?? []).map((e) => (
                          <li key={e.id}>
                            <a href={e.href} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50">
                              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${e.color.split(" ")[0]}`} aria-hidden />
                              <span className="min-w-0 flex-1 truncate text-slate-800">{e.label}</span>
                              <span className="shrink-0 text-xs text-slate-500">{e.sub}</span>
                              <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-slate-600">
                                {e.hours.toFixed(2)}
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                {events.length === 0 && (
                  <p className="px-3 py-4 text-center text-xs text-slate-400">No hours this week.</p>
                )}
              </div>
              <div className="hidden sm:block">
                <TimeGrid
                  days={wd.days}
                  events={events}
                  workStartMin={workStartMin}
                  workEndMin={workEndMin}
                  tz={tz}
                  initialNow={{ dayStr: todayStr, min: nowMin }}
                />
              </div>
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
