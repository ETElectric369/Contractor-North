import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * THE WEEK STACK, cn-v1151: THE BOX SAYS MORE, AND THE DAY LINE LOCKS.
 *
 * Erik, reconciling timecards: "more information on the timecard entry box on the calendar screen, perhaps
 * even just the total hours", and "inside the scroll calendar box it would be super helpful to have the
 * Monday through Friday header lock on screen as I scroll down the week".
 *
 * Rendered, not read: the stack is mounted with a week of shifts and the markup is checked for the pill's
 * lines (the span, the hours with the lunch, Paid / On the Clock / No Job / Offline Punch, the note) and for
 * the grid's day strip being sticky under the week line. What a static render cannot show — the two refs
 * and the hook that measures the line — is pinned in the source: the line is the one measured, the host
 * is an ancestor of the grid, and the hook is called once per week in WeekCard.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { TimecardStack, type StackEntry } from "./timecard-stack";
import { entryInfo } from "./entry-info";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const TZ = "America/Los_Angeles";
/** The week of Mon Sep 21, 2026; Wednesday is today, 11:40 AM. */
const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
const TODAY = "2026-09-23";
const NOW_MIN = 700;
const CRUMB = '[This punch took the job off hold. Before: {"status":"on_hold"} #0123456789abcdef]';

/** A shift as the page hands it to the stack — the row's facts, and the box built from them the way toStackEntry does. */
const shift = (over: Partial<StackEntry> & { paidAt?: string | null }): StackEntry => {
  const base: StackEntry = {
    id: "e1",
    personId: "sam-1",
    personName: "Sam Tillery",
    person: "Sam",
    dayStr: "2026-09-22",
    clockIn: "2026-09-22T20:00:00Z",
    startMin: 780,
    endMin: 930,
    hours: 2,
    open: false,
    miles: 0,
    label: "Sam · 41 Larkspur",
    sub: "1:00 PM–3:30 PM",
    color: "border-sky-300 bg-sky-100 text-sky-900",
    dot: "bg-sky-500",
    href: "/timecards?week=0&entry=e1",
    job: { href: "/jobs/j28", label: "41 Larkspur" },
    jobCode: null,
    source: null,
    lunchMin: 30,
    notes: null,
  };
  const { paidAt = null, ...rest } = over;
  const e = { ...base, ...rest };
  return { ...e, info: entryInfo({ sub: e.sub, open: e.open, hours: e.hours, lunchMin: e.lunchMin, paidAt, noJob: !!e.noJob, source: e.source, notes: e.notes }) };
};

const week = [
  // Tuesday: closed, paid, a half hour of lunch off, a note with the clock's crumb in it.
  shift({ paidAt: "2026-09-26T20:00:00Z", notes: `Pulled the old panel. ${CRUMB}` }),
  // Wednesday (today): Dana still on the clock since 8:00 AM.
  shift({ id: "e2", personId: "dana-1", personName: "Dana Rook", person: "Dana", dayStr: TODAY, clockIn: "2026-09-23T15:00:00Z", startMin: 480, endMin: null, hours: 0, open: true, sub: "8:00 AM–now", label: "Dana · 41 Larkspur", lunchMin: 0, color: "border-violet-300 bg-violet-100 text-violet-900", dot: "bg-violet-500", href: "/timecards?week=0&entry=e2" }),
  // Monday: Theo's hours on no job, punched with no signal.
  shift({ id: "e3", personId: "theo-1", personName: "Theo Vance", person: "Theo", dayStr: "2026-09-21", clockIn: "2026-09-21T14:00:00Z", startMin: 420, endMin: 900, hours: 8, label: "Theo", job: null, noJob: true, source: "offline", lunchMin: 0, color: "border-emerald-300 bg-emerald-100 text-emerald-900", dot: "bg-emerald-500", href: "/timecards?week=0&entry=e3" }),
];

const render = (entries: StackEntry[], group: "day" | "person" = "day") =>
  renderToStaticMarkup(
    createElement(TimecardStack, {
      entries,
      anchorWeek: WEEK,
      todayStr: TODAY,
      workStartMin: 480,
      workEndMin: 960,
      tz: TZ,
      nowMin: NOW_MIN,
      paySchedule: "weekly",
      payAnchor: "2026-09-21",
      group,
      baselineById: {},
    }),
  );

