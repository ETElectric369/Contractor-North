import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * THE DOOR ON EVERY FORM THAT ADDS HOURS (the duplicate punches, 2026-09-26). Before the office
 * types a person's day, the form shows what that person already has on it, and a punch on no job
 * gets "Put This On <job>", keeping its clock times. And one tap is one entry: the forms cannot
 * send a save twice.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("./actions", () => ({
  shiftsOnDay: vi.fn(async () => ({ ok: true, shifts: [] })),
  putShiftOnJob: vi.fn(async () => ({ ok: true })),
  takeShiftOffJob: vi.fn(async () => ({ ok: true })),
}));

import { SameDayShiftsList, notCarriedWords } from "./same-day-shifts";
import type { DayShift } from "./actions";

const TZ = "America/Los_Angeles";
const punch: DayShift = {
  id: "punch",
  clockIn: "2026-09-11T17:31:00Z",
  clockOut: "2026-09-12T01:57:00Z",
  hours: 8.43,
  jobId: null,
  jobLabel: null,
  jobCode: null,
  noJob: true,
  billedBy: null,
};
const billed: DayShift = {
  id: "typed",
  clockIn: "2026-09-11T18:00:00Z",
  clockOut: "2026-09-12T02:30:00Z",
  hours: 8.5,
  jobId: "j28",
  jobLabel: "85 Whitney",
  jobCode: null,
  noJob: false,
  billedBy: "INV-081",
};
const render = (shifts: DayShift[], forJob: { id: string; label: string } | null) =>
  renderToStaticMarkup(
    createElement(SameDayShiftsList, { data: { ok: true, name: "Brian Taylor", tz: TZ, shifts, forJob }, date: "2026-09-11" }),
  );

describe("the day's shifts, above the form", () => {
  it("a punch on no job offers Put This On <the form's job>, with its own clock times", () => {
    const html = render([punch], { id: "j28", label: "85 Whitney" });
    expect(html).toContain("Brian already has a shift on Fri, Sep 11");
    expect(html).toContain("10:31 AM to 6:57 PM · 8.43 h");
    expect(html).toContain("No job");
    expect(html).toContain(">Put This On 85 Whitney</button>");
    expect(html).toContain("Put it on 85 Whitney instead of adding the hours again.");
  });

  it("with no job picked yet, the punch is shown and the form says to pick the job; there is no blind button", () => {
    const html = render([punch], null);
    expect(html).not.toContain("Put This On");
    expect(html).toContain("Pick the job above to put it there instead of adding the hours again.");
    expect(html).toContain('href="/timecards?entry=punch"');
  });

  it("a shift already on a job (and billed) is named with its job and invoice, and opens on Timecards", () => {
    const html = render([billed], { id: "j28", label: "85 Whitney" });
    expect(html).toContain("85 Whitney · on INV-081");
    expect(html).not.toContain("Put This On");
    expect(html).toContain("Open That Shift");
    expect(html).toContain("Hours that overlap these would be counted twice.");
  });

  it("an empty day renders nothing at all", () => {
    expect(render([], { id: "j28", label: "85 Whitney" })).toBe("");
  });
});

describe("Put This On moves the punch only, and the form says what it typed that the punch didn't get", () => {
  it("names each field typed, and nothing when nothing was", () => {
    expect(notCarriedWords({ miles: 12, lunch: true, code: "ROUGH", rate: 30, notes: "panel" })).toBe(
      "Not added to that shift: 12 miles, the lunch, code ROUGH, the rate and the notes typed on the form. Open it to add them.",
    );
    expect(notCarriedWords({ miles: 12 })).toBe("Not added to that shift: 12 miles typed on the form. Open it to add that.");
    expect(notCarriedWords({ miles: 0, lunch: false, code: "", rate: 0, notes: "  " })).toBeNull();
  });

  it("both forms say it when the door closes them", () => {
    const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    for (const rel of ["./add-entry-button.tsx", "../jobs/[id]/job-add-time.tsx"]) {
      const s = src(rel);
      expect(s).toContain("onPlaced={(_sentence, shift) => {");
      expect(s).toContain("notCarriedWords({ miles, lunch: tookLunch,");
      expect(s).toContain('router.push(`/timecards?entry=${shift.id}`)');
    }
  });
});

describe("one tap, one entry", () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  for (const [name, rel] of [
    ["Add Entry (Timecards)", "./add-entry-button.tsx"],
    ["Add Time Entry (the job)", "../jobs/[id]/job-add-time.tsx"],
  ] as const) {
    it(`${name}: a second tap before the first save answers is dropped, and the day's shifts are shown`, () => {
      const s = src(rel);
      // The ref is checked and set in the same tick as the tap, and released only when the save answers.
      expect(s).toMatch(/if \(inFlight\.current \|\| pending\) return;/);
      expect(s).toContain("inFlight.current = true;");
      expect(s).toMatch(/finally \{\s*inFlight\.current = false;/);
      // Save greys out while it works.
      expect(s).toContain("saving={pending}");
      // The door.
      expect(s).toContain("<SameDayShifts");
      expect(s).toContain("setClashId(res.clash?.id ?? null)");
    });
  }
  it("Log Hours on the job shows the day's shifts too", () => {
    expect(src("../jobs/[id]/job-time-button.tsx")).toContain("<SameDayShifts");
  });
});
