import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB PAGE'S SCHEDULED BOX: THE LENGTH BESIDE THE START (Erik, 2026-09-28: "within the job itself i
 * could only set a start time and no end time"). Its days (the date ranges) and its block: a Start,
 * quick lengths 1h 2h 4h Full Day, and an End, the same control the schedule tile's sheet shows.
 * Rendered on the real component; every door is 44px.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../../schedule/actions", () => ({ setJobScheduleRanges: vi.fn(), setJobTimes: vi.fn() }));

import { ExtendJobPanel, JobScheduleControl } from "./job-schedule-control";
import { readJobBlock } from "@/lib/schedule/job-block";
import { tzDateTimeUtc } from "@/lib/tz";
import { LangProvider } from "@/components/lang-provider";

const LA = "America/Los_Angeles";
const WORK_DAY = { start: "09:00", end: "17:00" };
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA);
const doors = (html: string) => html.match(/<(button|a|input)\b[^>]*>/g) ?? [];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

const box = (p: { start: string | null; end: string | null; planned?: number | null; segments?: { start_date: string; end_date: string }[] }) =>
  renderToStaticMarkup(
    createElement(JobScheduleControl, {
      id: "j1",
      segments: p.segments ?? [],
      block: readJobBlock({ scheduledStart: p.start, scheduledEnd: p.end, plannedMinutes: p.planned ?? null, tz: LA, workDay: WORK_DAY }),
      workDay: WORK_DAY,
    }),
  );

describe("the job page's Scheduled box: the length beside the start", () => {
  it("a Start, an End and 1h 2h 4h Full Day, all 44px, under the days", () => {
    const html = box({ start: at("2026-09-28", "10:00"), end: at("2026-09-28", "12:00"), segments: [{ start_date: "2026-09-28", end_date: "2026-09-28" }] });
    expect(html).toMatch(/aria-label="Start time"/);
    expect(html).toMatch(/aria-label="End time"/);
    for (const chip of ["1h", "2h", "4h", "Full Day"]) expect(html).toMatch(new RegExp(`<button[^>]*>${chip}</button>`));
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
    expect(text(html)).toContain("Add Date Range");
    expect(text(html)).toContain("10:00 AM – 12:00 PM · 2 hours — change it");
  });

  it("a size somebody chose reads as chosen", () => {
    const html = box({ start: at("2026-09-28", "10:00"), end: at("2026-09-28", "14:00"), planned: 240, segments: [{ start_date: "2026-09-28", end_date: "2026-09-28" }] });
    expect(text(html)).toContain("10:00 AM – 2:00 PM · 4 hours");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>4h<\/button>/);
  });

  it("a day that keeps its own hours (0370) is said: the time here is the usual hours of the other days", () => {
    const html = renderToStaticMarkup(
      createElement(JobScheduleControl, {
        id: "j011",
        segments: [{ start_date: "2026-09-24", end_date: "2026-09-28" }],
        ownDays: ["Mon, Sep 28 12:00 PM – 5:00 PM"],
        block: readJobBlock({ scheduledStart: at("2026-09-24", "09:00"), scheduledEnd: at("2026-09-28", "17:00"), plannedMinutes: null, tz: LA, workDay: WORK_DAY }),
        workDay: WORK_DAY,
      }),
    );
    expect(text(html)).toContain(
      "Its own hours: Mon, Sep 28 12:00 PM – 5:00 PM. The time below is the usual hours of its other days; each date range above can keep hours of its own.",
    );
    expect(text(box({ start: at("2026-09-28", "10:00"), end: at("2026-09-28", "12:00") }))).not.toContain("Its own hours");
  });

  it("several days (a second date range): the End and the lengths stay, and the words say each day (Erik, 2026-09-29)", () => {
    const html = box({ start: at("2026-09-28", "10:00"), end: at("2026-09-30", "12:00"), segments: [{ start_date: "2026-09-28", end_date: "2026-09-28" }, { start_date: "2026-09-30", end_date: "2026-09-30" }] });
    expect(html).toMatch(/aria-label="Start time"/);
    expect(html).toMatch(/aria-label="End time"/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>2h<\/button>/);
    expect(text(html)).toContain("10:00 AM – 12:00 PM each day through Wed, Sep 30 · 2 hours — change it");
    expect(text(html)).not.toContain("full days");
  });

  it("Full Day on several days reads as a full day each day, with Full Day pressed (the size the chip stores is a working day)", () => {
    // What the Full Day chip stores on Erik's two-day job (planJobTimes: 9:00 first day, 5:00 PM last day, planned 480).
    const html = box({ start: at("2026-09-28", "09:00"), end: at("2026-09-30", "17:00"), planned: 480, segments: [{ start_date: "2026-09-28", end_date: "2026-09-28" }, { start_date: "2026-09-30", end_date: "2026-09-30" }] });
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Full Day<\/button>/);
    expect(html).not.toMatch(/<button[^>]*aria-pressed="true"[^>]*>2h<\/button>/);
    expect(text(html)).toContain("9:00 AM – 5:00 PM each day through Wed, Sep 30 · All day");
  });

  it("no day yet: it says what a day will bring", () => {
    expect(text(box({ start: null, end: null }))).toContain("lands as 2 hours");
  });

  it("the days come from the company's clock, not the phone's (a 5 PM Pacific end is still the 28th)", () => {
    // 5 PM Pacific is 00:00Z the next day: a runtime-zone read (the old toLocalDate) put the end on
    // the 29th wherever the clock isn't Pacific (a UTC server, CI).
    const html = box({ start: at("2026-09-28", "10:00"), end: at("2026-09-28", "17:00") });
    const dates = (html.match(/<input[^>]*type="date"[^>]*>/g) ?? []).map((t) => /value="([^"]*)"/.exec(t)?.[1]);
    expect(dates).toEqual(["2026-09-28", "2026-09-28"]);
  });
});

