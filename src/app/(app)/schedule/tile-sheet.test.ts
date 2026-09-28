import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * TAP A BLOCK ON THE SCHEDULE: ONE SHEET with its day, its start and its length, and who's on it (Erik,
 * 2026-09-28: "on the schedule itself there should be a time adjustment inside the job itself with the
 * crew picker"). Rendered on the real components: every door is 44px, the time controls and the crew
 * chips are there, "Nobody" is dashed, and the crew reads it all with nothing to tap.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./actions", () => ({
  clearJobDate: vi.fn(),
  moveJobDay: vi.fn(),
  setJobTimes: vi.fn(),
  setJobDayTimes: vi.fn(),
  setVisitTimes: vi.fn(),
  changeJobCrew: vi.fn(),
  bookWorkedDay: vi.fn(),
  unbookWorkedDay: vi.fn(),
}));
vi.mock("../appointments/actions", () => ({
  rescheduleAppointment: vi.fn(),
  setAppointmentAssignee: vi.fn(),
  unscheduleAppointment: vi.fn(),
}));

import { createSheetGuard, TileSheetBody, type TileTarget } from "./tile-sheet";
import { segmentJobsNotLoaded } from "@/lib/schedule/cal-window";
import { JobScheduleCard } from "./job-schedule-card";
import { tzDateTimeUtc } from "@/lib/tz";
import { crewChips } from "@/lib/schedule/block-info";
import { pillColorForPerson } from "@/lib/employee-color";
import { mergePeople } from "@/lib/schedule/plan-vs-actual";
import { GhostRow, ghostTitle } from "./ghost-sheet";

const LA = "America/Los_Angeles";
const WORK_DAY = { start: "09:00", end: "17:00" };
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA);
const team = [
  { id: "p-erik", full_name: "Erik Taylor" },
  { id: "p-brian", full_name: "Brian Cole" },
];
const seiler = (over: Partial<Extract<TileTarget, { kind: "job" }>["job"]> = {}): TileTarget => ({
  kind: "job",
  day: "2026-09-28",
  job: {
    id: "j058",
    name: "Seiler · 3-way switches",
    status: "scheduled",
    scheduled_start: at("2026-09-28", "10:00"),
    scheduled_end: at("2026-09-28", "12:00"),
    planned_minutes: null,
    assigned_to: ["p-erik"],
    customers: { name: "Rich Seiler" },
    ...over,
  },
});
const visit: TileTarget = {
  kind: "visit",
  day: "2026-09-28",
  visit: { id: "v1", title: "Site inspection: Rich Seiler", status: "scheduled", starts_at: at("2026-09-28", "09:00")!, ends_at: null, assigned_to: null },
};
const render = (target: TileTarget, canEdit = true) =>
  renderToStaticMarkup(createElement(TileSheetBody, { target, tz: LA, workDay: WORK_DAY, team, canEdit, onClose: () => {} }));

/** Every tappable thing, as its opening tag. */
const doors = (html: string) => html.match(/<(button|a|input)\b[^>]*>/g) ?? [];
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("a job's sheet, for the office", () => {
  const html = render(seiler());

  it("carries the day, the start and the end, the quick lengths, the crew, Open The Job and Clear The Date", () => {
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2026-09-28"/);
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="10:00"/);
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="12:00"/);
    for (const chip of ["1h", "2h", "4h", "Full Day"]) expect(html).toMatch(new RegExp(`<button[^>]*>${chip}</button>`));
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j058"[^>]*>Open The Job<\/a>/);
    expect(text(html)).toContain("Clear The Date");
    expect(text(html)).toContain("Move");
  });

  it("reads the block back, and says nobody chose the length (the two-hour default)", () => {
    expect(text(html)).toContain("10:00 AM – 12:00 PM · 2 hours — change it");
    // The lit chip is the length it has.
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>2h<\/button>/);
  });

  it("the crew as initials chips (the job page's crew logic), with + Add", () => {
    expect(html).toMatch(/<button[^>]*aria-label="Erik Taylor"[^>]*>ET<\/button>/);
    expect(html).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Add<\/button>/);
  });

  it("every door is 44px", () => {
    const ds = doors(html);
    expect(ds.length).toBeGreaterThan(8);
    for (const d of ds) expect(d, d).toMatch(/\b(min-)?h-11\b/);
  });

  it("nobody on it is a dashed Nobody, never a blank", () => {
    const empty = render(seiler({ assigned_to: [] }));
    expect(empty).toMatch(/<span[^>]*border-dashed[^>]*>Nobody<\/span>/);
  });

  it("a chosen length reads as chosen", () => {
    expect(text(render(seiler({ planned_minutes: 120 })))).toContain("10:00 AM – 12:00 PM · 2 hours ");
    expect(text(render(seiler({ planned_minutes: 120 })))).not.toContain("change it");
  });

  it("a job over several days asks only its start, and says full days", () => {
    const many = render(seiler({ scheduled_end: at("2026-09-30", "17:00"), planned_minutes: 1440 }));
    expect(many).not.toMatch(/>4h</);
    expect(text(many)).toContain("full days through Wed, Sep 30");
  });
});

