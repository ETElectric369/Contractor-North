import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BOX_WORDS, entryInfo, hoursWords, stateWords, type EntryFacts } from "./entry-info";
import { titleCaseIn } from "../../../../tests/title-case-words";

/**
 * THE BOX ON THE GRID SAYS WHAT THE ROW SAYS (cn-v1151; Erik, reconciling timecards: "more information on
 * the timecard entry box on the calendar screen, perhaps even just the total hours would be helpful").
 *
 * Every pill on the week grid of /timecards now carries a TimeGridInfo built by one pure rule from the
 * very fields the list row under it reads: the span, the hours with the lunch that came off them, where the
 * shift stands (On the Clock / Paid / No Job, and an offline punch said too — 0168), and the person's own
 * words less the clock's take-back line. These tests run the rule on each shape of shift, judge its words
 * by the one Title Case rule, and pin the page to calling it with those fields — including the `paid_at`
 * the stack's read had to start carrying for "Paid" to ever show.
 */
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** The clock's own sealed line (lib/held-crumb HELD_CRUMB): never a note, never shown. */
const CRUMB = '[This punch took the job off hold. Before: {"status":"on_hold"} #0123456789abcdef]';

/** Sam's closed Tuesday shift as the page hands it over: 1:00 to 3:30, a half hour of lunch off, locked by payroll. */
const facts = (over: Partial<EntryFacts> = {}): EntryFacts => ({
  sub: "1:00 PM–3:30 PM",
  open: false,
  hours: 2,
  lunchMin: 30,
  paidAt: "2026-09-26T20:00:00Z",
  noJob: false,
  source: null,
  notes: `Pulled the old panel. ${CRUMB}`,
  ...over,
});

describe("entryInfo — the box, from the row's own facts", () => {
  it("a closed, paid shift: the span as the time line, the hours with the lunch, Paid in good, the note without the crumb", () => {
    expect(entryInfo(facts())).toEqual({
      time: "1:00 PM–3:30 PM",
      hours: "2.00 h · 30 min lunch",
      state: { text: "Paid", tone: "good" },
      note: "Pulled the old panel.",
    });
  });

  it("a shift still on the clock: no hours at all (worth nothing until it closes), On the Clock in warn, the live span", () => {
    const info = entryInfo(facts({ open: true, hours: 0, sub: "7:00 AM–now", paidAt: null }));
    expect(info.hours).toBeNull();
    expect(info.state).toEqual({ text: "On the Clock", tone: "warn" });
    expect(info.time).toBe("7:00 AM–now");
    // The clock comes first even if a lock were somehow stamped on a running shift.
    expect(stateWords({ open: true, paidAt: "2026-09-26T20:00:00Z", noJob: false, source: null })).toEqual({ text: "On the Clock", tone: "warn" });
  });

  it("a closed shift on no job and no code says No Job in warn; an unpaid one on a job says nothing", () => {
    expect(entryInfo(facts({ paidAt: null, noJob: true })).state).toEqual({ text: "No Job", tone: "warn" });
    expect(entryInfo(facts({ paidAt: null })).state).toBeNull();
    // Paid outranks No Job: once payroll locked it, the lock is the state.
    expect(stateWords({ open: false, paidAt: "2026-09-26T20:00:00Z", noJob: true, source: null })).toEqual({ text: "Paid", tone: "good" });
  });

  it("an offline punch says so on the box (0168): alone in warn, or after the state it already has", () => {
    expect(entryInfo(facts({ paidAt: null, source: "offline" })).state).toEqual({ text: "Offline Punch", tone: "warn" });
    expect(entryInfo(facts({ source: "offline" })).state).toEqual({ text: "Paid · Offline Punch", tone: "good" });
    expect(entryInfo(facts({ open: true, hours: 0, paidAt: null, source: "offline" })).state).toEqual({ text: "On the Clock · Offline Punch", tone: "warn" });
    expect(entryInfo(facts({ paidAt: null, noJob: true, source: "offline" })).state).toEqual({ text: "No Job · Offline Punch", tone: "warn" });
    // A hand-typed shift says so in its editor, not on the row and not on the box (Wave 2).
    expect(entryInfo(facts({ paidAt: null, source: "manual" })).state).toBeNull();
  });

  it("the hours line: two decimals and the unit; the lunch only when some came off; never while open", () => {
    expect(hoursWords({ open: false, hours: 8.5, lunchMin: 0 })).toBe("8.50 h");
    expect(hoursWords({ open: false, hours: 8.5, lunchMin: 30 })).toBe("8.50 h · 30 min lunch");
    expect(hoursWords({ open: false, hours: 0, lunchMin: 0 })).toBe("0.00 h");
    expect(hoursWords({ open: true, hours: 0, lunchMin: 30 })).toBeNull();
  });

  it("a blank note, no note, or a note that was only the clock's own line is no note at all (null, so the box draws no line)", () => {
    expect(entryInfo(facts({ notes: "" })).note).toBeNull();
    expect(entryInfo(facts({ notes: "   " })).note).toBeNull();
    expect(entryInfo(facts({ notes: null })).note).toBeNull();
    expect(entryInfo(facts({ notes: undefined })).note).toBeNull();
    expect(entryInfo(facts({ notes: CRUMB })).note).toBeNull();
    expect(entryInfo(facts({ notes: `${CRUMB}\nLeft the breaker off.` })).note).toBe("Left the breaker off.");
  });

  it("the box's words are Title Case by the one rule (the small word lowercase mid-title), in every combination", () => {
    expect(BOX_WORDS).toEqual({ onTheClock: "On the Clock", paid: "Paid", noJob: "No Job", offlinePunch: "Offline Punch" });
    for (const w of Object.values(BOX_WORDS)) expect(titleCaseIn(w, "en"), w).toBe(true);
    for (const text of ["Paid · Offline Punch", "On the Clock · Offline Punch", "No Job · Offline Punch"]) expect(titleCaseIn(text, "en"), text).toBe(true);
  });
});

