import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ADD TO SCHEDULE FROM THE SCHEDULE, FOR ANY JOB (Erik, 2026-09-28: "i want to put heringbone on the
 * page for the rest of the day after Seiler but theres no way to add to the schedule from the schedule
 * page unless its already scripted"). An open spot on a day, or the day's "+", opens one sheet: the job
 * (searched, most recent first, by its name with its street and who), the day, the time (the same
 * controls as everywhere, two hours said when nobody chose), who's on it. The office only; every door
 * 44px; no money.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./actions", () => ({ addJobDay: vi.fn() }));

import { AddToScheduleSheet, addableLine, defaultDraft, findAddable, nextDraft, type AddableJob } from "./add-to-schedule-sheet";
import { TimeGrid, slotMinute } from "@/components/time-grid";

const WORK_DAY = { start: "09:00", end: "17:00" };
const team = [
  { id: "p-erik", full_name: "Erik Taylor" },
  { id: "p-brian", full_name: "Brian Cole" },
];
const jobs: AddableJob[] = [
  { id: "j011", name: "Herringbone", status: "in_progress", address: "22 Herringbone Way", city: "Truckee", planned_minutes: null, assigned_to: ["p-erik"], customers: { name: "Kim Hale" } },
  { id: "j060", name: "498 Mil Drae Lane", status: "on_hold", address: "498 Mil Drae Lane", city: "Truckee", planned_minutes: 240, assigned_to: [], customers: { name: "Jackie Burks" } },
  { id: "j061", name: "12 Elm St", status: "to_be_scheduled", address: "12 Elm St", city: "Kings Beach", planned_minutes: 960, assigned_to: [], customers: null, job_number: "J-061" },
];
const doors = (html: string) => html.match(/<(button|a|input)\b[^>]*>/g) ?? [];
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the sheet", () => {
  const html = renderToStaticMarkup(
    createElement(AddToScheduleSheet, { at: { day: "2026-09-28", minute: 720 }, jobs, team, workDay: WORK_DAY, onClose: () => {} }),
  );

  it("opens on the day and the half hour tapped: the job search, the jobs with their street and who, the day, the time", () => {
    const t = text(html);
    expect(t).toContain("Add To Schedule");
    expect(html).toMatch(/<input[^>]*aria-label="Find a job"/);
    expect(t).toContain("Herringbone");
    expect(t).toContain("22 Herringbone Way · Kim Hale");
    // A job named for its street: who, not the street twice.
    expect(t).toContain("498 Mil Drae Lane Jackie Burks");
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2026-09-28"/);
    expect(t).toContain("Mon, Sep 28. The job keeps every other day it has.");
    // Noon, and two hours said as nobody's choice, until a job is picked.
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="12:00"/);
    expect(html).toMatch(/<input[^>]*type="time"[^>]*value="14:00"/);
    expect(t).toContain("12:00 PM – 2:00 PM · 2 hours — change it");
    for (const chip of ["1h", "2h", "4h", "Full Day"]) expect(html).toMatch(new RegExp(`<button[^>]*>${chip}</button>`));
    // A draft: the time controls never say Saving or Saved; the sheet's own button writes.
    expect(t).not.toContain("Saved");
  });

  it("every door is 44px, and Add To Schedule waits for a job", () => {
    // The Modal's own header X is the app's shared chrome, the same on every sheet.
    const ds = doors(html).filter((d) => !d.includes('aria-label="Close"'));
    expect(ds.length).toBeGreaterThan(8);
    for (const d of ds) expect(d, d).toMatch(/\b(min-)?h-11\b/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add To Schedule<\/button>/);
  });

  it("from the day's +: the work day's start", () => {
    const plus = renderToStaticMarkup(createElement(AddToScheduleSheet, { at: { day: "2026-09-28", minute: null }, jobs, team, workDay: WORK_DAY, onClose: () => {} }));
    expect(plus).toMatch(/<input[^>]*type="time"[^>]*value="09:00"/);
  });

  it("no money anywhere in it", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/schedule/add-to-schedule-sheet.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(src).not.toMatch(/\b(prices?|amounts?|totals?|costs?|rates?|bill_rate|pay_rate)\b|formatCurrency|\$\d/i);
  });
});