describe("a visit's sheet", () => {
  const html = render(visit);

  it("the same time controls, who's going as one person, Open The Visit and Clear The Date", () => {
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="09:00"/);
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="10:00"/);
    expect(text(html)).toContain("Who's Going");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*border-dashed[^>]*>Nobody<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-label="Brian Cole"[^>]*>BC<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/appointments\/v1"[^>]*>Open The Visit<\/a>/);
    expect(text(html)).toContain("Clear The Date");
    expect(text(html)).toContain("9:00 AM – 10:00 AM · 1 hour — change it");
  });

  it("every door is 44px", () => {
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
  });
});

describe("staff only: the crew reads it, with nothing to tap", () => {
  it("no button, no input, the block and the crew in words and chips, and still the way to the job", () => {
    const html = render(seiler(), false);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(text(html)).toContain("10:00 AM – 12:00 PM · 2 hours — change it");
    expect(html).toMatch(/aria-label="Erik Taylor"[^>]*>ET</);
    expect(html).toMatch(/href="\/jobs\/j058"/);
    expect(text(html)).not.toContain("Clear The Date");
  });

  it("the schedule opens the sheet only for the office; every writer behind it asks requireStaff", () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const view = read("src/app/(app)/calendar/calendar-view.tsx");
    expect(view).toContain("onEventTap={canEdit ? onEventTap : undefined}");
    expect(view).toMatch(/\{canEdit && \(\s*<ScheduleTileSheet/);
    expect(read("src/app/(app)/schedule/page.tsx")).toContain("<CalendarPanel canEdit={isStaffRole(me.role)} />");

    const body = (src: string, name: string) => {
      const from = src.indexOf(`export async function ${name}(`);
      expect(from, name).toBeGreaterThan(-1);
      return src.slice(from, from + 600);
    };
    const sched = read("src/app/(app)/schedule/actions.ts");
    for (const fn of ["setJobTimes", "clearJobDate", "setVisitTimes", "moveJobDay", "setJobCrew", "changeJobCrew"]) {
      expect(body(sched, fn), fn).toContain("await requireStaff()");
    }
    const appts = read("src/app/(app)/appointments/actions.ts");
    for (const fn of ["setAppointmentAssignee", "rescheduleAppointment", "unscheduleAppointment"]) {
      expect(body(appts, fn), fn).toContain("await requireStaff()");
    }
  });

  it("the sheet shows no money", () => {
    // The code, not its comments (which say, in words, that no price is on it).
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/tile-sheet.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(src).not.toMatch(/\b(prices?|amounts?|totals?|costs?|rates?|bill_rate|pay_rate)\b|formatCurrency|\$\d/i);
  });
});

describe("the day drill's job card opens the same sheet", () => {
  it("one 44px tap with the time and the crew's initials; its own crew dropdown and Move are gone", () => {
    const html = renderToStaticMarkup(
      createElement(JobScheduleCard, {
        job: {
          id: "j058",
          name: "Seiler · 3-way switches",
          job_number: "J-058",
          status: "scheduled",
          scheduled_start: at("2026-09-28", "10:00"),
          scheduled_end: at("2026-09-28", "12:00"),
          planned_minutes: null,
          assigned_to: [],
          customers: { name: "Rich Seiler" },
        },
        members: team,
        tz: LA,
        workDay: WORK_DAY,
        onOpen: () => {},
      }),
    );
    const tap = (html.match(/<button[^>]*>/g) ?? []).find((b) => b.includes('aria-label="Seiler · 3-way switches: day, time and crew"'));
    expect(tap).toBeTruthy();
    expect(tap).toMatch(/\bmin-h-11\b/);
    expect(text(html)).toContain("10:00 AM – 12:00 PM · 2 hours — change it");
    expect(text(html)).toContain("Nobody");
    expect(html).not.toContain("Assign crew");
    expect(html).not.toContain("Move to a Day");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/job-schedule-card.tsx"), "utf8");
    expect(src).not.toMatch(/setJobCrew\(/);
  });

  const card = (day: string, over: Record<string, unknown> = {}) =>
    text(
      renderToStaticMarkup(
        createElement(JobScheduleCard, {
          job: {
            id: "j058",
            name: "Seiler · 3-way switches",
            job_number: "J-058",
            status: "scheduled",
            scheduled_start: at("2026-09-29", "09:00"),
            scheduled_end: at("2026-09-29", "11:00"),
            planned_minutes: 120,
            assigned_to: [],
            customers: { name: "Rich Seiler" },
            ...over,
          },
          members: team,
          tz: LA,
          workDay: WORK_DAY,
          day,
          onOpen: () => {},
        }),
      ),
    );

  it("on a worked day kept as history the card says so, as the grid draws it (all day), never the plan's 9 to 11", () => {
    expect(card("2026-09-29")).toContain("9:00 AM – 11:00 AM · 2 hours");
    expect(card("2026-09-22")).toContain("Worked day · planned Tue, Sep 29");
    expect(card("2026-09-22")).not.toContain("9:00 AM – 11:00 AM");
    expect(card("2026-09-22", { scheduled_start: null, scheduled_end: null })).toContain("Worked day · no day planned yet");
    const view = readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-view.tsx"), "utf8");
    expect(view).toMatch(/<JobScheduleCard[\s\S]*?day=\{dayK\}/);
  });
});

describe("a worked day kept as history, tapped", () => {
  const history = (over: Partial<Extract<TileTarget, { kind: "job" }>["job"]> = {}) => {
    const t = seiler({ scheduled_start: at("2026-09-29", "10:00"), scheduled_end: at("2026-09-29", "12:00"), ...over });
    return { ...t, day: "2026-09-22" } as TileTarget;
  };

  it("says the day was worked and where the plan is; its time controls are labelled the plan's", () => {
    const t = text(render(history()));
    expect(t).toContain("Work was done this day; it stays as history. The job is planned Tue, Sep 29, and Move moves that.");
    expect(t).toContain("The plan's time, Tue, Sep 29:");
  });

  it("its Move moves the plan (no from-day), never the worked day", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/tile-sheet.tsx"), "utf8");
    expect(src).toContain("const from = onPlan ? day : null;");
    expect(src).toContain("moveJobDay(job.id, from, to)");
  });

  it("with no plan left: no time to set and nothing to clear, and Move gives it a day", () => {
    const t = text(render(history({ scheduled_start: null, scheduled_end: null })));
    expect(t).toContain("No day is planned yet: Move gives it one.");
    expect(t).not.toContain("Clear The Date");
  });
});

describe("the calendar draws a cleared job's worked day (Clear The Date keeps it there)", () => {
  it("names the jobs a window segment points at that the listed-span read didn't bring", () => {
    expect(
      segmentJobsNotLoaded(["a"], [
        { job_id: "a" },
        { job_id: "cleared" },
        { job_id: "cleared" },
      ]),
    ).toEqual(["cleared"]);
    expect(segmentJobsNotLoaded([], [])).toEqual([]);
  });

  it("CalendarPanel reads those by id with the same columns and hands them to the view", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/calendar-panel.tsx"), "utf8");
    expect(src).toContain("segmentJobsNotLoaded(");
    expect(src).toMatch(/\.from\("jobs"\)\.select\(JOB_COLS\)\.in\("id", missing/);
    expect(src).toContain("const jobs: unknown[] = [...(listedJobs ?? []), ...(historyJobs ?? [])];");
  });
});

describe("nothing said to a sheet nobody can see", () => {
  it("a refusal still standing when the sheet closes is said again in a toast", () => {
    const said: string[] = [];
    const g = createSheetGuard((w) => said.push(w), () => {});
    g.opened();
    g.refusal("The end has to be after the start.");
    expect(said).toEqual([]);
    g.closing();
    expect(said).toEqual(["The end has to be after the start."]);
  });

  it("one that comes back after the sheet closed goes straight to a toast; a new try clears a standing one", () => {
    const said: string[] = [];
    const g = createSheetGuard((w) => said.push(w), () => {});
    g.opened();
    g.refusal("Old words.");
    g.refusal(null);
    g.closing();
    expect(said).toEqual([]);
    g.refusal("That time didn't save. You may be offline.");
    expect(said).toEqual(["That time didn't save. You may be offline."]);
  });

  it("while a write is out the count is up (the sheet holds itself open), and it comes back down", () => {
    const counts: number[] = [];
    const g = createSheetGuard(() => {}, (n) => counts.push(n));
    g.pending(true);
    g.pending(true);
    g.pending(false);
    g.pending(false);
    g.pending(false);
    expect(counts).toEqual([1, 2, 1, 0, 0]);
  });

  it("the Modal holds open on it, every writer in the sheet reports to it, and the time box says it's busy in the same event", () => {
    const sheet = readFileSync(join(process.cwd(), "src/app/(app)/schedule/tile-sheet.tsx"), "utf8");
    expect(sheet).toContain("holdOpen={busy > 0}");
    expect(sheet).toMatch(/<DayRow [^>]*voice=\{voice\}/);
    expect(sheet.match(/<ClearTheDate [^>]*voice=\{voice\}/g)?.length).toBe(2);
    expect(sheet.match(/onPending=\{voice\?\.pending\}/g)?.length).toBe(2);
    expect(sheet.match(/onRefusal=\{voice\?\.refusal\}/g)?.length).toBe(2);
    const controls = readFileSync(join(process.cwd(), "src/components/block-time-controls.tsx"), "utf8");
    // Said before the transition starts, so the backdrop click of the same tap finds the sheet held.
    expect(controls).toMatch(/onPending\?\.\(true\);\s*start\(async/);
    expect(controls).toContain('refuse("The end has to be after the start.")');
  });
});

describe("This Day: the tile's time is the tapped day's, once a day can keep its own hours (0370)", () => {
  const herringbone = (over: Record<string, unknown> = {}): TileTarget =>
    ({
      kind: "job",
      day: "2026-09-28",
      job: {
        id: "j011",
        name: "Herringbone",
        status: "in_progress",
        scheduled_start: at("2026-09-24", "09:00"),
        scheduled_end: at("2026-09-28", "17:00"),
        planned_minutes: null,
        assigned_to: ["p-erik"],
        customers: { name: "Kim Hale" },
        address: "22 Herringbone Way",
        city: "Truckee",
      },
      dayHours: { start: "12:00", end: "17:00" },
      ...over,
    }) as TileTarget;
  const renderDay = (target: TileTarget, canEdit = true) =>
    renderToStaticMarkup(createElement(TileSheetBody, { target, tz: LA, workDay: WORK_DAY, team, canEdit, perDayHours: true, onClose: () => {} }));

  it("a day of several with its own hours: This Day's noon to 5, said, the quick lengths, and the way back to the usual hours", () => {
    const html = renderDay(herringbone());
    const t = text(html);
    expect(t).toContain("This Day, Mon, Sep 28: its own hours. The job's other days keep theirs.");
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="12:00"/);
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="17:00"/);
    for (const chip of ["1h", "2h", "4h", "Full Day"]) expect(html).toMatch(new RegExp(`<button[^>]*>${chip}</button>`));
    expect(t).toContain("12:00 PM – 5:00 PM · 5 hours");
    expect(html).toMatch(/<button[^>]*>Use The Job&#x27;s Usual Hours<\/button>/);
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
  });

  it("a day of several on the usual hours: only this day changes, and it says so; no way back for hours it doesn't have", () => {
    const html = renderDay(herringbone({ dayHours: null }));
    expect(text(html)).toContain("This Day, Mon, Sep 28. Only this day changes; the job page sets the hours of its other days.");
    expect(html).not.toContain("Usual Hours");
    // The last day of the run draws the opening to its end: 9 to 5.
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="09:00"/);
  });

  it("the job's one day: This Day is the job's time", () => {
    const t = text(renderDay(seiler()));
    expect(t).toContain("This Day, Mon, Sep 28: the job's one day, so this is the job's time.");
    expect(t).toContain("10:00 AM – 12:00 PM · 2 hours — change it");
  });

  it("where and who under the name: the street and the town", () => {
    expect(text(renderDay(herringbone()))).toContain("22 Herringbone Way · Truckee");
  });

  it("the crew reads This Day's hours with nothing to tap", () => {
    const html = renderDay(herringbone(), false);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("This Day saves through setJobDayTimes on the tapped day; the way back asks for the usual hours; the job's time stays setJobTimes", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/tile-sheet.tsx"), "utf8");
    expect(src).toContain('setJobDayTimes(job.id, day, "start" in patch ? { start: patch.start } : { length: patch.length })');
    expect(src).toContain("setJobDayTimes(job.id, day, { usual: true })");
    expect(src).toContain("save={thisDay ? saveDayTimes : saveTimes}");
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/schedule/actions.ts"), "utf8");
    const from = actions.indexOf("export async function setJobDayTimes(");
    expect(actions.slice(from, from + 600)).toContain("await requireStaff()");
    const add = actions.indexOf("export async function addJobDay(");
    expect(actions.slice(add, add + 600)).toContain("await requireStaff()");
  });
});

describe("the crew, each in their own color, and whose crew it is (Wave 2, SV-chips)", () => {
  const renderWith = (target: TileTarget, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(TileSheetBody, { target, tz: LA, workDay: WORK_DAY, team, canEdit: true, onClose: () => {}, ...extra }));

  it("a job's crew circles and a visit's people wear each person's color (one person, one color)", () => {
    const job = renderWith(seiler());
    expect((job.match(/<button[^>]*aria-label="Erik Taylor"[^>]*>/) ?? [""])[0]).toContain(pillColorForPerson("p-erik").dot);
    const v = renderWith({ ...visit, visit: { ...(visit as Extract<TileTarget, { kind: "visit" }>).visit, assigned_to: "p-brian" } } as TileTarget);
    const brian = (v.match(/<button[^>]*aria-label="Brian Cole"[^>]*>/) ?? [""])[0];
    expect(brian).toContain(pillColorForPerson("p-brian").dot);
    expect(brian).toContain('aria-pressed="true"');
    expect(brian).toContain("ring-2");
    const erik = (v.match(/<button[^>]*aria-label="Erik Taylor"[^>]*>/) ?? [""])[0];
    expect(erik).toContain(pillColorForPerson("p-erik").dot);
    expect(erik).toContain("opacity-40");
    expect(v + job).not.toMatch(/bg-brand text-white ring-2/);
  });

  it("under a job's crew: the whole job, every day; with the Crew Board on, Everyone's Day for one day", () => {
    expect(text(renderWith(seiler()))).toContain("The whole job, every day.");
    expect(text(renderWith(seiler()))).not.toContain("Everyone's Day");
    expect(text(renderWith(seiler(), { crewBoard: true }))).toContain("The whole job, every day. To change one day, use Everyone's Day.");
  });

  it("when that day's rows move someone, one more line says so", () => {
    const t = seiler({ assigned_to: ["p-erik", "p-brian"] }) as Extract<TileTarget, { kind: "job" }>;
    const dayCrew = crewChips(["p-erik", "p-brian"], team, {
      rows: [
        { profile_id: "p-erik", work_date: "2026-09-28", kind: "off", job_id: null },
        { profile_id: "p-brian", work_date: "2026-09-28", kind: "job", job_id: "j-other" },
      ],
      jobId: "j058",
      jobNames: new Map([["j-other", "12 Elm St · J-048"]]),
    });
    const words = text(renderWith({ ...t, dayCrew }));
    expect(words).toContain("Erik is off that day.");
    expect(words).toContain("Brian is on 12 Elm St · J-048 that day.");
  });

  it("the schedule hands the sheet the Crew Board switch and that day's crew", () => {
    const view = readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-view.tsx"), "utf8");
    expect(view).toMatch(/<ScheduleTileSheet[\s\S]*?crewBoard=\{crewBoard\}/);
    expect(view).toContain("dayCrew: jobCrewOn(job, sheet.day)");
  });
});

describe("a ghost, in the one sheet (SV-ghost: work nobody booked)", () => {
  const people = mergePeople(
    [
      { profileId: "p-brian", name: "Brian Cole", jobId: "j11", dayStr: "2026-09-25", startMin: 664, endMin: 826 },
      { profileId: "p-erik", name: "Erik Taylor", jobId: "j11", dayStr: "2026-09-25", startMin: 750, endMin: 1050 },
    ],
    (s) => s + 60,
  );
  const ghost: TileTarget = {
    kind: "ghost",
    day: "2026-09-25",
    ghost: { jobId: "j11", name: "22 Herringbone Way", jobNumber: "J-011", customer: "Kim Hale", people },
  };

  it("who worked it, as a track and in words, and the two doors: Book This Day and Open The Job", () => {
    const html = render(ghost);
    const t = text(html);
    expect(t).toContain("Brian 11:04 AM–1:46 PM · Erik 12:30–5:30 PM. Nothing was booked this day.");
    expect(t).toContain("J-011");
    expect(html).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Book This Day<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/jobs\/j11"[^>]*>Open The Job<\/a>/);
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
    // Never a time box, a day box or Clear The Date: a ghost is not a booking.
    expect(html).not.toContain("<input");
    expect(t).not.toContain("Clear The Date");
  });

  it("the crew (no office) can read it and open the job, with nothing to book", () => {
    const html = render(ghost, false);
    expect(html).not.toContain("<button");
    expect(html).toMatch(/href="\/jobs\/j11"/);
  });

  it("titled with the job and who it's for; the number second, small; one sheet per block", () => {
    expect(ghostTitle({ name: "22 Herringbone Way", customer: "Kim Hale" })).toBe("22 Herringbone Way · Kim Hale");
    expect(ghostTitle({ name: "Kim Hale · Panel", customer: "Kim Hale" })).toBe("Kim Hale · Panel");
    const sheet = readFileSync(join(process.cwd(), "src/app/(app)/schedule/tile-sheet.tsx"), "utf8");
    expect(sheet).toContain('| { kind: "ghost"; day: string; ghost: GhostTarget };');
    expect(sheet).toContain("return <GhostSheetBody day={target.day} ghost={target.ghost}");
    const view = readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-view.tsx"), "utf8");
    expect(view).toContain('if ((kind === "job" || kind === "visit" || kind === "ghost") && id) setSheet({ kind, id, day });');
    expect(view).toContain("...(canEdit ? { tapId: `ghost:${g.jobId}` } : {}),");
  });

  it("never nags: no badge, no count, no bell, no Needs You row; nothing is saved without the tap", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/ghost-sheet.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(src).not.toMatch(/Badge|sendPush|notif|action_items|useEffect/);
    expect(src).toContain("const res = await bookWorkedDay(jobId, day);");
    // The Undo is offered only for a day the tap added.
    expect(src).toContain('res.added ? { label: "Undo", onClick: () => void undo() } : undefined');
    expect(src).toContain("const res = await unbookWorkedDay(jobId, day);");
  });

  it("the day drill's dashed 'Worked, Not Booked' row: the track, the words, the same two 44px doors", () => {
    const html = renderToStaticMarkup(createElement(GhostRow, { day: "2026-09-25", ghost: (ghost as Extract<TileTarget, { kind: "ghost" }>).ghost, canEdit: true }));
    const t = text(html);
    expect(t).toContain("Worked, Not Booked");
    expect(t).toContain("22 Herringbone Way · Kim Hale — Brian 11:04 AM–1:46 PM · Erik 12:30–5:30 PM");
    expect(html).toContain("border-2 border-dashed border-slate-400");
    expect(t).toContain("Book This Day");
    expect(t).toContain("Open The Job");
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
  });
});