describe("the page builds every entry's box from the row's own values, and reads what the box needs", () => {
  it("toStackEntry hands entryInfo the same sub, open, hours, lunch, lock, No Job, source and notes it puts on the row", () => {
    const page = src("./page.tsx");
    expect(page).toContain('import { entryInfo } from "./entry-info";');
    expect(page).toContain("info: entryInfo({ sub, open, hours, lunchMin, paidAt: e.paid_at ?? null, noJob, source, notes }),");
    // The values are computed once and shared: the row's `sub` IS the box's time, the row's `hours` IS the box's number.
    const mapper = page.slice(page.indexOf("const toStackEntry = (e: any): StackEntry => {"), page.indexOf("/* ONE LIST, AND THE ANCHORED WEEK IS ALWAYS IN IT."));
    expect(mapper).toContain("const hours = open ? 0 : hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);");
    expect(mapper).toContain("const sub = (() => {");
    expect(mapper).toContain("const noJob = !open && !e.job_id && !e.job_code;");
    expect(mapper).toContain("const lunchMin = Number(e.lunch_minutes ?? 0);");
    expect(mapper).toMatch(/\n\s+hours,\n\s+open,\n/);
    expect(mapper).toMatch(/\n\s+sub,\n/);
    expect(mapper).toMatch(/\n\s+noJob,\n\s+source,\n\s+lunchMin,\n\s+notes,\n/);
  });

  it("the stack's wide read carries paid_at, or the box could never say Paid (the projection law)", () => {
    const page = src("./page.tsx");
    const read = page.slice(page.indexOf("const { data: stackRows } = await supabase"), page.indexOf('.gte("clock_in", stackFrom)'));
    expect(read).toMatch(/"id, profile_id, clock_in, clock_out, lunch_minutes, job_id, job_code, source, notes, miles, paid_at, split_from, split_how, /);
  });

  it("StackEntry carries the box as `info`, the grid's own type, beside the `sub` the rows keep reading", () => {
    const stack = src("./timecard-stack.tsx");
    expect(stack).toContain('import { TimeGrid, type TimeGridEvent, type TimeGridInfo } from "@/components/time-grid";');
    expect(stack).toMatch(/\n  sub: string;\n(?:\s+\/\*\*[\s\S]*?\*\/\n)?\s+info\?: TimeGridInfo;\n/);
    // The rows under the grid still say the same facts in their own words — the two cannot drift.
    expect(stack).toContain("<Badge tone=\"amber\">No Job</Badge>");
    expect(stack).toContain("<Badge tone=\"blue\">Offline</Badge>");
    expect(stack).toContain("{e.lunchMin > 0 && <span>· lunch {e.lunchMin}m</span>}");
  });
});