describe("the box on the grid says what the row under it says", () => {
  const html = render(week);

  it("a closed, paid shift's pill: the span where the sub was, the hours with the lunch, Paid in green, the note sans the crumb", () => {
    expect(html).toContain('<div class="truncate font-semibold">Sam · 41 Larkspur</div>');
    expect(html).toContain('<div class="truncate tabular-nums opacity-70">1:00 PM–3:30 PM</div>');
    expect(html).toContain('<div class="truncate tabular-nums">2.00 h · 30 min lunch</div>');
    expect(html).toContain('<div class="truncate font-semibold text-emerald-700">Paid</div>');
    expect(html).toContain(">Pulled the old panel.</div>");
    expect(html).not.toContain("took the job off hold");
    // The whole of it in the pill's title, so a short block still says it all.
    expect(html).toContain('title="Sam · 41 Larkspur · 1:00 PM–3:30 PM · 2.00 h · 30 min lunch · Paid · Pulled the old panel."');
  });

  it("a running shift's pill says On the Clock in amber and draws no hours line; a no-job offline punch says both", () => {
    expect(html).toContain('<div class="truncate tabular-nums opacity-70">8:00 AM–now</div>');
    expect(html).toContain('<div class="truncate font-semibold text-amber-700">On the Clock</div>');
    expect(html).not.toMatch(/<div class="truncate tabular-nums">0\.00 h/);
    expect(html).toContain('<div class="truncate font-semibold text-amber-700">No Job · Offline Punch</div>');
    expect(html).toContain('<div class="truncate tabular-nums">8.00 h</div>');
  });

  it("the rows under the grid still carry the same facts in their own words, so the two cannot disagree", () => {
    expect(html).toContain("· lunch 30m");
    expect(html).toContain(">Pulled the old panel.</p>");
    expect(html).toContain(">on the clock</span>");
    expect(html).toMatch(/>No Job</);
    expect(html).toMatch(/>Offline</);
    expect(html).toContain("Time Came from the Phone");
    // The week line's one number counts the closed shifts and names the running one.
    expect(html).toContain("10.00 h · 1 still on the clock");
  });

  it("By Person draws no grid and no box, only the rows — the gate is as it was", () => {
    const byPerson = render(week, "person");
    expect(byPerson).not.toContain("time-grid-columns");
    expect(byPerson).not.toContain("--grid-stick-top");
    expect(byPerson).toContain("Sam Tillery");
    expect(byPerson).toContain("· lunch 30m");
  });
});

describe("the Mon–Sun line locks under the week line while the week scrolls", () => {
  it("the grid is rendered with stickyHeader: its day strip is sticky at the measured top, inside the card, after the week line", () => {
    const html = render(week);
    const strip = '<div class="overflow-x-hidden bg-white sticky z-[15]" style="top:var(--grid-stick-top, 0px)">';
    expect(html).toContain(strip);
    const card = html.indexOf('class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-clip"');
    const line = html.indexOf('class="sticky top-0 z-20 flex flex-wrap items-baseline');
    const stripAt = html.indexOf(strip);
    expect(card).toBeGreaterThan(0);
    expect(line).toBeGreaterThan(card);
    expect(stripAt).toBeGreaterThan(line);
    // The strip IS the day-header row: seven day cells, today's in bold brand, under the line's week name.
    // (labelFor writes the day with toLocaleDateString, so "Tue 22" here and "22 Tue" on another runtime: either.)
    const strip_ = html.slice(stripAt, html.indexOf('<div class="overflow-x-auto"', stripAt));
    expect(strip_.match(/min-w-0 flex-1 truncate px-1 py-1\.5 text-center text-xs font-medium text-slate-600/g)).toHaveLength(7);
    expect(strip_.match(/font-bold text-brand/g)).toHaveLength(1);
    expect(strip_).toMatch(/>(?:Tue 22|22 Tue)</);
    // The grid is still sm: and up — the phone keeps its list.
    expect(html).toContain('<div class="hidden border-b border-slate-100 sm:block">');
  });

  it("WeekCard measures its week line and writes the height on its own outer div, an ancestor of the grid, once per week", () => {
    const stack = src("./timecard-stack.tsx");
    expect(stack).toContain('import { useStickyOffset } from "@/components/use-sticky-offset";');
    const card = stack.slice(stack.indexOf("function WeekCard("), stack.indexOf("const weekSpan = "));
    expect(card).toContain("const hostRef = useRef<HTMLDivElement>(null);");
    expect(card).toContain("const lineRef = useRef<HTMLDivElement>(null);");
    expect(card).toContain("useStickyOffset(lineRef, hostRef);");
    // The host: the card's outer div, the first element it returns (Card forwards no ref; the variable inherits).
    expect(card).toMatch(/return \(\s*<div ref=\{hostRef\}>/);
    // The line: the sticky week header, the one element with ref={lineRef}.
    expect(card).toMatch(/<div\s+ref=\{lineRef\}\s+\/\*[\s\S]*?\*\/\s+className=\{`sticky top-0 z-20 /);
    expect(card.match(/ref=\{lineRef\}/g)).toHaveLength(1);
    expect(card.match(/ref=\{hostRef\}/g)).toHaveLength(1);
    // The grid inside it asks for the sticky strip, and the By Day sm: gate still wraps it.
    expect(card).toMatch(/\{group === "day" && \(\s*<div className="hidden border-b border-slate-100 sm:block">\s*<TimeGrid[\s\S]*?stickyHeader\s*\/>/);
    // One card per week: the map hands each week to it under the not-started guard.
    expect(stack).toContain("if (!hasStarted(days[0], todayStr) && wd.events.length === 0) return null;");
    expect(stack).toMatch(/<WeekCard\s+key=\{days\[0\]\}/);
  });
});