describe("where each edit goes (source)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-schedule-control.tsx"), "utf8");

  it("a time edit goes through setJobTimes (fresh days, worked days kept, start + end + length together)", () => {
    expect(src).toContain('await setJobTimes(id, "start" in patch ? { start: patch.start } : { length: patch.length })');
  });

  it("a day edit keeps the job's start and length, and a refused save is said in words", () => {
    expect(src).toContain("await setJobScheduleRanges(id, filled);");
    // cn-v1190: one save for a day edit, a row's hours and Extend Job; the refusal is said under the
    // rows unless the caller (a row's time entry, Extend Job's door) says it.
    expect(src).toContain('const words = res.error ?? t("jb_daysDidntSave");');
    expect(src).toContain("if (!quiet) setError(words);");
  });

  it("the page hands it the block on the company's clock", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    // The days as days (never split where one keeps its own hours), and the days that keep their own
    // hours in words (0370): the time control sets the usual hours of the others, and says so.
    expect(page).toMatch(
      /<JobScheduleControl\s+id=\{j\.id\}\s+segments=\{scheduleRows\}\s+ownDays=\{ownDays\.map\(\(o\) => o\.words\)\}\s+block=\{block\}\s+workDay=\{workDay\}\s+plannedMinutes=\{j\.planned_minutes \?\? null\}\s+status=\{j\.status \?\? null\}\s+today=\{todayStrInTz\(tz\)\}\s+daysUnread=\{!!scheduleSegmentsErr\}\s*\/>/,
    );
    // The crew's words still read the days as days; the editor's rows carry each range's hours (cn-v1190).
    expect(page).toContain("const scheduleDays = datesOnly(");
    expect(page).toContain("const scheduleRows = rowsOfSegments(segRows)");
    // The size reaches the Start box, so the end it predicts is the end the writer keeps.
    expect(src).toContain("plannedMinutes={plannedMinutes}");
    expect(page).toMatch(/const block = readJobBlock\(\{\s*scheduledStart: j\.scheduled_start \?\? null,\s*scheduledEnd: j\.scheduled_end \?\? null,\s*plannedMinutes: j\.planned_minutes \?\? null,\s*tz,\s*workDay,/);
  });

  it("the crew's Scheduled line reads start AND end on several days too ('10:00 AM – 12:00 PM each day'), never just a start", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    const from = page.indexOf("const scheduleText");
    const line = page.slice(from, page.indexOf("})();", from));
    expect(line).not.toContain("`starts ${hmWords(block.startHm)}`");
    expect(line).toContain('`${hmWords(block.startHm)} – ${hmWords(block.endHm)}${block.multiDay ? ` ${t("jb_eachDay")}` : ""}`');
  });

  it("the job page's Add Time Entry hands the clock-out sheet the work day's end (End Of Work Day on a forgotten punch)", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    const from = page.indexOf("<AddTimeEntry");
    expect(page.slice(from, page.indexOf("/>", from))).toContain("workDayEnd={workDay.end}");
  });
});

