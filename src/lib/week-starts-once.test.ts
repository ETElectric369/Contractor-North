import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isWeekendDay, weekDayStrs, weekWindowInTz, weekdayHeadings } from "@/lib/tz";
import { shortDayWords, weekViewDays } from "@/lib/schedule/week-columns";
import { dayButtonWidth, legalGridWidth, naturalGridWidth, turnedGridWidth } from "@/components/time-grid";

/**
 * THE WEEK STARTS ONCE, AND THE WEEKEND EARNS ITS SPACE.
 *
 * Erik, 2026-10-02: "on the schedule i think the work week should lead with monday and maybe optional
 * like ios" and "optional weekend displayed unless something is booked, saves a lot of space".
 *
 * The first sentence was already BUILT: org settings `week_start` exists, Settings → Scheduling draws
 * the control, and the default has been "monday" all along. It just wasn't WIRED. Four surfaces drew a
 * week and exactly one read the setting:
 *
 *     /timecards            weekRange(offset, tz, week_start)     ← read it
 *     /schedule week+month  startOfWeek(anchor)  "Sunday start"   ← didn't
 *     My Day week           getUTCDay()  "0 = Sunday"             ← didn't
 *     Nort "this week"      getUTCDay() + 6) % 7  "Monday = 0"    ← didn't, and hardcoded the other way
 *     /tasks "This week"    (6 - getUTCDay())                     ← didn't, and said so wrongly
 *
 * That is the repo's own two-doors-one-thing defect in its purest form: a setting that is honoured at
 * one door and ignored at four, so the Settings page tells the truth and the screens don't. These are
 * the teeth. The behaviour cases pin the one rule; the SOURCE scan fails if a sixth copy of the
 * arithmetic shows up, and names every file it lets through and why.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Source with its comments removed — a scan for CODE must not trip over prose ABOUT the code (this
 *  very lane left `getUTCDay()` in two explanatory comments, which is exactly how a tripwire like
 *  this ends up disabled by whoever gets tired of it). */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/** THE ONE PLACE the week's first day may be worked out from a raw weekday number. */
const THE_ONE_FUNCTION = "src/lib/tz.ts";

/**
 * EVERY OTHER FILE THAT MAY ASK A DATE WHICH WEEKDAY IT IS, and the reason each one is NOT a week
 * start. A new entry here is a decision somebody has to write a sentence for.
 */
const ALLOWED: { file: string; why: string }[] = [
  {
    file: "src/app/(app)/appointments/appointment-button.tsx",
    why: "Skips Sat/Sun when offering the customer dates to pick from. A weekend SKIP, not a week start — it never asks where the week begins.",
  },
  {
    file: "src/app/(app)/leads/convert-menu.tsx",
    why: "Same weekend skip when a lead is converted straight onto a day.",
  },
  {
    file: "src/app/(app)/jobs/[id]/propose-dates-button.tsx",
    why: "Same weekend skip when proposing visit dates on a job.",
  },
  {
    file: "src/app/(app)/timeclock/crew-actions.ts",
    why: "Time off across a span: the includeWeekends switch decides whether Sat/Sun get rows. A weekend skip the person chose.",
  },
  {
    file: "src/lib/schedule/work-shape.ts",
    why: "workingDaysFrom sizes a multi-day job in WORKING days, skipping Sat/Sun after the first.",
  },
  {
    file: "src/lib/schedule/booked-days.ts",
    why: "A visit's span was sized in working days, so expanding it back to days skips Sat/Sun too.",
  },
  {
    file: "src/lib/come-back-days.ts",
    why: "nextMonday: the literal 'Monday' come-back chip. The day Erik named, not the week's first day — it stays Monday on a Sunday-start company.",
  },
  {
    file: "src/lib/actions/entities/appointment.ts",
    why: "Reads a weekday NAME ('Tue') back for a confirmation sentence. Nothing to do with where a week begins.",
  },
  {
    file: "src/lib/analytics/fuel-trend.ts",
    why:
      "mondayOf buckets 13 weeks of fuel spend. A FIGURE: changing the bucket would move money between bars, which this lane promised not to do. Deliberately left on a fixed Monday; a follow-up may offer it the setting.",
  },
];

