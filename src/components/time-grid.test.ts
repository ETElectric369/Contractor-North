import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE SHARED TIME GRID, after Wave 2's schedule lane (SV-chips, SV-actual, SV-ghost). Everything new is
 * optional and additive: /timecards passes none of it and renders exactly as before; on the schedule a
 * block's crew draws INSIDE it as marks (never a second button), a past block's worked time draws as a
 * sibling layer of bars that never catches a tap, and the block's tap stays the one door.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { TimeGrid, hollowTone, type TimeGridEvent, type TimeGridInfo } from "./time-grid";
import { pillColorForPerson } from "@/lib/employee-color";

const LA = "America/Los_Angeles";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const grid = (p: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(TimeGrid, {
      days: [{ dayStr: "2026-09-22", label: "Tue 22" }],
      events: [],
      workStartMin: 540,
      workEndMin: 1020,
      tz: LA,
      ...p,
    } as Parameters<typeof TimeGrid>[0]),
  );

describe("/timecards renders exactly as it did", () => {
  it("timecards-shaped props (no info, no crew, no worked time) render byte-for-byte what main's grid rendered", () => {
    // The props /timecards passes: person-colored pills with a sub line, an open entry, a heavy pay-
    // period edge, an all-day row.
    //
    // THE HASH HAS MOVED THREE TIMES, AND HERE IS THE WHOLE OF WHAT MOVED EACH TIME. The first two were
    // the same ONE line, the wrapper div, which was the only byte of this rendering the turn ever touched:
    //     main (cn-v1030)  <div style="min-width:324px">
    //     then             <div class="time-grid-columns" style="--grid-natural-w:324px">
    //     then             <div class="time-grid-columns" style="--grid-natural-w:324px;--grid-legal-w:183px">
    // FIRST, because the turned phone needed the week to FIT instead of scrolling sideways, so the columns'
    // minimum had to be capped by a stylesheet — and a stylesheet cannot override an inline width without
    // `!important`. SECOND, because that cap had no floor and squeezed the day's own drill-in button under
    // 44px, so the grid now also hands over the narrowest width its tap targets can live in. globals.css
    // applies them (identically, upright: the floor is only read inside a turned face). 324 is 48 + 3 x 92;
    // 183 is 48 + 3 x (1 + 44) for a header with no `+` beside the day, which is what /timecards draws.
    // THIRD (cn-v1151), because the Mon–Sun line has to lock on screen while the week scrolls under it, and
    // a sticky element inside an `overflow-x: auto` box can only ever stick to THAT box: the day-header
    // row became a SIBLING of the horizontal scroller instead of its first child, in its own clipped strip
    // that the scroller's onScroll keeps in step. Six wrapper lines moved and nothing else:
    //     was   <div class="overflow-x-auto"><div class="time-grid-columns" style="…">{header}{tray}{rows}</div></div>
    //     now   <div><div class="overflow-x-hidden bg-white"><div class="time-grid-columns" style="…">{header}</div></div>
    //                <div class="overflow-x-auto"><div class="time-grid-columns" style="…">{tray}{rows}</div></div></div>
    // The strip is NOT sticky here — this rendering passes no `stickyHeader` (the shape alone is under
    // test; /timecards and the schedule pass it from cn-v1151 on, tested in their own files) — so it
    // wears the plain class and no `top`. The two renderings were diffed line by line all three times, and every other
    // byte — every pill, every tick, every row — is the same (the third time: 171 lines against 165, the
    // six wrappers above and not one more). Anything ELSE that moves this hash is a change to /timecards
    // and has to be looked at.
    const html = renderToStaticMarkup(
      createElement(TimeGrid, {
        days: [
          { dayStr: "2026-09-21", label: "Mon 21", heavyStart: true },
          { dayStr: "2026-09-22", label: "Tue 22" },
          { dayStr: "2026-09-23", label: "Wed 23", isToday: true },
        ],
        events: [
          { id: "e1", dayStr: "2026-09-21", startMin: 480, endMin: 960, label: "Erik Taylor", sub: "12 Elm St", color: "border-blue-300 bg-blue-100 text-blue-900", href: "/timecards?e=1" },
          { id: "e2", dayStr: "2026-09-22", startMin: 420, endMin: 1290, label: "Brian Cole", sub: "Shop", color: "border-emerald-300 bg-emerald-100 text-emerald-900" },
          { id: "e3", dayStr: "2026-09-22", startMin: 600, endMin: 720, label: "Jimmy Ruiz", color: "border-violet-300 bg-violet-100 text-violet-900", href: "/timecards?e=3" },
          { id: "e4", dayStr: "2026-09-23", startMin: 510, endMin: null, label: "Erik Taylor", sub: "open", color: "border-blue-300 bg-blue-100 text-blue-900" },
        ],
        allDay: [{ id: "a1", dayStr: "2026-09-21", label: "Holiday", color: "border-slate-300 bg-slate-100 text-slate-700" }],
        workStartMin: 480,
        workEndMin: 960,
        tz: LA,
        initialNow: { dayStr: "2026-09-23", min: 700 },
        onDayClick: () => {},
      }),
    );
    expect(createHash("sha256").update(html).digest("hex")).toBe("29c746c75a0b96b61aa3a750df56bcdef7b3a0fc922fa8ea2cd6803932812fa3");
    expect(html).not.toContain("data-worked-bars");
    // The wrapper line that moved twice, pinned on its own so the hash is not the only thing saying what
    // it is — and since the third move it is drawn twice, once over the strip and once over the body.
    expect(html.match(/<div class="time-grid-columns" style="--grid-natural-w:324px;--grid-legal-w:183px">/g)).toHaveLength(2);
    expect(html).not.toContain("min-width:");
    // The six wrappers of the third move, and the strip plain (not sticky) because this render did not ask.
    expect(html.startsWith('<div><div class="overflow-x-hidden bg-white"><div class="time-grid-columns"')).toBe(true);
    expect(html).toContain('</div></div></div><div class="overflow-x-auto"><div class="time-grid-columns"');
    expect(html).not.toContain("sticky");
  });
});