/**
 * A RANGE ROW WAITS FOR BOTH ITS DAYS (cn-v1189; the owner: "Add date range is not responding", "Add
 * date range should wait and require a range before auto saving right now it won't even let me add the
 * second day"). J-904, Larkspur, Mon Oct 5, and a second row with one day picked.
 */
describe("a range row waits for both its days", () => {
  const MON = { start_date: "2026-10-05", end_date: "2026-10-05" };
  const row = (seg: { start_date: string; end_date: string }, lang: "en" | "es" = "en") =>
    renderToStaticMarkup(
      createElement(
        LangProvider,
        { lang } as never,
        createElement(JobScheduleControl, {
          id: "j904",
          segments: [MON, seg],
          block: readJobBlock({ scheduledStart: at("2026-10-05", "09:00"), scheduledEnd: at("2026-10-05", "17:00"), plannedMinutes: 480, tz: LA, workDay: WORK_DAY }),
          workDay: WORK_DAY,
        }),
      ),
    );

  it("a first day only: it says what it waits for, with One Day at 44px and its remove control; Add Date Range waits", () => {
    const html = row({ start_date: "2026-10-08", end_date: "" });
    expect(text(html)).toContain("Pick the last day, or tap One Day.");
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*"[^>]*>One Day<\/button>/);
    expect(html.match(/aria-label="Remove date range"/g)?.length).toBe(2);
    expect(text(html)).not.toContain("Add Date Range");
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
  });

  it("a last day only: Pick the first day.", () => {
    const html = row({ start_date: "", end_date: "2026-10-08" });
    expect(text(html)).toContain("Pick the first day.");
    expect(html).not.toContain(">One Day<");
    expect(text(html)).not.toContain("Add Date Range");
  });

  it("in Spanish", () => {
    expect(text(row({ start_date: "2026-10-08", end_date: "" }, "es"))).toContain("Elige el último día, o toca Un Solo Día.");
    expect(row({ start_date: "2026-10-08", end_date: "" }, "es")).toMatch(/>Un Solo Día<\/button>/);
    expect(text(row({ start_date: "", end_date: "2026-10-08" }, "es"))).toContain("Elige el primer día.");
  });

  it("both rows ready: no waiting words, and Add Date Range is drawn", () => {
    const html = row({ start_date: "2026-10-08", end_date: "2026-10-09" });
    expect(text(html)).toContain("Add Date Range");
    expect(text(html)).not.toContain("Pick the");
  });

  it("no date box is disabled, by a save or anything else", () => {
    const html = row({ start_date: "2026-10-08", end_date: "" });
    for (const box of html.match(/<input[^>]*type="date"[^>]*>/g) ?? []) expect(box).not.toMatch(/\sdisabled(=|\s|\/|>)/);
  });
});

describe("when a save happens, and whose answer shows (source)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-schedule-control.tsx"), "utf8");

  it("only the ready rows are sent, and a date edit saves only once its row is ready", () => {
    expect(src).toContain("const filled = rowsToSend(next);");
    expect(src).toContain('if (rowState(next[i]) === "ready") persist(next);');
    expect(src).not.toMatch(/disabled=\{pending\}/);
  });

  it("only the latest save's answer shows; what was stored replaces the saved rows, a waiting row kept, and a join is said", () => {
    expect(src).toContain("const mine = ++lastSave.current;");
    expect(src).toContain("if (mine !== lastSave.current) return { ok: true };");
    expect(src).toContain("setRanges((now) => reseedRows(stored, now));");
    expect(src).toContain('setJoined(fillText(t("jb_rangesJoined"), { range: rangeWords(j, (d) => dayWords(d, lang), t("jb_to")) }));');
  });
});

/**
 * EACH DATE RANGE HAS HOURS OF ITS OWN, AND EXTEND JOB (cn-v1190; the owner: "add a date range to have
 * its own time entry too that defaults to the hours inputed for the first date range so i can change them
 * if i want to", "lets call it Extend Job with date and time selector defaulted to today with the same
 * hours"). J-907, Larkspur: Mon Oct 5 on the usual hours (9 to 5), Tue Oct 6 with its own 9 to 1.
 */
