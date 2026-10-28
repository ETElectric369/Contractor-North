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

import { SameDayShiftsList, notCarriedWords, shiftLine } from "./same-day-shifts";
import type { DayShift } from "./actions";
import { dict } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";

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
  jobLabel: "41 Larkspur",
  jobCode: null,
  noJob: false,
  billedBy: "INV-081",
};
const render = (shifts: DayShift[], forJob: { id: string; label: string } | null, offThatDay = false) =>
  renderToStaticMarkup(
    createElement(SameDayShiftsList, {
      data: { ok: true, name: "Brian Taylor", tz: TZ, shifts, forJob, scheduledJob: null, offThatDay },
      date: "2026-09-11",
    }),
  );

describe("the day's shifts, above the form", () => {
  it("a punch on no job offers Put This On <the form's job>, with its own clock times", () => {
    const html = render([punch], { id: "j28", label: "41 Larkspur" });
    expect(html).toContain("Brian already has a shift on Fri, Sep 11");
    expect(html).toContain("10:31 AM to 6:57 PM · 8.43 h");
    expect(html).toContain("No job");
    expect(html).toContain(">Put This On 41 Larkspur</button>");
    expect(html).toContain("Put it on 41 Larkspur instead of adding the hours again.");
  });

  it("a punch STILL RUNNING on no job gets Put This On <job> too (putShiftOnJob takes an open row: 'running since … is on <job> now')", () => {
    const running: DayShift = { ...punch, id: "running", clockOut: null, hours: 0 };
    const html = render([running], { id: "j28", label: "41 Larkspur" });
    expect(html).toContain("since 10:31 AM, still on the clock");
    expect(html).toContain("No job");
    expect(html).toContain(">Put This On 41 Larkspur</button>");
    // The server marks it the door's kind whether it is closed or still running.
    const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
    expect(actions).toContain("noJob: !r.job_id && !code,");
    expect(actions).not.toContain("noJob: !!r.clock_out && !r.job_id && !code,");
    const refusal = readFileSync(new URL("../../../lib/overlap-refusal.ts", import.meta.url), "utf8");
    expect(refusal).toContain("noJob: !clash.job_id && !code,");
  });

  it("with no job picked yet, the punch is shown and the form says to pick the job; there is no blind button", () => {
    const html = render([punch], null);
    expect(html).not.toContain("Put This On");
    // Add Time Entry on Timecards is the one form with no job yet, and its Job field is above the list.
    expect(html).toContain("Pick the job above to put it there instead of adding the hours again.");
    expect(html).toContain('href="/timecards?entry=punch"');
  });

  it("a day the office marked this person off says so, with or without shifts on it", () => {
    expect(render([], { id: "j28", label: "41 Larkspur" }, true)).toContain("Marked off that day on the schedule.");
    const withShift = render([billed], { id: "j28", label: "41 Larkspur" }, true);
    expect(withShift).toContain("Marked off that day on the schedule.");
    expect(withShift).toContain("41 Larkspur · on INV-081");
    expect(render([billed], { id: "j28", label: "41 Larkspur" })).not.toContain("Marked off");
  });

  it("a shift already on a job (and billed) is named with its job and invoice, and opens on Timecards", () => {
    const html = render([billed], { id: "j28", label: "41 Larkspur" });
    expect(html).toContain("41 Larkspur · on INV-081");
    expect(html).not.toContain("Put This On");
    expect(html).toContain("Open That Shift");
    expect(html).toContain("Hours that overlap these would be counted twice.");
  });

  it("an empty day renders nothing at all", () => {
    expect(render([], { id: "j28", label: "41 Larkspur" })).toBe("");
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

  it("Add Time Entry, the one add-hours form, says it when the door closes it (only lunch and a code can be typed on it now)", () => {
    const s = readFileSync(new URL("../timecards/add-time-entry.tsx", import.meta.url), "utf8");
    expect(s).toContain("onPlaced={(_sentence, shift) => {");
    expect(s).toContain("notCarriedWords({ lunch: tookLunch, code:");
    expect(s).toContain('router.push(`/timecards?entry=${shift.id}`)');
  });
});

describe("the day's shifts in Spanish (cn-v1138): the list reads the person's language, the pure words take it", () => {
  const renderEs = (shifts: DayShift[], forJob: { id: string; label: string } | null, offThatDay = false) =>
    renderToStaticMarkup(
      createElement(LangProvider, {
        lang: "es",
        children: createElement(SameDayShiftsList, {
          data: { ok: true, name: "Brian Taylor", tz: TZ, shifts, forJob, scheduledJob: null, offThatDay },
          date: "2026-09-11",
        }),
      }),
    );

  it("a punch on no job: the headline, the day and clock words, the door and the sentence under it are Spanish", () => {
    const html = renderEs([punch], { id: "j28", label: "41 Larkspur" });
    expect(html).toContain("Brian ya tiene un turno el vie, 11");
    expect(html).toMatch(/10:31 a\.\s?m\. a 6:57 p\.\s?m\. · 8\.43 h/);
    expect(html).toContain("Sin trabajo");
    expect(html).toContain(">Poner Esto En 41 Larkspur</button>");
    expect(html).toContain("Ponlo en 41 Larkspur en vez de agregar las horas otra vez.");
    expect(html).not.toContain("already has");
    expect(html).not.toContain("Put This On");
  });

  it("two shifts, one billed: Spanish count, 'on INV' and the Open That Shift door; a day marked off says so in Spanish", () => {
    const html = renderEs([punch, billed], null, true);
    expect(html).toContain("Brian ya tiene 2 turnos el vie, 11");
    expect(html).toContain("41 Larkspur · en INV-081");
    expect(html).toContain(">Abrir Ese Turno</a>");
    expect(html).toContain("Marcado libre ese día en el calendario.");
    expect(html).toContain("Elige el trabajo arriba para ponerlo ahí en vez de agregar las horas otra vez.");
  });

  it("shiftLine and notCarriedWords take the language; with none they are English, byte for byte as before", () => {
    expect(shiftLine(punch, TZ, "es").when).toMatch(/^10:31 a\.\s?m\. a 6:57 p\.\s?m\. · 8\.43 h$/);
    expect(shiftLine(punch, TZ, "es").where).toBe("Sin trabajo");
    expect(shiftLine({ ...punch, clockOut: null }, TZ, "es").when).toMatch(/^desde 10:31 a\.\s?m\., todavía en el reloj$/);
    expect(shiftLine(billed, TZ, "es").where).toBe("41 Larkspur · en INV-081");
    expect(shiftLine(punch, TZ)).toEqual({ when: "10:31 AM to 6:57 PM · 8.43 h", where: "No job" });
    expect(shiftLine(punch, TZ)).toEqual(shiftLine(punch, TZ, "en"));
    expect(notCarriedWords({ miles: 12, lunch: true, code: "ROUGH", rate: 30, notes: "panel" }, "es")).toBe(
      "No se agregó a ese turno: 12 millas, el almuerzo, código ROUGH, la tarifa y las notas escrito en el formulario. Ábrelo para agregar eso.",
    );
    expect(notCarriedWords({ miles: 12 }, "es")).toBe("No se agregó a ese turno: 12 millas escrito en el formulario. Ábrelo para agregar eso.");
    expect(notCarriedWords({ miles: 12 })).toBe(notCarriedWords({ miles: 12 }, "en"));
    // The English the office reads is what it was.
    expect(dict("en").tc_offThatDay).toBe("Marked off that day on the schedule.");
    expect(dict("en").tc_putThisOn).toBe("Put This On {job}");
    expect(dict("en").tc_alreadyHasOne).toBe("{name} already has a shift on {day}");
  });
});

describe("one tap, one entry", () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  it("Add Time Entry (Timecards and the job's Time tab): a second tap before the first save answers is dropped, and the day's shifts are shown", () => {
    const s = src("../timecards/add-time-entry.tsx");
    // The ref is checked and set in the same tick as the tap, and released only when the save answers.
    expect(s).toMatch(/if \(inFlight\.current \|\| pending\) return;/);
    expect(s).toContain("inFlight.current = true;");
    expect(s).toMatch(/finally \{\s*inFlight\.current = false;/);
    // Save greys out while it works.
    expect(s).toContain("saving={pending}");
    // The door.
    expect(s).toContain("<SameDayShifts");
    expect(s).toContain("setClash(res.clash ?? null)");
  });
  it("the one form is the only add-hours form of its kind: both old copies are gone, and both pages mount Add Time Entry", () => {
    expect(() => src("../jobs/[id]/job-add-time.tsx")).toThrow();
    expect(() => src("./add-entry-button.tsx")).toThrow();
    expect(src("../timecards/page.tsx")).toContain("<AddTimeEntry");
    expect(src("../jobs/[id]/page.tsx")).toContain("<AddTimeEntry");
    expect(src("../jobs/[id]/page.tsx")).toContain("fixedJob={{ id: j.id, label: jobLabel(j) }}");
  });
  it("a dropped connection on Put This On, Company Time or either Undo is a sentence (the 60mph law)", () => {
    const put = src("./same-day-shifts.tsx");
    // The sentences come through the catalog since cn-v1138: the door reads the key, the key says "No connection".
    expect(put).toMatch(/try \{\s*r = await putShiftOnJob\([^)]*\);\s*\} catch \{\s*toast\(t\("tc_offlineShiftMayNotMove"\)/);
    expect(put).toMatch(/takeShiftOffJob\([^)]*\)\.then\(\s*\(u\) => \{[\s\S]*?\},\s*\(\) => toast\(t\("tc_offlineUndoFailed"\)/);
    expect(dict("en").tc_offlineShiftMayNotMove).toMatch(/^No connection/);
    expect(dict("en").tc_offlineUndoFailed).toMatch(/^No connection/);
    expect(dict("es").tc_offlineShiftMayNotMove).toMatch(/^Sin conexión/);
    expect(dict("es").tc_offlineUndoFailed).toMatch(/^Sin conexión/);
    const company = src("../timecards/company-time-button.tsx");
    expect(company).toMatch(/try \{\s*r = await fileShiftAsCompanyTime\([^)]*\);\s*\} catch \{\s*toast\("No connection/);
    expect(company).toMatch(/\.then\(\s*\(u\) => \{[\s\S]*?\},\s*\(\) =>\s*toast\(\s*`No connection/);
  });
  it("Log Hours on the job shows the day's shifts too, once hours are being logged (not on every Clock In)", () => {
    const s = src("../jobs/[id]/job-time-button.tsx");
    expect(s).toContain("<SameDayShifts");
    expect(s).toMatch(/\{\(hours > 0 \|\| workDate !== todayStrInTz\(tz\)\) && \(\s*<SameDayShifts/);
  });
  it("Open That Shift on Timecards closes Add Time Entry once the URL names the shift, so one Back closes one modal", () => {
    const s = src("../timecards/add-time-entry.tsx");
    expect(s).toContain("onOpenShift={(shift) => setOpeningShift(shift.id)}");
    expect(s).toMatch(/if \(openingShift && searchParams\?\.get\("entry"\) === openingShift\) \{\s*setOpen\(false\);/);
    // The link itself still navigates, and tells the form it was tapped.
    expect(src("./same-day-shifts.tsx")).toMatch(/href=\{`\/timecards\?entry=\$\{s\.id\}`\}\s*onClick=\{\(\) => onOpenShift\?\.\(s\)\}/);
  });
  it("the door is an outline button, never a second primary beside the form's own", () => {
    expect(render([punch], { id: "j28", label: "41 Larkspur" })).toMatch(/<button[^>]*class="[^"]*border-slate-300[^"]*"[^>]*>Put This On 41 Larkspur<\/button>/);
  });
});