const block = (over: Partial<TimeGridEvent> = {}): TimeGridEvent => ({
  id: "j-1-2026-09-22",
  dayStr: "2026-09-22",
  startMin: 540,
  endMin: 1020,
  label: "12 Elm St",
  info: { place: "Rita Moss", time: "9a–5p", crew: [{ id: "p-erik", initials: "ET", name: "Erik Taylor" }, { id: "p-brian", initials: "BC", name: "Brian Cole" }] },
  color: "border-slate-300 bg-slate-200/80 text-slate-800",
  href: "/jobs/1",
  ...over,
});

describe("the crew, drawn inside the block as marks", () => {
  it("the chips sit inside the pill, in each person's color, pointer-events-none, and no extra button", () => {
    const html = grid({ events: [block()] });
    const open = html.search(/<a [^>]*href="\/jobs\/1"/);
    expect(open).toBeGreaterThan(-1);
    const pill = html.slice(open, html.indexOf("</a>", open));
    expect(pill).toContain('class="pointer-events-none mt-0.5 flex h-3.5 items-center overflow-hidden"');
    expect(pill).toContain(pillColorForPerson("p-erik").dot);
    expect(pill).toContain(pillColorForPerson("p-brian").dot);
    expect(pill).not.toContain("<button");
    expect(html.match(/<button/g)).toBeNull();
  });

  it("a pill too short for the chips still says who in its title: 'Crew: …', or 'Nobody on it'", () => {
    const short = grid({ events: [block({ endMin: 570 })] });
    expect(short).toContain("Crew: Erik Taylor, Brian Cole");
    expect(short).not.toContain("h-3.5 items-center overflow-hidden");
    expect(grid({ events: [block({ endMin: 570, info: { crew: [] } })] })).toContain("Nobody on it");
  });

  it("two pills side by side in a week show two chips and '+N'", () => {
    const crew = ["a", "b", "c"].map((id) => ({ id, initials: id.toUpperCase(), name: `Person ${id}` }));
    const html = grid({
      days: ["2026-09-21", "2026-09-22"].map((d) => ({ dayStr: d, label: d })),
      events: [block({ info: { crew } }), block({ id: "j-2-2026-09-22", href: "/jobs/2", info: { crew } })],
    });
    expect(html.match(/h-3\.5 w-3\.5/g)).toHaveLength(4);
    expect(html.match(/>\+1</g)).toHaveLength(2);
  });

  it("the office's pill with a tapId is still the one button (the tile's sheet)", () => {
    const html = grid({ events: [block({ tapId: "job:1" })], onEventTap: () => {} });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-label="12 Elm St · Rita Moss · 9a–5p · Crew: Erik Taylor, Brian Cole: day, time and crew"/);
  });
});