describe("each range's own time entry, and the Extend Job door", () => {
  const OWN = { start: "09:00", end: "13:00" };
  const SEGS = [
    { start_date: "2026-10-05", end_date: "2026-10-05", hours: null },
    { start_date: "2026-10-06", end_date: "2026-10-06", hours: OWN },
  ];
  const draw = (p: { status?: string | null; lang?: "en" | "es"; segments?: typeof SEGS } = {}) =>
    renderToStaticMarkup(
      createElement(
        LangProvider,
        { lang: p.lang ?? "en" } as never,
        createElement(JobScheduleControl, {
          id: "j907",
          segments: p.segments ?? SEGS,
          block: readJobBlock({ scheduledStart: at("2026-10-05", "09:00"), scheduledEnd: at("2026-10-06", "17:00"), plannedMinutes: 480, tz: LA, workDay: WORK_DAY }),
          workDay: WORK_DAY,
          plannedMinutes: 480,
          status: p.status === undefined ? "scheduled" : p.status,
          today: "2026-10-05",
        }),
      ),
    );
  const times = (html: string) => (html.match(/<input[^>]*type="time"[^>]*>/g) ?? []).map((b) => /value="([^"]*)"/.exec(b)?.[1]);

  it("every row draws the same time control, opening on its own hours or the job's usual hours, and says which", () => {
    const html = draw();
    // Row 1 (usual), row 2 (its own), then the job's usual hours below.
    expect(times(html)).toEqual(["09:00", "17:00", "09:00", "13:00", "09:00", "17:00"]);
    expect(text(html)).toContain("The job's usual hours.");
    expect(text(html)).toContain("This date range's own hours.");
    expect(html).toContain('id="job-j907-range-0-start"');
    expect(html).toContain('id="job-j907-range-1-start"');
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
  });

  it("in Spanish", () => {
    const html = draw({ lang: "es" });
    expect(text(html)).toContain("El horario habitual del trabajo.");
    expect(text(html)).toContain("Horario propio de este rango de fechas.");
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*"[^>]*>.*Extender el Trabajo<\/button>/);
  });

  it("Extend Job is drawn for a job in flight with a day, never on hold, finished or cancelled", () => {
    for (const s of ["to_be_scheduled", "scheduled", "in_progress"]) expect(text(draw({ status: s }))).toContain("Extend Job");
    for (const s of ["on_hold", "complete", "cancelled", null]) expect(text(draw({ status: s }))).not.toContain("Extend Job");
    // No day saved (a row still waiting for its last day): nothing to extend yet.
    expect(text(draw({ segments: [{ start_date: "2026-10-08", end_date: "", hours: null }] }))).not.toContain("Extend Job");
    expect(draw()).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*"[^>]*>.*Extend Job<\/button>/);
  });

  const panel = (lang: "en" | "es", p: { hours?: { start: string; end: string } | null; error?: string | null } = {}) =>
    renderToStaticMarkup(
      createElement(
        LangProvider,
        { lang } as never,
        createElement(ExtendJobPanel, {
          id: "j907",
          day: "2026-10-07",
          hours: p.hours ?? null,
          today: "2026-10-05",
          block: readJobBlock({ scheduledStart: at("2026-10-05", "09:00"), scheduledEnd: at("2026-10-06", "17:00"), plannedMinutes: 480, tz: LA, workDay: WORK_DAY }),
          workDay: WORK_DAY,
          plannedMinutes: 480,
          error: p.error ?? null,
          onDay: () => undefined,
          saveHours: async () => ({ ok: true }),
          onSave: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );

  it("the door: ONE day box from today, ONE time entry on the last range's hours, Extend Job and Cancel, all 44px", () => {
    const html = panel("en", { hours: OWN });
    const dayBoxes = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    expect(dayBoxes).toHaveLength(1);
    expect(dayBoxes[0]).toContain('value="2026-10-07"');
    expect(dayBoxes[0]).toContain('min="2026-10-05"');
    expect(dayBoxes[0]).toContain('aria-label="Day to add"');
    expect(times(html)).toEqual(["09:00", "13:00"]);
    expect(html).toMatch(/<button[^>]*>Extend Job<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(text(html)).toContain("One more day, with the hours of its last date range.");
    for (const d of doors(html)) expect(d, d).toMatch(/\b(min-)?h-11\b/);
    // The usual hours when the last range has none.
    expect(times(panel("en"))).toEqual(["09:00", "17:00"]);
  });

  it("the door in Spanish, and its refusal said", () => {
    const html = panel("es", { error: "El trabajo ya tiene mié, 7 oct: elige otro día." });
    expect(html).toMatch(/<button[^>]*>Extender el Trabajo<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancelar<\/button>/);
    expect(html).toContain('aria-label="Día que se agrega"');
    expect(text(html)).toContain("Un día más, con el horario de su último rango de fechas.");
    expect(text(html)).toContain("El trabajo ya tiene mié, 7 oct: elige otro día.");
  });
});

/**
 * FIXES TO cn-v1190 (skeptic #91). J-908, Tupelo Panel: Mon Oct 5 to Wed Oct 7 on the usual 9 to 5.
 */
describe("a lone row draws no second time entry (S3)", () => {
  const draw = (segments: { start_date: string; end_date: string; hours: { start: string; end: string } | null }[], lang: "en" | "es" = "en") =>
    renderToStaticMarkup(
      createElement(
        LangProvider,
        { lang } as never,
        createElement(JobScheduleControl, {
          id: "j908",
          segments,
          block: readJobBlock({ scheduledStart: at("2026-10-05", "09:00"), scheduledEnd: at("2026-10-07", "17:00"), plannedMinutes: 480, tz: LA, workDay: WORK_DAY }),
          workDay: WORK_DAY,
          plannedMinutes: 480,
          status: "scheduled",
          today: "2026-10-05",
        }),
      ),
    );
  const times = (html: string) => (html.match(/<input[^>]*type="time"[^>]*>/g) ?? []).map((b) => /value="([^"]*)"/.exec(b)?.[1]);

  it("one row with no hours of its own: its date boxes, and the usual-hours block below is its time entry", () => {
    const html = draw([{ start_date: "2026-10-05", end_date: "2026-10-07", hours: null }]);
    expect(times(html)).toEqual(["09:00", "17:00"]);
    expect(html).not.toContain('id="job-j908-range-0-start"');
    expect(text(html)).not.toContain("The job's usual hours.");
    expect(text(html)).not.toContain("This date range's own hours.");
  });

  it("one row WITH hours of its own draws its time entry, and says so", () => {
    const html = draw([{ start_date: "2026-10-05", end_date: "2026-10-07", hours: { start: "07:00", end: "11:00" } }]);
    expect(times(html)).toEqual(["07:00", "11:00", "09:00", "17:00"]);
    expect(text(html)).toContain("This date range's own hours.");
  });

  it("two rows each draw a time entry, the usual one too", () => {
    const html = draw([
      { start_date: "2026-10-05", end_date: "2026-10-06", hours: null },
      { start_date: "2026-10-08", end_date: "2026-10-08", hours: null },
    ]);
    expect(times(html)).toEqual(["09:00", "17:00", "09:00", "17:00", "09:00", "17:00"]);
    expect(html).toContain('id="job-j908-range-1-start"');
    expect(text(draw([{ start_date: "2026-10-05", end_date: "2026-10-06", hours: null }, { start_date: "2026-10-08", end_date: "2026-10-08", hours: null }], "es"))).toContain(
      "El horario habitual del trabajo.",
    );
  });
});

describe("a failed read of the job's days saves nothing (A-5)", () => {
  const draw = (lang: "en" | "es") =>
    renderToStaticMarkup(
      createElement(
        LangProvider,
        { lang } as never,
        createElement(JobScheduleControl, {
          id: "j909",
          segments: [],
          daysUnread: true,
          block: readJobBlock({ scheduledStart: at("2026-10-05", "09:00"), scheduledEnd: at("2026-10-07", "17:00"), plannedMinutes: 480, tz: LA, workDay: WORK_DAY }),
          workDay: WORK_DAY,
          plannedMinutes: 480,
          status: "scheduled",
          today: "2026-10-05",
        }),
      ),
    );

  it("one sentence in place of the rows, Add Date Range and Extend Job; the usual hours stay", () => {
    const html = draw("en");
    expect(text(html)).toContain("This job's days couldn't be read just now. Reload the page.");
    expect(html).not.toMatch(/type="date"/);
    expect(text(html)).not.toContain("Add Date Range");
    expect(text(html)).not.toContain("Extend Job");
    expect(html).toContain('id="job-j909-start"');
  });

  it("in Spanish", () => {
    const html = draw("es");
    expect(text(html)).toContain("No se pudieron leer los días de este trabajo. Vuelve a cargar la página.");
    expect(html).not.toMatch(/type="date"/);
    expect(text(html)).not.toContain("Extender el Trabajo");
  });

  it("the page keeps the read's error and hands the control the flag", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toContain("{ data: scheduleSegments, error: scheduleSegmentsErr },");
    expect(page).toContain("daysUnread={!!scheduleSegmentsErr}");
  });
});

describe("a row's time entry is never disabled while a save runs (A-4)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-schedule-control.tsx"), "utf8");
  const btc = readFileSync(join(process.cwd(), "src/components/block-time-controls.tsx"), "utf8");

  it("the rows' time entries are live; the job's usual-hours block waits as before", () => {
    // Every box and chip of the shared control honours `live`.
    expect(btc.match(/disabled=\{[^}]*\}/g)).toEqual(Array(4).fill("disabled={pending && !live}"));
    expect(btc).toContain("live = false,");
    const row = src.slice(src.indexOf("save={(patch) => saveRowHours(i, patch)}") - 900, src.indexOf("save={(patch) => saveRowHours(i, patch)}") + 400);
    expect(row).toMatch(/<BlockTimeControls[\s\S]*\blive\b[\s\S]*\/>/);
    const usual = src.slice(src.indexOf("save={saveTimes}") - 600, src.indexOf("save={saveTimes}") + 200);
    expect(usual).not.toMatch(/\blive\b/);
  });
});