describe("the sheet's words and search", () => {
  it("a job's line: its street unless its name is the street, and who unless its name says who", () => {
    expect(addableLine(jobs[0])).toBe("22 Herringbone Way · Kim Hale");
    expect(addableLine(jobs[1])).toBe("Jackie Burks");
    expect(addableLine({ name: "Jackie Burks · Panel Upgrade", address: null, customers: { name: "Jackie Burks" } })).toBe("");
  });

  it("search: every word, anywhere in the name, the street, who, the number or the town", () => {
    expect(findAddable(jobs, "herring").map((j) => j.id)).toEqual(["j011"]);
    expect(findAddable(jobs, "jackie 498").map((j) => j.id)).toEqual(["j060"]);
    expect(findAddable(jobs, "J-061").map((j) => j.id)).toEqual(["j061"]);
    expect(findAddable(jobs, "kings").map((j) => j.id)).toEqual(["j061"]);
    expect(findAddable(jobs, "  ").map((j) => j.id)).toEqual(["j011", "j060", "j061"]);
  });

  it("the length a picked job starts with: its size, a day or more the whole work day, nobody's two hours", () => {
    expect(defaultDraft("12:00", null, WORK_DAY)).toEqual({ start: "12:00", end: "14:00", sized: false });
    expect(defaultDraft("12:00", 240, WORK_DAY)).toEqual({ start: "12:00", end: "16:00", sized: true });
    expect(defaultDraft("12:00", 960, WORK_DAY)).toEqual({ start: "12:00", end: "17:00", sized: true });
    expect(defaultDraft("18:00", 960, WORK_DAY)).toEqual({ start: "18:00", end: "19:00", sized: true });
  });

  it("a new start with no length chosen shows the end the save will store (the job's size, not the drawn hours)", () => {
    // Tapped at 10:00, a job sized a day: 10 to closing. Only the Start moves to 11:00: the save sends
    // no length and the writer runs a day's size to closing, so the sheet says 11 to 5, never 11 to 6.
    const base = defaultDraft("10:00", 480, WORK_DAY);
    expect(nextDraft({ now: base, chosen: false, sizeMinutes: 480, workDay: WORK_DAY, patch: { start: "11:00" } })).toEqual({
      hours: { start: "11:00", end: "17:00" },
      chosen: false,
    });
    // Unsized: two hours from the new start; sized under a day: its size.
    expect(nextDraft({ now: { start: "10:00", end: "12:00" }, chosen: false, sizeMinutes: null, workDay: WORK_DAY, patch: { start: "15:30" } })?.hours).toEqual({ start: "15:30", end: "17:30" });
    expect(nextDraft({ now: { start: "10:00", end: "14:00" }, chosen: false, sizeMinutes: 240, workDay: WORK_DAY, patch: { start: "13:00" } })?.hours).toEqual({ start: "13:00", end: "17:00" });
    // A length chosen is the length the save sends: a new start keeps it on the clock.
    const picked = nextDraft({ now: base, chosen: false, sizeMinutes: 480, workDay: WORK_DAY, patch: { length: 120 } });
    expect(picked).toEqual({ hours: { start: "10:00", end: "12:00" }, chosen: true });
    expect(nextDraft({ now: picked!.hours, chosen: true, sizeMinutes: 480, workDay: WORK_DAY, patch: { start: "13:00" } })).toEqual({
      hours: { start: "13:00", end: "15:00" },
      chosen: true,
    });
  });
});

describe("the open spots and the day's +, on the grid", () => {
  const grid = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TimeGrid, {
        days: [
          { dayStr: "2026-09-28", label: "Mon 28" },
          { dayStr: "2026-09-29", label: "Tue 29" },
        ],
        events: [],
        workStartMin: 540,
        workEndMin: 1020,
        tz: "America/Los_Angeles",
        ...extra,
      }),
    );

  it("with the office's add: every column's open time is a door, and each day header carries a 44px +", () => {
    const html = grid({ onSlotTap: () => {}, onDayClick: () => {} });
    expect(html.match(/<button[^>]*aria-label="Add To Schedule, Mon 28"/g)?.length).toBe(2);
    // 44 by 44: tall AND wide, so a thumb aimed at the + never lands on the day's label beside it.
    const plus = html.match(/<button[^>]*aria-label="Add To Schedule, Tue 29"[^>]*>/)?.[0] ?? "";
    expect(plus).toMatch(/class="[^"]*\bmin-h-11\b/);
    expect(plus).toMatch(/class="[^"]*\b(min-)?w-11\b/);
  });

  it("without it (anyone else, /timecards) or while work is armed, no add door at all", () => {
    expect(grid({})).not.toContain("Add To Schedule");
    expect(grid({ onSlotTap: () => {}, placement: { label: "Place 1 here", onPlace: () => {} } })).not.toContain("Add To Schedule");
  });

  it("a tap is floored to the half hour it lands in, never outside the day", () => {
    // The grid's top is 7 AM (the work day's start less two hours); 48px an hour.
    expect(slotMinute(0, 420)).toBe(420);
    expect(slotMinute(5 * 48 + 20, 420)).toBe(720); // 12:25 → 12:00
    expect(slotMinute(5 * 48 + 30, 420)).toBe(750); // 12:37 → 12:30
    expect(slotMinute(10_000, 420)).toBe(1410);
    expect(slotMinute(-20, 420)).toBe(420);
  });

  it("the schedule wires it for the office only, never while armed, and the sheet only renders for the office", () => {
    const view = readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-view.tsx"), "utf8");
    expect(view.match(/onSlotTap=\{canEdit && !target\.armed \? onSlotTap : undefined\}/g)?.length).toBe(2);
    expect(view).toMatch(/\{canEdit && \(\s*<AddToScheduleSheet/);
    expect(view).toMatch(/\{canEdit && !target\.armed && \(\s*<button[\s\S]*?onClick=\{\(\) => onSlotTap\(anchorK, null\)\}/);
    const panel = readFileSync(join(process.cwd(), "src/app/(app)/schedule/calendar-panel.tsx"), "utf8");
    expect(panel).toMatch(/canEdit\s*\?\s*supabase\s*\.from\("jobs"\)\s*\.select\("id, job_number, name, status, address, city, planned_minutes, assigned_to, customers\(name\)"\)\s*\.in\("status", ACTIVE_JOB_STATUSES\)/);
  });
});