describe("what happened, on a past block", () => {
  const worked = block({
    info: { place: "Rita Moss", time: "9a–5p", crew: null },
    actual: {
      people: [
        { key: "p-erik", initials: "ET", dot: "bg-blue-500", spans: [{ startMin: 660, endMin: 1260, open: false }] },
        { key: "p-jimmy", initials: "JR", dot: "bg-violet-500", spans: [{ startMin: 720, endMin: 1020, open: true }] },
      ],
      sentence: "Booked 9–5 · Erik 11–9 · Jimmy in at 12, never clocked out · 2h late",
    },
    tapId: "job:1",
  });

  it("the bars are a sibling layer beside the block (it clips its own contents), never catching a tap", () => {
    const html = grid({ events: [worked], onEventTap: () => {} });
    const layer = (html.match(/<div aria-hidden="true" data-worked-bars="j-1-2026-09-22" class="pointer-events-none absolute z-\[5\]"[^>]*>/) ?? [""])[0];
    expect(layer).toBeTruthy();
    // It is not inside the pill: the pill's button closes before it opens.
    expect(html.indexOf("data-worked-bars")).toBeGreaterThan(html.indexOf("</button>"));
    // One lane per person at the right edge, 4px wide, the next one 5px to its left; one never clocked out fades.
    expect(html).toMatch(/class="absolute rounded-full bg-blue-500" style="top:[\d.]+px;height:[\d.]+px;right:2px;width:4px"/);
    expect(html).toMatch(/class="absolute rounded-full bg-violet-500" style="top:[\d.]+px;height:[\d.]+px;right:7px;width:4px;mask-image:linear-gradient/);
    // The words stay clear of the bars.
    expect(html).toContain("padding-right:13px");
  });

  it("a punch still running today is solid and grows to the live now line (today, 2026-10-26)", () => {
    const running = block({
      actual: {
        people: [{ key: "p-jimmy", initials: "JR", dot: "bg-violet-500", spans: [{ startMin: 720, endMin: 780, open: true, running: true }] }],
        sentence: "Booked 9–5 · Jimmy on the clock since 12",
      },
    });
    // Judged at 1 PM, drawn at 3 PM: the bar runs 12 to 3 (180 min of 0.8px), no fade.
    const html = grid({ events: [running], initialNow: { dayStr: "2026-09-22", min: 900 } });
    expect(html).toMatch(/class="absolute rounded-full bg-violet-500" style="top:[\d.]+px;height:144px;right:2px;width:4px"/);
    expect(html).not.toContain("mask-image");
    // On another day's grid the same span keeps its own end.
    const elsewhere = grid({ events: [running], initialNow: { dayStr: "2026-09-23", min: 900 } });
    expect(elsewhere).toMatch(/class="absolute rounded-full bg-violet-500" style="top:[\d.]+px;height:48px;right:2px;width:4px"/);
  });

  it("the range stretches to the 9 PM finish instead of clipping it at 7", () => {
    const html = grid({ events: [worked] });
    expect(html).toContain(">8 PM<");
    expect(html).not.toContain(">9 PM<");
    // 7 AM (9 − 2) to 9 PM: 14 hours of 48px.
    expect(html).toContain("height:672px");
  });

  it("a wide block puts each person's initials at the top of their bar; a squeezed one shows bars alone", () => {
    expect(grid({ events: [worked] })).toMatch(/<span class="absolute flex h-4 w-4[^"]*bg-blue-500"[^>]*>ET<\/span>/);
    const squeezed = grid({
      days: ["2026-09-21", "2026-09-22"].map((d) => ({ dayStr: d, label: d })),
      events: [worked, block({ id: "j-2-2026-09-22", href: "/jobs/2" })],
    });
    expect(squeezed).not.toMatch(/h-4 w-4[^"]*bg-blue-500/);
    expect(squeezed).toContain("data-worked-bars");
  });

  it("the sentence closes the block's title and label", () => {
    const html = grid({ events: [worked], onEventTap: () => {} });
    expect(html).toContain("Booked 9–5 · Erik 11–9 · Jimmy in at 12, never clocked out · 2h late: day, time and crew");
  });

  it("hollow keeps the border and type color, a faint fill and muted words; never dashed", () => {
    expect(hollowTone("border-slate-300 bg-slate-200/80 text-slate-800")).toBe("border-slate-300 bg-white/40 text-slate-500");
    expect(hollowTone("border-amber-300 bg-amber-100 text-amber-900 border-dashed opacity-75")).toBe("border-amber-300 border-dashed opacity-75 bg-white/40 text-slate-500");
    const html = grid({ events: [block({ actual: { people: [], hollow: true, sentence: "Booked 9–5 · No time clocked to this job" } })] });
    expect(html).toContain("border-slate-300 bg-white/40 text-slate-500");
    expect(html).not.toContain("bg-slate-200/80");
    expect(html).toContain("Booked 9–5 · No time clocked to this job");
    expect(html).not.toContain("data-worked-bars");
  });

  it("a ghost says '<job name> · worked, not booked', its bars inside it, and its tap is its one button", () => {
    const ghost = block({
      id: "g-j11-2026-09-22",
      label: "22 Honeysuckle Way",
      sub: "Kim Hale",
      info: undefined,
      ghost: true,
      color: "border-2 border-dashed border-slate-400 bg-white/60 text-slate-700",
      tapId: "ghost:j11",
      actual: { people: [{ key: "p-brian", initials: "BC", dot: "bg-rose-500", spans: [{ startMin: 664, endMin: 826, open: false }] }], sentence: "Brian 11:04 AM–1:46 PM" },
    });
    const html = grid({ events: [ghost], onEventTap: () => {} });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-label="22 Honeysuckle Way · worked, not booked · Brian 11:04 AM–1:46 PM"/);
    expect(html).toContain("border-2 border-dashed border-slate-400 bg-white/60 text-slate-700");
    expect(html).toContain('data-worked-bars="g-j11-2026-09-22"');
    expect(text(html)).toContain("Kim Hale");
  });

  it("armed, the block with bars still places (the whole column does; the bars never catch the tap)", () => {
    const html = grid({ events: [worked], placement: { label: "Put it here", onPlace: () => {} } });
    expect(html).toMatch(/<button type="button" style="top:[^"]*" title="Put it here — Tue 22"/);
    expect(html).toContain("data-worked-bars");
  });
});

/**
 * THE DAY HEADER LOCKS (cn-v1151; Erik: the Mon–Sun line must stay on screen while he scrolls down the
 * week). A sticky element sticks to its nearest scroll container, and the grid's horizontal scroller is
 * one — so the header row left it and became a sibling strip that the scroller keeps in step sideways.
 * Opt-in: the schedule's day view scrolls with the page and never asks.
 */
describe("the day header locks (cn-v1151)", () => {
  const week = ["2026-09-21", "2026-09-22", "2026-09-23"].map((d) => ({ dayStr: d, label: `D ${d.slice(-2)}` }));
  const STRIP = '<div class="overflow-x-hidden bg-white';

  it("with stickyHeader the strip is sticky, clipped sideways, and sits at the caller's measured top", () => {
    const html = grid({ days: week, stickyHeader: true });
    expect(html).toContain('<div class="overflow-x-hidden bg-white sticky z-[15]" style="top:var(--grid-stick-top, 0px)">');
    // A SIBLING of the horizontal scroller, never inside it: the strip closes before the scroller opens,
    // the day headers are in the strip and the hour rows in the scroller.
    const strip = html.indexOf(STRIP);
    const scroller = html.indexOf('<div class="overflow-x-auto">');
    expect(strip).toBeGreaterThan(-1);
    expect(scroller).toBeGreaterThan(strip);
    expect(html.indexOf("D 21")).toBeLessThan(scroller);
    expect(html.indexOf("D 23")).toBeLessThan(scroller);
    expect(html.indexOf(">8 AM<")).toBeGreaterThan(scroller);
    expect(html.indexOf("</div></div></div>", strip)).toBeLessThan(scroller);
  });

  it("without it the strip is a plain box: nothing sticks, no top", () => {
    const html = grid({ days: week });
    expect(html).toContain(`${STRIP}">`);
    expect(html).not.toContain("sticky");
    expect(html).not.toContain("--grid-stick-top");
  });

  it("the strip and the body both carry time-grid-columns with the same two widths, so the day lines sit over their columns", () => {
    // Three days with a `+` beside each day: 324 wanted (48 + 3 x 92), 315 the floor (48 + 3 x (1 + 44 + 44)).
    const html = grid({ days: week, stickyHeader: true, onSlotTap: () => {} });
    const wrappers = html.match(/<div class="time-grid-columns" style="[^"]*">/g) ?? [];
    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]).toBe(wrappers[1]);
    expect(wrappers[0]).toBe('<div class="time-grid-columns" style="--grid-natural-w:324px;--grid-legal-w:315px">');
    // And the same with one day, where no minimum is asked for.
    const day = grid({ stickyHeader: true }).match(/<div class="time-grid-columns" style="[^"]*">/g) ?? [];
    expect(day).toEqual(Array(2).fill('<div class="time-grid-columns" style="--grid-natural-w:0px;--grid-legal-w:0px">'));
  });

  it("the strip draws above everything in the scroller (the bars z-[5], the now line z-10) and under the week line (z-20)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/time-grid.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const zs = [...src.matchAll(/\bz-\[?(\d+)\]?/g)].map((m) => Number(m[1]));
    expect(zs).toContain(5);
    expect(zs).toContain(10);
    expect(Math.max(...zs)).toBe(15);
    expect(src).toContain('" sticky z-[15]"');
    // The scroll-today effect carries the strip along in the same frame, and the body's scroll keeps it there.
    expect(src).toContain("if (headRef.current) headRef.current.scrollLeft = box.scrollLeft;");
    expect(src).toMatch(/onScroll=\{\(e\) => \{\s*const h = headRef\.current;\s*if \(h\) h\.scrollLeft = e\.currentTarget\.scrollLeft;/);
  });

  it("the sync is two-way (skeptic #55): focus inside the strip can scroll the strip alone, so its scroll is copied to the body when they differ — an equal write fires no event, so the pair never loops", () => {
    const src = readFileSync(join(process.cwd(), "src/components/time-grid.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(src).toMatch(
      /onScroll=\{\(e\) => \{\s*const b = scrollRef\.current;\s*if \(b && b\.scrollLeft !== e\.currentTarget\.scrollLeft\) b\.scrollLeft = e\.currentTarget\.scrollLeft;\s*\}\}/,
    );
    // The strip's handler sits on the strip itself (the overflow-x-hidden box), before the body's.
    const strip = src.indexOf("ref={headRef}");
    const body = src.indexOf("ref={scrollRef}");
    const twoWay = src.indexOf("const b = scrollRef.current;");
    expect(strip).toBeGreaterThan(-1);
    expect(twoWay).toBeGreaterThan(strip);
    expect(twoWay).toBeLessThan(body);
    // And the markup is unchanged: a handler is not an attribute, so /timecards still renders byte for byte.
    expect(grid({ days: week })).not.toContain("onScroll");
  });
});

/**
 * THE BOX SAYS MORE (cn-v1151; Erik: "each box on the grid must be able to say more inside it"): the
 * hours, the state and the person's own note, in blockRows' order and only in whole lines. The words
 * ride in on the event; the grid draws them and never invents one.
 */
describe("the box says more (cn-v1151): the hours, the state, the note, in whole lines", () => {
  const NOTE = "Waited on the inspector.\nLeft the panel open.";
  const CLAMP = '<div class="overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] whitespace-pre-wrap break-words opacity-80" style="-webkit-line-clamp:';
  // A shift as /timecards will feed it: no place, no crew, no town.
  const shift = (minutes: number, info: Partial<TimeGridInfo> = {}): TimeGridEvent => ({
    id: "s-1",
    dayStr: "2026-09-22",
    startMin: 540,
    endMin: 540 + minutes,
    label: "Sam Tillery",
    color: "border-blue-300 bg-blue-100 text-blue-900",
    href: "/timecards?e=1",
    info: { time: "9a–11a", hours: "2.00 h", state: { text: "On Hold", tone: "warn" }, note: NOTE, ...info },
  });

  it("two hours (96px): the time, the hours in tabular-nums, the state in its tone, then three whole lines of the note", () => {
    const html = grid({ events: [shift(120)] });
    const hours = '<div class="truncate tabular-nums">2.00 h</div>';
    const state = '<div class="truncate font-semibold text-amber-700">On Hold</div>';
    const note = `${CLAMP}3">${NOTE}</div>`;
    expect(html).toContain(hours);
    expect(html).toContain(state);
    expect(html).toContain(note);
    // In blockRows' order: the name, the time, the hours, the state, the note (the title says them first,
    // so each is looked for as its own line in the body).
    const at = (s: string) => html.indexOf(s);
    const time = '<div class="truncate tabular-nums opacity-70">9a–11a</div>';
    expect(at('<div class="truncate font-semibold">Sam Tillery</div>')).toBeLessThan(at(time));
    expect(at(time)).toBeLessThan(at(hours));
    expect(at(hours)).toBeLessThan(at(state));
    expect(at(state)).toBeLessThan(at(note));
  });

  it("the tones: good is emerald, warn amber, plain the pill's own color a shade lighter", () => {
    expect(grid({ events: [shift(120, { state: { text: "Done", tone: "good" } })] })).toContain('<div class="truncate font-semibold text-emerald-700">Done</div>');
    expect(grid({ events: [shift(120, { state: { text: "Scheduled", tone: "plain" } })] })).toContain('<div class="truncate font-semibold opacity-80">Scheduled</div>');
  });

  it("the note takes the lines that are left: one on a 2.5h schedule block under its town, six at most on a day-long one", () => {
    const booked = (minutes: number) =>
      block({
        endMin: 540 + minutes,
        info: { place: "Rita Moss", time: "9a–5p", crew: [], hours: "7.5 h", state: { text: "On Hold", tone: "warn" }, town: "Larkspur", note: NOTE },
      });
    const half = grid({ events: [booked(150)] });
    expect(half).toContain(">Larkspur<");
    expect(half).toContain(`${CLAMP}1">`);
    const long = grid({ events: [booked(480)] });
    expect(long).toContain(`${CLAMP}6">`);
    // Nothing between the town and the note in the body; the note is last.
    expect(long.indexOf(">Larkspur<")).toBeLessThan(long.indexOf(CLAMP));
  });

  it("an hour (48px) drops the note and the state whole — the name, the time and the hours — and the title still says them, the note last", () => {
    const html = grid({ events: [shift(60)] });
    expect(html).toContain('<div class="truncate tabular-nums">2.00 h</div>');
    expect(html).not.toContain("text-amber-700");
    expect(html).not.toContain("-webkit-line-clamp");
    expect(html).toContain(`title="Sam Tillery · 9a–11a · 2.00 h · On Hold · ${NOTE}"`);
    // A half hour is the name alone, and still the whole title.
    const half = grid({ events: [shift(30)] });
    expect(half).not.toContain("2.00 h</div>");
    expect(half).toContain(`title="Sam Tillery · 9a–11a · 2.00 h · On Hold · ${NOTE}"`);
  });

  it("a blank note is no note: no line in the box, nothing in the title; a note with no room for a line is not drawn", () => {
    const blank = grid({ events: [shift(120, { note: "   " })] });
    expect(blank).not.toContain("-webkit-line-clamp");
    expect(blank).toContain('title="Sam Tillery · 9a–11a · 2.00 h · On Hold"');
    const none = grid({ events: [shift(120, { note: null, state: null, hours: null })] });
    expect(none).toContain('title="Sam Tillery · 9a–11a"');
    expect(none).not.toContain("tabular-nums\">");
  });

  it("the sentence of a past block still closes what was booked; the hours, the state and the note follow it", () => {
    const html = grid({ events: [shift(120, { note: "Rained out." })], onEventTap: () => {} });
    expect(html).toContain('title="Sam Tillery · 9a–11a · 2.00 h · On Hold · Rained out."');
    const past = grid({
      events: [{ ...shift(120, { note: "Rained out." }), tapId: "shift:1", actual: { people: [], hollow: true, sentence: "Booked 9–11 · No time clocked" } }],
      onEventTap: () => {},
    });
    expect(past).toContain('aria-label="Sam Tillery · 9a–11a · Booked 9–11 · No time clocked · 2.00 h · On Hold · Rained out.: day, time and crew"');
  });

  it("an event without info (today's /timecards) renders its label and sub exactly as before", () => {
    const html = grid({ events: [{ id: "e9", dayStr: "2026-09-22", startMin: 540, endMin: 660, label: "Dana Rook", sub: "Shop", color: "border-blue-300 bg-blue-100 text-blue-900" }] });
    expect(html).toContain('<div class="truncate font-semibold">Dana Rook</div><div class="truncate opacity-70">Shop</div>');
    expect(html).toContain('title="Dana Rook · Shop"');
    expect(html).not.toContain("-webkit-line-clamp");
    expect(html).not.toContain('<div class="truncate tabular-nums">');
  });
});