describe("hours ride only on a row the person touched (S1, source)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-schedule-control.tsx"), "utf8");

  it("the save sends rowsToSend; a row's hours, Extend Job and a new row are touched; the flag clears only on the winning re-seed", () => {
    expect(src).toContain("const filled = rowsToSend(next);");
    expect(src).toContain("{ ...r, hours, touched: true }");
    expect(src).toContain("const add: RangeRow = { start: extend.day, end: extend.day, hours: extend.hours, touched: true };");
    expect(src).toContain('setRanges((r) => [...r, { start: "", end: "", hours: null, touched: true }]);');
    // A superseded save returns BEFORE the re-seed: its rows stay touched for the later save.
    const latest = src.indexOf("if (mine !== lastSave.current) return { ok: true };");
    const reseed = src.indexOf("setRanges((now) => reseedRows(stored, now));");
    expect(latest).toBeGreaterThan(0);
    expect(reseed).toBeGreaterThan(latest);
  });
});

describe("a range's hours and Extend Job go through the one save (source)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-schedule-control.tsx"), "utf8");

  it("a row's time entry sets that row's hours and saves it only once it is ready; refused, the hours go back", () => {
    expect(src).toContain("save={(patch) => saveRowHours(i, patch)}");
    expect(src).toContain("const hours = rowHoursAfter({ row, usual, plannedMinutes, patch, wd });");
    expect(src).toContain('if (rowState(next[i]) !== "ready") return { ok: true };');
    expect(src).toContain("const res = await save(next, true);");
    expect(src).toContain("draft={state !== \"ready\"}");
  });

  it("Extend Job: refused in one sentence for a day the job has, then the same save, and the door closes", () => {
    expect(src).toContain("const why = extendRefusal(ranges, extend.day, todayYmd);");
    expect(src).toContain('fillText(t("jb_extendHasDay"), { day: dayWords(extend.day, lang) })');
    expect(src).toContain("setExtend(extendDefaults(ranges, todayYmd));");
    expect(src).toMatch(/const res = await save\(next, true\);\s+extendBusy\.current = false;[\s\S]*?setExtend\(null\);/);
    expect(src).toContain('const EXTENDABLE = ["to_be_scheduled", "scheduled", "in_progress"];');
    // Never a Modal: the door is drawn in place.
    expect(src).not.toMatch(/<Modal\b/);
  });
});
