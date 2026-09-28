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

  it("several days: the start of the first, full days, and no lengths to pick", () => {
    const html = box({ start: at("2026-09-28", "10:00"), end: at("2026-09-30", "17:00"), segments: [{ start_date: "2026-09-28", end_date: "2026-09-30" }] });
    expect(html).toMatch(/aria-label="Start time"/);
    expect(html).not.toMatch(/aria-label="End time"/);
    expect(html).not.toMatch(/>2h</);
    expect(text(html)).toContain("full days through Wed, Sep 30");
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
    expect(src).toContain('setError(res.error ?? "The days didn\'t save. Try again.")');
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
});
