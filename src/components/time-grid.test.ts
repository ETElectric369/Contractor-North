import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE SHARED TIME GRID, after Wave 2's schedule lane (SV-chips, SV-actual, SV-ghost). Everything new is
 * optional and additive: /timecards passes none of it and renders exactly as before; on the schedule a
 * block's crew draws INSIDE it as marks (never a second button), a past block's worked time draws as a
 * sibling layer of bars that never catches a tap, and the block's tap stays the one door.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { TimeGrid, hollowTone, type TimeGridEvent } from "./time-grid";
import { pillColorForPerson } from "@/lib/employee-color";

const LA = "America/Los_Angeles";
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
    // period edge, an all-day row. The hash is main's (cn-v1030) TimeGrid rendering these same props.
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
    expect(createHash("sha256").update(html).digest("hex")).toBe("080f61fad81aa513097264872130882b237451f18da9a174cce7c76f90f69cbe");
    expect(html).not.toContain("data-worked-bars");
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
    const html = grid({ events: [block({ actual: { people: [], hollow: true, sentence: "Booked 9–5 · Nobody clocked in" } })] });
    expect(html).toContain("border-slate-300 bg-white/40 text-slate-500");
    expect(html).not.toContain("bg-slate-200/80");
    expect(html).toContain("Booked 9–5 · Nobody clocked in");
    expect(html).not.toContain("data-worked-bars");
  });

  it("armed, the block with bars still places (the whole column does; the bars never catch the tap)", () => {
    const html = grid({ events: [worked], placement: { label: "Put it here", onPlace: () => {} } });
    expect(html).toMatch(/<button type="button" style="top:[^"]*" title="Put it here — Tue 22"/);
    expect(html).toContain("data-worked-bars");
  });
});