/** Every source file in the app, so the scan cannot be dodged by adding a file nobody listed. */
function sourceFiles(): string[] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
    }
  };
  walk("src");
  return out;
}

describe("the week starts once — the one rule", () => {
  it("answers the company's week, Monday-start and Sunday-start, from the same function", () => {
    // 2026-07-15 is a Wednesday.
    expect(weekDayStrs("2026-07-15", "monday")[0]).toBe("2026-07-13"); // Monday
    expect(weekDayStrs("2026-07-15", "sunday")[0]).toBe("2026-07-12"); // Sunday
    expect(weekDayStrs("2026-07-15", "monday")[6]).toBe("2026-07-19"); // …to Sunday
    expect(weekDayStrs("2026-07-15", "sunday")[6]).toBe("2026-07-18"); // …to Saturday
  });

  it("is the SAME seven days a week window asks the database for", () => {
    const w = weekWindowInTz("2026-07-15", "monday", "America/Los_Angeles");
    expect(w.days).toEqual(weekDayStrs("2026-07-15", "monday"));
    expect(w.days).toHaveLength(7);
    // Local midnight Monday → local midnight the following Monday, end exclusive.
    expect(w.start.toISOString()).toBe("2026-07-13T07:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-07-20T07:00:00.000Z");
  });

  it("gives a DST week its real length instead of a flat 7 x 24 hours", () => {
    // US fall-back is Sunday 2026-11-01, inside the Monday-start week of Oct 26.
    const w = weekWindowInTz("2026-10-28", "monday", "America/Los_Angeles");
    expect(w.days[0]).toBe("2026-10-26");
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(169);
  });

  it("pages signed — future-positive for planning, and /timecards says so when it pages back", () => {
    expect(weekDayStrs("2026-07-15", "monday", 1)[0]).toBe("2026-07-20");
    expect(weekDayStrs("2026-07-15", "monday", -1)[0]).toBe("2026-07-06");
    // /timecards' offset counts weeks into the PAST, so it passes -offset. The comment at its
    // weekRange is the only thing standing between that and an off-by-a-week pay sheet.
    expect(code("src/app/(app)/timecards/page.tsx")).toContain("weekWindowInTz(todayStrInTz(tz), weekStart, tz, -offset)");
  });

  it("labels the month grid's columns in the company's order, never a hardcoded Sun…Sat", () => {
    expect(weekdayHeadings("monday")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayHeadings("sunday")).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    // The headings and the first cell must come from the same setting, on the same screen.
    const CAL = code("src/app/(app)/calendar/calendar-view.tsx");
    expect(CAL).toContain("weekdayHeadings(weekStart)");
    expect(CAL).toContain("weekDaysOf(first, weekStart)[0]");
    expect(CAL).not.toContain('["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]');
  });

  it("survives junk instead of throwing (the payPeriodBounds guard precedent)", () => {
    expect(() => weekDayStrs("2026-13-40", "monday", Number.NaN)).not.toThrow();
    expect(weekDayStrs("nope", "monday")).toHaveLength(7);
    expect(() => weekWindowInTz("nope", "sunday", "America/Los_Angeles")).not.toThrow();
  });
});

