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

import { JobScheduleControl } from "./job-schedule-control";
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
      "Its own hours: Mon, Sep 28 12:00 PM – 5:00 PM. The time below is the usual hours of its other days; tap a day's block on the schedule to change that day.",
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
    expect(src).toContain('setError(res.error ?? t("jb_daysDidntSave"))');
  });

  it("the page hands it the block on the company's clock", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    // The days as days (never split where one keeps its own hours), and the days that keep their own
    // hours in words (0370): the time control sets the usual hours of the others, and says so.
    expect(page).toMatch(
      /<JobScheduleControl\s+id=\{j\.id\}\s+segments=\{scheduleDays\}\s+ownDays=\{ownDays\.map\(\(o\) => o\.words\)\}\s+block=\{block\}\s+workDay=\{workDay\}\s+plannedMinutes=\{j\.planned_minutes \?\? null\}\s*\/>/,
    );
    expect(page).toContain("const scheduleDays = datesOnly(");
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
    expect(src).toContain("const filled = rangesToSave(next).save;");
    expect(src).toContain('if (rowState(next[i]) === "ready") persist(next);');
    expect(src).not.toMatch(/disabled=\{pending\}/);
  });

  it("only the latest save's answer shows; what was stored replaces the saved rows, a waiting row kept, and a join is said", () => {
    expect(src).toContain("const mine = ++lastSave.current;");
    expect(src).toContain("if (mine !== lastSave.current) return;");
    expect(src).toContain("setRanges((now) => reseedRows(stored, now));");
    expect(src).toContain('setJoined(fillText(t("jb_rangesJoined"), { range: rangeWords(j, (d) => dayWords(d, lang), t("jb_to")) }));');
  });
});
