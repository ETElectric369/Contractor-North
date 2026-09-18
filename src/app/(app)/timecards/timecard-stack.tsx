"use client";

import { useMemo, useRef, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeGrid, type TimeGridEvent } from "@/components/time-grid";
import { useEndlessStack } from "@/components/use-endless-stack";
import { spanLabel } from "@/lib/schedule/span-label";
import { summarizeMileage } from "@/lib/mileage-math";
import { initials } from "@/lib/utils";
import {
  hoursInPeriod,
  periodLabel,
  periodOpeningIn,
  type PaySchedule,
} from "@/lib/schedule/pay-period-stack";

/** One person's slice of one week, in the By Person grouping. */
type PersonWeek = {
  id: string;
  name: string;
  hours: number;
  /** Shifts of theirs still running — worth zero hours, named rather than folded in. */
  open: number;
  entries: StackEntry[];
  /** The commute baseline this person's miles are split against (0 = no baseline set). */
  baseline: number;
  mileage: ReturnType<typeof summarizeMileage>;
};

type WeekData = {
  days: { dayStr: string; label: string; isToday: boolean; heavyStart: boolean }[];
  events: TimeGridEvent[];
  weekHours: number;
  /** Shifts still running inside this week — worth ZERO hours, and said out loud beside the
   *  total rather than quietly folded into it. See the `open` note on StackEntry. */
  weekOpen: number;
  /** The same count for the pay period this week opens, when it opens one. */
  periodOpen: number;
  /** The same shifts, stacked under the person instead of under the day. */
  people: PersonWeek[];
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
 *
 * ── AND NOW IT IS THE ONLY LIST (cn-v956) ───────────────────────────────────────────────────
 *
 * Under this stack there used to be a second rendering of the same shifts: one Card per person,
 * their week's entries listed again with the job, the badges, the notes, the split lines and the
 * edit tools. Two lists of one set of facts, which is what Erik was looking at: "there is way too
 * much in my face i dont even know what it all is and it looks like duplicates". Wave 2 made the
 * two agree on arithmetic. This one stops them being two.
 *
 * The per-person list is now a GROUPING of this stack, chosen by [By Day | By Person] above it,
 * and everything the card carried rides on the row: the job as a link, the code badge, the manual
 * and offline disclosures, lunch, the hours, the notes, the split lines and the pencil/duplicate
 * controls. THE ROW IS THE SAME ROW IN BOTH GROUPINGS (see ShiftRow) — By Day leads with the
 * person, By Person leads with the day, and nothing else differs, so the two cannot drift apart
 * again the way the two lists did.
 *
 * The toggle changes the grouping INSIDE each week, never the span: the week header above a group
 * always names the same seven days the numbers inside it were summed from.
 */
export type StackEntry = {
  id: string;
  /** Who worked it — the By Person grouping key, and the row's lead in By Day. */
  personId: string;
  personName: string;
  person: string;
  dayStr: string;
  /** The raw clock-in, only so mileage is split by summarizeMileage's OWN day bucketing
   *  (lib/mileage-math is the SSOT; this screen does not re-derive a commute rule). */
  clockIn: string;
  startMin: number;
  /** null = still on the clock; TimeGrid runs it to the live now line. */
  endMin: number | null;
  /** Hours by the app's ONE rule (lib/utils hoursBetween, lunch deducted), computed on the
   *  server. ZERO on an open shift — see `open`. */
  hours: number;
  /**
   * STILL ON THE CLOCK.
   *
   * This stack used to be handed a live figure for a running shift — clock-in against the wall
   * clock — while the totals everywhere else on the page, and on /payroll, counted closed shifts
   * only. So the same week showed two numbers that disagreed the moment anybody punched in, and
   * neither of them said why. That is the "looks like duplicates" complaint, underneath.
   *
   * An open shift is worth nothing until it is closed, so it adds 0 to every total here. It is
   * still real and still happening, so it still DRAWS on the grid and still lists on the phone —
   * it just reads "on the clock" where a number would be, and the week says how many are running.
   * The fact is stated rather than hidden, which is the opposite of what the live number did.
   */
  open: boolean;
  /** Logged miles. DATA, never dollars: a mileage settlement is typed by a human on /payroll
   *  (0095's two-lock rule), so nothing here multiplies miles by anything. */
  miles: number;
  label: string;
  sub: string;
  color: string;
  /** The person's legend swatch (a real bg- class). The row used to paint its dot with
   *  color.split(" ")[0], which is the pill's BORDER class — a transparent circle. */
  dot: string;
  href: string;
  /** The job, as a link to the job itself. THE NAME, never J-0xx (jobLabel is the SSOT). */
  job: { href: string; label: string } | null;
  jobCode: string | null;
  /** DISCLOSURE IS THE GUARD (0168): where this punch's time came from, when it was not the
   *  server clock. Never dropped, in either grouping. */
  source: "manual" | "offline" | null;
  lunchMin: number;
  notes: string | null;
  /** The shift's split-across-jobs lines. Only the anchored week is read deeply enough to
   *  carry these (see the page's note) — a row without them still opens the editor that has. */
  allocations?: { jobCode: string | null; hours: number; description: string | null }[];
  /** Duplicate + pencil, server-rendered on the page that owns the editor's projection. Same
   *  reason as allocations: present for the anchored week, and every row is a tap into the
   *  editor regardless, so no row is ever a dead end. */
  controls?: ReactNode;
};

export type Grouping = "day" | "person";

/** "38.20 h" / "38.20 h · 1 still on the clock". One phrase, used at the week, at the pay
 *  period, at the day and at the person, so they can never say it differently. */
function hoursLine(hours: number, open: number): string {
  return `${hours.toFixed(2)} h${open > 0 ? ` · ${open} still on the clock` : ""}`;
}

/** "42.1 mi business · 51.0 logged" — the split stays VISIBLE (cn-v138): raw logged miles fold
 *  in the personal commute, so a bare number would read as reimbursable when it is not. */
function mileageLine(p: PersonWeek): string {
  return p.baseline > 0
    ? `${p.mileage.business.toFixed(1)} mi business · ${p.mileage.recorded.toFixed(1)} logged`
    : `${p.mileage.recorded.toFixed(1)} mi`;
}

/**
 * ONE SHIFT, ONE ROW, BOTH WAYS UP.
 *
 * This is the whole point of the wave: By Day and By Person render THIS, so a fact can never be on
 * one list and missing from the other. `lead` is the only difference — the person's first name
 * when the days are the spine, the day when the people are.
 *
 * THE WHOLE ROW IS THE DOOR. One tap opens this shift's editor through the ?entry= path the page
 * already answers (OpenEntryEditor), not a second way in. The overlay link sits UNDER the content
 * so the two things that are not "open the editor" — the job link, and the pencil/duplicate pair —
 * can take their own taps on top of it.
 */
function ShiftRow({ e, lead }: { e: StackEntry; lead: string }) {
  return (
    <li className="relative border-b border-slate-100 last:border-b-0">
      <Link
        href={e.href}
        scroll={false}
        aria-label={`Open ${lead} ${e.sub}`}
        className="absolute inset-0 hover:bg-slate-50 active:bg-slate-100"
      />
      <div className="pointer-events-none relative px-3 py-1.5">
        <div className="flex min-h-[28px] items-center gap-2 text-sm">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${e.dot}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-slate-800">
            <span className="font-medium">{lead}</span>
            {e.job && (
              <>
                <span className="text-slate-400"> · </span>
                <Link href={e.job.href} className="pointer-events-auto font-medium text-brand hover:underline">
                  {e.job.label}
                </Link>
              </>
            )}
          </span>
          {e.open ? (
            <span className="shrink-0 text-xs font-medium text-emerald-700">on the clock</span>
          ) : (
            <span className="shrink-0 font-mono text-xs tabular-nums text-slate-600">{e.hours.toFixed(2)}</span>
          )}
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
        </div>

        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-[18px] text-xs text-slate-500">
          <span className="tabular-nums">{e.sub}</span>
          {e.lunchMin > 0 && <span>· lunch {e.lunchMin}m</span>}
          {e.jobCode && <Badge tone="slate">{e.jobCode}</Badge>}
          {/* ── DISCLOSURE IS THE GUARD (0168), AND IT HAS TO BE READABLE ON A PHONE ──────────
              A manual or offline punch's time did not come from the server clock. Nothing can
              prove it was made live rather than backdated, so the row says where it DID come
              from and lets the office judge.

              It used to say it in a `title` and nothing else: a hover tooltip, on a page Erik
              reads one-handed on an iPhone, where nothing hovers — and inside this row's
              pointer-events-none wrapper, so it never fired on a desktop either. The entry
              editor the row opens does not name the source anywhere. A fact with nowhere left
              to appear is a silent one. So the words are ON the row now, the title rides along
              for a desktop hover, and the whole thing is a LINK to the same editor as the rest
              of the row — taking its own pointer events without turning that strip of the row
              into a dead spot for a thumb. */}
          {e.source && (
            <Link
              href={e.href}
              scroll={false}
              title={
                e.source === "offline"
                  ? "Punched with no signal, so the time came from the phone"
                  : "Typed in by hand, not punched live"
              }
              className="pointer-events-auto flex items-center gap-1"
            >
              <Badge tone={e.source === "offline" ? "blue" : "amber"}>{e.source}</Badge>
              <span>{e.source === "offline" ? "time came from the phone" : "typed in by hand"}</span>
            </Link>
          )}
          {e.controls && (
            <span
              /* 44px, on the row. The two buttons ship at p-1 from files this page does not own,
                 so the row stretches them to a thumb instead of centring a 22px target in a 44px
                 hole. */
              className="pointer-events-auto ml-auto flex shrink-0 items-center [&>button]:inline-flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center"
            >
              {e.controls}
            </span>
          )}
        </div>

        {e.notes && <p className="pl-[18px] text-xs text-slate-500">{e.notes}</p>}

        {e.allocations && e.allocations.length > 0 && (
          <ul className="mt-0.5 space-y-1 pl-[18px]">
            {e.allocations.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                {a.jobCode && <Badge tone="blue">{a.jobCode}</Badge>}
                <span className="font-mono tabular-nums text-slate-500">{a.hours.toFixed(2)} h</span>
                {a.description && <span>· {a.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

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
  group,
  baselineById,
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
  /** How each week stacks its own shifts. NEVER the span — see the header comment. */
  group: Grouping;
  /** Per-person commute baseline (miles/day), for the By Person mileage split. */
  baselineById: Record<string, number>;
}) {
  /* FILL TO THE FOLD. On a phone a week is a short list, not a grid, and two light weeks under
     the 70dvh lid below did not overflow — so the box never scrolled, the hook (which grows only
     from scroll events) never fired, and every earlier week was unreachable until something
     happened to add height. Erik 2026-09-16, iPhone, /timecards?week=2: "Scroll doesn't work
     until I click around." The hook now prepends until the box overflows; from there a normal
     scroll takes over. */
  const stack = useEndlessStack(anchorWeek[0] ?? todayStr, 26, 8, { fillToOverflow: true });

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
    () => entries.map((e) => ({ dayStr: e.dayStr, hours: e.hours, open: e.open })),
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
    const key = [byDay, paySchedule, payAnchor, todayStr, baselineById, tz];
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
      let weekOpen = 0;
      /* BOTH STACKINGS OF THE SAME SHIFTS, built in one pass over one list. Not two lists: the
         By Person groups below are literally the rows the By Day groups hold. */
      const byPerson = new Map<string, PersonWeek>();
      for (const d of days) {
        for (const e of byDay.get(d) ?? []) {
          events.push(e);
          weekHours += e.hours; // 0 for an open shift — the rule lives on the server, once
          if (e.open) weekOpen++;
          const p =
            byPerson.get(e.personId) ??
            {
              id: e.personId,
              name: e.personName,
              hours: 0,
              open: 0,
              entries: [] as StackEntry[],
              baseline: Number(baselineById[e.personId] ?? 0),
              mileage: summarizeMileage([], 0, tz),
            };
          p.entries.push(e);
          p.hours += e.hours;
          if (e.open) p.open++;
          byPerson.set(e.personId, p);
        }
      }
      const people = [...byPerson.values()]
        .map((p) => ({
          ...p,
          hours: Math.round(p.hours * 100) / 100,
          // The commute baseline is subtracted once per DAY DRIVEN, so the split has to be taken
          // over the person's whole week at once — lib/mileage-math owns that rule, here as on
          // the page that used to draw this list.
          mileage: summarizeMileage(
            p.entries.map((e) => ({ clock_in: e.clockIn, miles: e.miles })),
            Number(baselineById[p.id] ?? 0),
            tz,
          ),
        }))
        .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

      cache.set(days[0], {
        days: days.map((ds) => ({
          dayStr: ds,
          label: labelFor(ds),
          isToday: ds === todayStr,
          heavyStart: !!mark && mark.start === ds,
        })),
        events,
        weekHours: Math.round(weekHours * 100) / 100,
        weekOpen,
        // The period line carries the number somebody is about to be PAID on, so a running shift
        // it does not count has to be named there too, not only on the week.
        periodOpen: mark ? hourRows.filter((r) => r.open && r.dayStr >= mark.start && r.dayStr < mark.end).length : 0,
        people,
        mark,
      });
    }
    return cache;
    // hourRows is memoized on the same `entries` as byDay, so it can only change when byDay does —
    // listing it adds no invalidation, it just keeps the dep list honest.
  }, [weeks, byDay, hourRows, paySchedule, payAnchor, todayStr, baselineById, tz]);

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
        const { mark, events, weekHours, weekOpen, periodOpen, people } = wd;
        const hasToday = days.includes(todayStr);

        /* ── A WEEK NOBODY HAS REACHED YET SAYS NOTHING ────────────────────────────────────
           Erik, 2026-09-18, iPhone: his screenshot has two "No hours this week. Clock-ins show
           up here." cards stacked under the current week. The stack runs eight weeks FORWARD,
           and every one of them was announcing an empty state for days that have not happened.

           That is not news. It is the worst kind of notice — one that fires on every ordinary
           day, until a man stops reading notices. So a week that has not STARTED yet and holds
           nothing is not drawn at all: no card, no header, no sentence, no pay-period line for a
           period nobody has worked.

           A future week that DOES hold something still draws in full — an entry typed ahead, a
           shift that runs past midnight into it — so nothing is ever hidden, only unsaid. And a
           week that HAS started keeps its empty line below: "nobody worked this week" is a real
           answer to a real question about a week that happened. */
        if (!hasStarted(days[0], todayStr) && events.length === 0) return null;

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
                  {hoursLine(hoursInPeriod(hourRows, mark), periodOpen)}
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
                /* flex-wrap, because the hours line can now carry "· 1 still on the clock" and a
                   375px header has no room to squash a date instead. It wraps; it never truncates
                   the week it names. */
                className={`sticky top-0 z-20 flex flex-wrap items-baseline gap-x-2 border-b px-3 py-1.5 text-xs font-semibold backdrop-blur ${
                  hasToday
                    ? "border-brand/30 bg-brand-light/70 text-brand"
                    : "border-slate-100 bg-white/90 text-slate-500"
                }`}
              >
                <span>{weekSpan(days)}</span>
                {hasToday && (
                  <span className="text-[10px] font-bold uppercase tracking-wide">this week</span>
                )}
                {/* ONE WEEK, ONE NUMBER — and when it is short a running shift, it says so here
                    instead of quietly counting hours nobody has earned yet. */}
                <span className="ml-auto font-mono tabular-nums text-slate-500">
                  {hoursLine(weekHours, weekOpen)}
                </span>
              </div>

              {/* ── THE SHAPE ON TOP, THE LEDGER UNDER IT ──────────────────────────────────
                  THE GRID IS A DESKTOP INSTRUMENT. Erik: "timecard scroll on my phone froze up
                  and doesnt show me the calendar so we may need a better layout for small
                  devices." On a 375px screen each week is seven columns scrolling SIDEWAYS inside
                  a stack scrolling DOWN — nested opposing scrollers that iOS handles badly, for a
                  grid where each column is 50px of unreadable slivers anyway. So the grid is
                  sm: and up, and only in By Day: a person's week is not a shape you read in time
                  blocks, it is a run of shifts and one subtotal.

                  IT IS AN ADDITION, NEVER A REPLACEMENT. The grid was briefly the ONLY thing a
                  desktop got in By Day, the list hidden under it at sm:. But a pill is id, day,
                  start, end, label, sub, color, href (TimeGridEvent) and nothing else — so the
                  manual and offline disclosures, the notes, lunch, the code badge, the split
                  lines, duplicate, the pencil and the empty state all vanished at 640px, on the
                  DEFAULT grouping. That is 0168 broken (a punch that cannot say where its time
                  came from) and a dead end (no way to duplicate a shift, and a week with no
                  hours saying nothing at all).

                  They are not two lists either — the Erik complaint this wave exists to answer.
                  The grid answers "what shape was the week", the list answers "what happened and
                  is it right", and both are rendered from the SAME `events`, so they cannot
                  disagree the way the two ledgers did. */}
              {group === "day" && (
                <div className="hidden border-b border-slate-100 sm:block">
                  <TimeGrid
                    days={wd.days}
                    events={events}
                    workStartMin={workStartMin}
                    workEndMin={workEndMin}
                    tz={tz}
                    initialNow={{ dayStr: todayStr, min: nowMin }}
                  />
                </div>
              )}

              <div>
                {group === "day"
                  ? days
                      .filter((ds) => (byDay.get(ds) ?? []).length > 0)
                      .map((ds) => (
                        <div key={ds} className="border-b border-slate-100 last:border-b-0">
                          <div className={`flex flex-wrap items-baseline justify-between gap-x-2 px-3 pt-2 text-xs font-semibold ${ds === todayStr ? "text-brand" : "text-slate-500"}`}>
                            <span>
                              {labelFor(ds)}
                              {!!mark && mark.start === ds && (
                                <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-brand">new pay period</span>
                              )}
                            </span>
                            <span className="font-mono tabular-nums text-slate-400">
                              {hoursLine(
                                Math.round((byDay.get(ds) ?? []).reduce((t, e) => t + e.hours, 0) * 100) / 100,
                                (byDay.get(ds) ?? []).filter((e) => e.open).length,
                              )}
                            </span>
                          </div>
                          <ul>
                            {(byDay.get(ds) ?? []).map((e) => (
                              // The person leads the row when the days are the spine.
                              <ShiftRow key={e.id} e={e} lead={e.person} />
                            ))}
                          </ul>
                        </div>
                      ))
                  : people.map((p) => (
                      <div key={p.id} className="border-b border-slate-100 last:border-b-0">
                        {/* The person header the per-person Card used to carry: initials, the
                            name, their hours for THIS week, and their miles with the commute
                            split still visible. */}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-600">
                            {initials(p.name)}
                          </span>
                          <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{p.name}</span>
                          <span className="ml-auto flex flex-wrap items-baseline justify-end gap-x-2">
                            <span className="font-mono text-xs tabular-nums text-slate-500">
                              {hoursLine(p.hours, p.open)}
                            </span>
                            {p.mileage.recorded > 0 && (
                              <span className="text-xs text-slate-400">{mileageLine(p)}</span>
                            )}
                          </span>
                        </div>
                        <ul>
                          {p.entries.map((e) => (
                            // The day leads the row when the people are the spine.
                            <ShiftRow key={e.id} e={e} lead={labelFor(e.dayStr)} />
                          ))}
                        </ul>
                      </div>
                    ))}
                {/* THE one empty state for a week with no hours — the page's second one (an
                    EmptyState under the per-person cards, saying the same thing in other words)
                    went with the cards. Only weeks that have already STARTED ever get this far
                    (see the guard above), so it is always about a week that actually happened. */}
                {events.length === 0 && (
                  <p className="px-3 py-4 text-center text-xs text-slate-400">
                    No hours this week. Clock-ins show up here.
                  </p>
                )}
              </div>

            </Card>
          </div>
        );
      })}
      {/* NOTHING SILENT: say where the scroll stops rather than just refusing to grow. */}
      {stack.atBackCap && (
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

/** Has this week begun? Day-strings are ORG-local and zero-padded (lib/tz builds them), so the
 *  string compare IS the date compare — no Date object, and no timezone left to get wrong. */
const hasStarted = (weekStart: string, todayStr: string): boolean => weekStart <= todayStr;

const labelFor = (ds: string): string => {
  const d = parseLocal(ds);
  return d ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : ds;
};

/** Local, never `new Date(ymd)` — UTC midnight reads as yesterday west of Greenwich. */
function parseLocal(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