describe("the week starts once — THE TEETH", () => {
  it("every week-drawing surface calls the one function and hand-rolls nothing", () => {
    const callers: { file: string; must: string }[] = [
      { file: "src/app/(app)/timecards/page.tsx", must: "weekWindowInTz(" },
      { file: "src/app/(app)/planner/page.tsx", must: "weekWindowInTz(" },
      { file: "src/app/(app)/calendar/calendar-view.tsx", must: "weekDayStrs(" },
      { file: "src/lib/assistant-tools.ts", must: "weekDayStrs(" },
      { file: "src/app/(app)/tasks/tasks-view.tsx", must: "weekDayStrs(" },
    ];
    for (const { file, must } of callers) {
      const src = code(file);
      expect(src, `${file} must get its week from the one rule`).toContain(must);
      expect(src, `${file} must not compute a weekday itself`).not.toMatch(/get(?:UTC)?Day\(\)/);
    }
  });

  it("and every one of them reads the COMPANY's setting rather than assuming a day", () => {
    // Settings → Scheduling is the only place the answer comes from; a surface that hardcodes
    // "monday" at the call site is the same bug wearing the new function's name.
    expect(code("src/app/(app)/timecards/page.tsx")).toContain("orgSettings.week_start");
    expect(code("src/app/(app)/planner/page.tsx")).toContain(".week_start");
    expect(code("src/app/(app)/schedule/calendar-panel.tsx")).toContain(".week_start");
    expect(code("src/app/(app)/tasks/query.ts")).toContain(".week_start");
    expect(code("src/lib/assistant-tools.ts")).toContain("schedSettings.week_start");
  });

  it("no sixth copy: only lib/tz.ts, or a file that states why its weekday is not a week start", () => {
    const named = new Set([THE_ONE_FUNCTION, ...ALLOWED.map((a) => a.file)]);
    const strays = sourceFiles().filter((f) => /get(?:UTC)?Day\(\)/.test(code(f)) && !named.has(f));
    expect(
      strays,
      `These files work out a weekday from a raw Date. If it is a WEEK START, call lib/tz weekDayStrs; ` +
        `if it is something else (a weekend skip, a weekday name), add it to ALLOWED with the reason:\n` +
        strays.join("\n"),
    ).toEqual([]);
  });

  it("and no sixth copy of the ROTATION either — (dow + 6) % 7 is the week-start formula itself", () => {
    const rotators = sourceFiles().filter(
      (f) => f !== THE_ONE_FUNCTION && /\+\s*6\)\s*%\s*7/.test(code(f)),
    );
    const allowed = new Set(ALLOWED.map((a) => a.file));
    expect(rotators.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("keeps the allow-list honest: every entry still exists and still carries a reason", () => {
    for (const { file, why } of ALLOWED) {
      expect(() => read(file), `${file} is listed but gone — drop the entry`).not.toThrow();
      expect(/get(?:UTC)?Day\(\)/.test(code(file)), `${file} no longer needs its exemption`).toBe(true);
      expect(why.length, `${file} needs a real reason, not a shrug`).toBeGreaterThan(40);
    }
  });

  it("leaves the pay week seven days long — hours are summed over it", () => {
    // The weekend rule folds away COLUMNS on the schedule. A pay week is a fixed window that money is
    // counted across, so /timecards must never import it.
    expect(code("src/app/(app)/timecards/page.tsx")).not.toContain("week-columns");
    expect(weekWindowInTz("2026-07-18", "monday", "America/Los_Angeles").days).toHaveLength(7);
  });
});

describe("a weekend day earns its space", () => {
  // The Monday-start week of 2026-07-13: Mon 13 … Fri 17, Sat 18, Sun 19.
  const WEEK = weekDayStrs("2026-07-15", "monday");
  const none = () => false;

  it("knows which days are the weekend wherever the week start puts them", () => {
    expect(WEEK.filter(isWeekendDay)).toEqual(["2026-07-18", "2026-07-19"]);
    expect(weekDayStrs("2026-07-15", "sunday").filter(isWeekendDay)).toEqual(["2026-07-12", "2026-07-18"]);
    // A Sunday-start week opens on a weekend day — the rule must not be about POSITION.
    expect(isWeekendDay(weekDayStrs("2026-07-15", "sunday")[0])).toBe(true);
  });

  it("draws five columns when the weekend is clear", () => {
    const { shown, hidden } = weekViewDays(WEEK, { hasWork: none, todayStr: "2026-07-15" });
    expect(shown).toEqual(["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"]);
    expect(hidden).toEqual(["2026-07-18", "2026-07-19"]);
  });

  it("gives each weekend day its own column INDEPENDENTLY", () => {
    // The Saturday emergency call is drawn; the empty Sunday beside it is not.
    const { shown, hidden } = weekViewDays(WEEK, {
      hasWork: (d) => d === "2026-07-18",
      todayStr: "2026-07-15",
    });
    expect(shown).toHaveLength(6);
    expect(shown).toContain("2026-07-18");
    expect(hidden).toEqual(["2026-07-19"]);
  });

  it("never hides a working day, however empty the week is", () => {
    const { shown } = weekViewDays(WEEK, { hasWork: none, todayStr: "2026-01-01" });
    expect(shown).toEqual(WEEK.slice(0, 5));
  });

  it("always draws a weekend day that is TODAY", () => {
    const { shown, hidden } = weekViewDays(WEEK, { hasWork: none, todayStr: "2026-07-19" });
    expect(shown).toContain("2026-07-19"); // the Sunday you are standing in
    expect(hidden).toEqual(["2026-07-18"]); // the empty Saturday beside it still folds away
  });

  it("always draws BOTH weekend days while a placement is armed — you cannot drop onto a column that isn't there", () => {
    const { shown, hidden } = weekViewDays(WEEK, { hasWork: none, todayStr: "2026-07-15", armed: true });
    expect(shown).toEqual(WEEK);
    expect(hidden).toEqual([]);
  });

  it("re-draws the weekend by itself once work appears there — no switch to remember", () => {
    const before = weekViewDays(WEEK, { hasWork: none, todayStr: "2026-07-15" });
    expect(before.shown).not.toContain("2026-07-18");
    const after = weekViewDays(WEEK, { hasWork: (d) => d === "2026-07-18", todayStr: "2026-07-15" });
    expect(after.shown).toContain("2026-07-18");
  });

  it("names the days it folded away, so a week that grows a column warned you first", () => {
    const { hidden } = weekViewDays(WEEK, { hasWork: none, todayStr: "2026-07-15" });
    expect(hidden.map(shortDayWords)).toEqual(["Sat 18", "Sun 19"]);
    // Said on BOTH week views, from the one spelling.
    expect(code("src/app/(app)/calendar/calendar-view.tsx")).toContain("shortDayWords(k)");
    expect(code("src/app/(app)/planner/page.tsx")).toContain("weekHiddenDays.map(shortDayWords)");
  });

  it("and the schedule's named day is a 44px target, not a 20px word", () => {
    // It is a DOOR — it opens that day, where Add To Schedule lives — so it is measured against the
    // 44px rule like every other control in that header. 20px of look (h-5, so the one-line header
    // does not grow) plus 12px of bleed above and below through `before`, the header's own idiom.
    const CAL = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(CAL).toMatch(
      /onClick=\{\(\) => drillInto\(k\)\}[\s\S]{0,200}className="relative inline-flex h-5 items-center align-middle[^"]*before:-inset-y-3 before:content-\[''\]"/,
    );
  });

  it("would rather draw a whole week than an empty card with no columns", () => {
    const { shown, hidden } = weekViewDays([], { hasWork: none, todayStr: "2026-07-15" });
    expect(shown).toEqual([]);
    expect(hidden).toEqual([]);
    // Every day weekend AND empty: the guard hands the days back rather than drawing nothing.
    const bothWeekend = weekViewDays(["2026-07-18", "2026-07-19"], { hasWork: none, todayStr: "2026-01-01" });
    expect(bothWeekend.shown).toEqual(["2026-07-18", "2026-07-19"]);
    expect(bothWeekend.hidden).toEqual([]);
  });

  it("is ONE rule: the schedule's columns and My Day's rows come from the same function", () => {
    expect(code("src/app/(app)/calendar/calendar-view.tsx")).toContain("weekViewDays(");
    expect(code("src/app/(app)/planner/page.tsx")).toContain("weekViewDays(");
  });
});

describe("the weekend rule changes which columns are drawn, and nothing else", () => {
  const CAL = code("src/app/(app)/calendar/calendar-view.tsx");

  it("asks the VIEW what it draws on a day rather than guessing a list of record kinds", () => {
    // gridDataFor is the one place that knows: jobs, visits, calls and tasks in the tray, ghosts of
    // work nobody booked, mirrored Google events. "Has work" is its output being non-empty.
    expect(CAL).toContain("const drawn = new Map(all.map((d) => [d.dayStr, gridDataFor(d.dayStr)]));");
    expect(CAL).toContain("g.events.length > 0 || g.allDay.length > 0");
  });

  it("computes the week's own facts from the WHOLE week, never from the drawn days", () => {
    // A span label, "this week", the Card key and how far the clocked time reaches are facts about the
    // week. Reading them off the surviving columns would rename a Sunday-start week the moment its
    // Sunday emptied out, and remount it in the scroll stack under a second key.
    expect(CAL).toContain("label: spanLabel(wk[0], wk[6], { month: \"long\" })");
    expect(CAL).toContain("hasToday: all.some((d) => d.isToday)");
    expect(CAL).toContain("loadsBack: !!actualsCappedBefore && clockInUse && first < actualsCappedBefore && first < todayK");
    expect(CAL).toContain("<Card key={weekKey}");
    // And the endless stack still measures its reach from the full week's first day.
    expect(CAL).toContain("const weekStartK = dayKey(weekDays[0] ?? anchor);");
  });

  it("rebuilds the mounted weeks when arming changes which columns exist", () => {
    // The week cache survives a scroll growth on purpose. Arming changes the COLUMNS, so it has to be
    // part of the cache key or a picked job has no weekend to land on until something else invalidates.
    expect(CAL).toMatch(/personFilter, tz, todayK, canEdit, workDayStart, workDayEnd, armed,/);
  });

  it("keeps My Day's 'Week of' label on the week's real first day", () => {
    const PLANNER = code("src/app/(app)/planner/page.tsx");
    expect(PLANNER).toContain("const weekOfLabel = weekFirstDay");
    expect(PLANNER).not.toContain("weekDayGroups[0].dayStr}T12:00:00Z");
  });

  it("leaves the month grid whole — a calendar you can count on", () => {
    expect(CAL).not.toMatch(/MonthGrid[\s\S]{0,2000}weekViewDays/);
  });
});

describe("what the space actually buys", () => {
  /** Erik's 16 Pro, turned: the face less its padding and the Card's borders — the room the week's own
   *  scroller gets (the same number chrome-stays-put.test.ts measures the 44px floor against). */
  const ROOM_TURNED = 684 - 24 - 2;

  it("a five-day week FITS the turned phone the seven-day one overflowed", () => {
    // cn-v1046/1047 got all seven columns onto the turned face by sharing the room down to a 44px
    // thumb — and still ran 13px past it (chrome-stays-put.test.ts asserts exactly that overshoot).
    expect(naturalGridWidth(7)).toBeGreaterThan(ROOM_TURNED);
    expect(legalGridWidth(7, true)).toBe(ROOM_TURNED + 13);
    // Drop the two empty weekend columns and the week stops fighting the screen altogether: it asks
    // for less than the room there is, so nothing is squeezed and nothing scrolls sideways.
    expect(naturalGridWidth(5)).toBeLessThan(ROOM_TURNED);
    expect(turnedGridWidth(5, ROOM_TURNED)).toBe(naturalGridWidth(5));
    // And each day's own drill-in button comes out well past the law instead of exactly on it.
    expect(dayButtonWidth(5, turnedGridWidth(5, ROOM_TURNED))).toBeGreaterThan(44);
  });

  it("gives a portrait phone five readable columns where it had three and a half", () => {
    // 375pt upright: the grid keeps its natural width and scrolls. Five columns of it is most of the
    // week on screen at once; seven was 692px of a 375px screen.
    expect(naturalGridWidth(7)).toBe(692);
    expect(naturalGridWidth(5)).toBe(508);
    // A six-day week (one weekend day booked) lands in between — the column count follows the work.
    expect(naturalGridWidth(6)).toBe(600);
  });

  it("never lets a shorter week breach the 44px rule either", () => {
    for (let days = 2; days <= 7; days++) {
      for (let room = 300; room <= 1400; room += 1) {
        expect(dayButtonWidth(days, turnedGridWidth(days, room))).toBeGreaterThanOrEqual(44);
      }
    }
  });
});
