import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

/**
 * TIMECARDS, CUT DOWN (Wave 2, W2-02). No approver nobody asks, no approval settings nothing reads,
 * no pencil and no copy icon on a row the whole of which already opens the shift, no "manual" badge
 * on every hand-typed row. Nothing silent and no dead end: the editor says where a shift's time came
 * from, and Copy To Someone Else… lives in it.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../settings/actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));
vi.mock("../settings/features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));
vi.mock("../timeclock/actions", () => ({
  updateTimeEntry: vi.fn(async () => ({ ok: true })),
  deleteTimeEntry: vi.fn(async () => ({ ok: true })),
  joinTimeEntries: vi.fn(async () => ({ ok: true })),
  moveTimeEntryCut: vi.fn(async () => ({ ok: true })),
  splitTimeEntry: vi.fn(async () => ({ ok: true })),
  shiftClaim: vi.fn(async () => ({ ok: true, holder: null })),
  duplicateTimeEntry: vi.fn(async () => ({ ok: true })),
  stopShift: vi.fn(async () => ({ ok: true })),
  updateOpenEntry: vi.fn(async () => ({ ok: true })),
}));

import { SchedulingSettings } from "../settings/scheduling-settings";
import { getOrgSettings } from "@/lib/org-settings";
import { ShiftList, type StackEntry } from "./timecard-stack";
import { EditEntryButton, sourceLine, rateUnsavedOf, formTimesOf } from "./edit-entry-button";
import { DuplicateEntryButton } from "./duplicate-entry-button";
import { NO_JOB_MATCH, SplitShiftSheet, jobSearchNote } from "./split-shift-sheet";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const TZ = "America/Los_Angeles";

/** One of Brian's shifts as the week list gets it: 7:00 AM to 3:30 PM Pacific, on 41 Larkspur. */
const row = (over: Partial<StackEntry> = {}): StackEntry => ({
  id: "e1",
  personId: "brian-1",
  personName: "Brian Taylor",
  person: "Brian",
  dayStr: "2026-09-22",
  clockIn: "2026-09-22T14:00:00Z",
  startMin: 420,
  endMin: 930,
  hours: 8.5,
  open: false,
  miles: 0,
  label: "Brian · 41 Larkspur",
  sub: "7:00 AM–3:30 PM",
  color: "",
  dot: "bg-sky-500",
  href: "/timecards?week=0&entry=e1",
  job: { href: "/jobs/j28", label: "41 Larkspur" },
  jobCode: null,
  source: null,
  lunchMin: 0,
  notes: null,
  ...over,
});
const renderRow = (e: StackEntry) => renderToStaticMarkup(createElement(ShiftList, { rows: [e], lead: (x: StackEntry) => x.person }));

/** A closed shift as the editor gets it. */
const entry = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  profile_id: "brian-1",
  clock_in: "2026-09-22T14:00:00Z",
  clock_out: "2026-09-22T22:30:00Z",
  lunch_minutes: 0,
  job_id: "j28",
  job_code: null,
  notes: null,
  miles: 0,
  status: "closed",
  profiles: { full_name: "Brian Taylor" },
  job: { job_number: "J-028", name: "41 Larkspur" },
  ...over,
});
const members = [
  { id: "brian-1", full_name: "Brian Taylor" },
  { id: "jimmy-1", full_name: "Jimmy Lee" },
];
const renderEditor = (e: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(EditEntryButton, {
      entry: e as any,
      jobCodes: [],
      jobs: [],
      members,
      isStaff: true,
      initialOpen: true,
      hideTrigger: true,
      tz: TZ,
      viewerId: "erik-1",
    }),
  );

describe("no approver, and no approval settings", () => {
  it("Settings › Scheduler & timesheets asks neither the tracking method nor a supervisor", () => {
    for (const isOwner of [true, false]) {
      const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings: getOrgSettings({}), isOwner }));
      expect(html).not.toContain("Time tracking method");
      expect(html).not.toContain("Timecard supervisor");
      expect(html).not.toContain("approves timecards");
      // The grid keeps the working day and the week.
      expect(html).toContain("Working day starts");
      expect(html).toContain("Working day ends");
      expect(html).toContain("Week starts on");
    }
  });

  it("a stored supervisor or method is left alone and never read: Save sends neither key", () => {
    const form = src("../settings/scheduling-settings.tsx");
    expect(form).not.toMatch(/time_tracking_method|timecard_supervisor_id/);
    expect(form).not.toMatch(/employees|ownerName/);
    expect(src("../../../lib/org-settings.ts")).not.toMatch(/time_tracking_method:|timecard_supervisor_id:/);
    // The call site passes neither prop any more.
    const settingsPage = src("../settings/page.tsx");
    expect(settingsPage).not.toMatch(/<SchedulingSettings[^>]*employees=/);
    expect(settingsPage).not.toMatch(/ownerName=/);
  });

  it("the Timecards header says what the page is for, and names no approver", () => {
    const page = src("./page.tsx");
    expect(page).toContain('<PageHeader title="Timecards" description="Review your crew\'s hours by week.">');
    expect(page).not.toMatch(/Approver|timecard_supervisor_id|supId/);
  });
});

describe("one door per row: the row opens the shift, and only a running clock keeps a button", () => {
  it("a hand-typed closed shift carries no 'manual' badge and no controls", () => {
    const html = renderRow(row({ source: "manual" }));
    expect(html).not.toMatch(/>manual</);
    expect(html).not.toContain("typed in by hand");
    expect(html).not.toContain("<button");
    // Still the door: the whole row opens this shift's editor.
    expect(html).toContain('href="/timecards?week=0&amp;entry=e1"');
    expect(html).toContain('aria-label="Open Brian 7:00 AM–3:30 PM"');
  });

  it("an offline punch still says so on the row, and the words open the editor too", () => {
    const html = renderRow(row({ source: "offline" }));
    expect(html).toMatch(/>offline</);
    expect(html).toContain("time came from the phone");
    expect(html).toContain('title="Punched with no signal, so the time came from the phone"');
  });

  it("a running clock keeps its one labelled action, Clock Out <Name>", () => {
    const running = entry({ id: "e2", clock_out: null, status: "open" });
    const controls = createElement(EditEntryButton, { entry: running as any, jobCodes: [], isStaff: true, tz: TZ, viewerId: "erik-1" });
    const html = renderRow(row({ id: "e2", open: true, endMin: null, hours: 0, controls }));
    expect(html).toMatch(/<button[^>]*>Clock Out Brian<\/button>/);
    // No pencil beside it.
    expect(html).not.toContain('title="Edit entry"');
  });

  it("the page gives a row controls only while it is running, and mounts no copy icon on any row", () => {
    const page = src("./page.tsx");
    expect(page).toContain('if (e.status !== "open") continue;');
    expect(page).not.toContain("DuplicateEntryButton");
    expect(page).not.toContain("duplicate-entry-button");
    // The stack draws the disclosure for an offline punch only.
    const stack = src("./timecard-stack.tsx");
    expect(stack).toContain('{e.source === "offline" && (');
    expect(stack).not.toContain('"typed in by hand"');
  });

  it("the job page's labour list keeps its pencil: its rows aren't a door, so the pencil is the only one", () => {
    const html = renderToStaticMarkup(createElement(EditEntryButton, { entry: entry() as any, jobCodes: [], isStaff: true, tz: TZ }));
    expect(html).toContain('title="Edit entry"');
  });
});

describe("the editor says where the time came from (0168), in words and never a badge", () => {
  it("the words, one per source, and nothing for a punch the server clock timed", () => {
    expect(sourceLine("manual")).toBe("Typed in by hand, not punched live.");
    expect(sourceLine("offline")).toBe("Punched with no signal, so the time came from the phone.");
    for (const s of ["app", "auto_gps", null, undefined, ""]) expect(sourceLine(s as any)).toBeNull();
  });

  it("a hand-typed shift's editor opens with the quiet line at the top of its body", () => {
    const html = renderEditor(entry({ source: "manual" }));
    expect(html).toMatch(/<p class="text-xs text-slate-500">Typed in by hand, not punched live\.<\/p>/);
    // At the top: before the first field.
    expect(html.indexOf("Typed in by hand")).toBeLessThan(html.indexOf("Team member"));
  });

  it("an offline punch's editor says the phone's clock stood in", () => {
    expect(renderEditor(entry({ source: "offline" }))).toContain("Punched with no signal, so the time came from the phone.");
  });

  it("a punched shift's editor says nothing about it", () => {
    const html = renderEditor(entry({ source: "app" }));
    expect(html).not.toContain("Typed in by hand");
    expect(html).not.toContain("Punched with no signal");
  });
});

describe("Copy To Someone Else… lives in the editor, beside Split", () => {
  it("a closed shift's editor draws it as a secondary 44px button beside Split This Shift; Delete stays the one red action", () => {
    const html = renderEditor(entry({ source: "manual" }));
    expect(html).toMatch(/<button[^>]*class="[^"]*border-slate-300[^"]*h-11[^"]*"[^>]*>(?:(?!<\/button>).)*Copy To Someone Else…<\/button>/);
    // In the tools box, right after Split This Shift, not in the footer.
    const split = html.indexOf("Split This Shift");
    const copy = html.indexOf("Copy To Someone Else…");
    expect(split).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(split);
    expect(copy).toBeLessThan(html.indexOf("Worked two jobs, or drove part of it?"));
    expect(html.match(/text-red-600/g)?.length).toBe(1);
  });

  it("a running clock's sheet has no copy: only a closed shift can be copied", () => {
    const html = renderEditor(entry({ clock_out: null, status: "open", source: "manual" }));
    expect(html).not.toContain("Copy To Someone Else…");
  });

  it("the picker behind it is the one that was on the row: same person guarded, same action, same fallback", () => {
    const copy = src("./duplicate-entry-button.tsx");
    expect(copy).toContain("res = await duplicateTimeEntry(id, m.id);");
    expect(copy).toContain('toast(res.message ?? `Copied to ${m.full_name ?? "them"}.`, "success");');
    expect(copy).toContain("const isSource = (m: Member) => !!profileId && m.id === profileId;");
    expect(copy).toContain('.from("profiles")');
    expect(copy).toContain("already has these hours on this entry.");
    // Never "Copy To Another Day": the copy goes onto another PERSON (Erik, 2026-09-18).
    expect(copy).not.toMatch(/Another Day/);
    // Off the team is never offered: a copy onto them can only be refused.
    expect(copy).toContain("(members ?? []).filter((m) => m.active !== false)");
  });

  it("with no trigger of its own, the picker's door is the same labelled button", () => {
    const html = renderToStaticMarkup(createElement(DuplicateEntryButton, { id: "e1", profileId: "brian-1", members }));
    expect(html).toMatch(/<button[^>]*class="[^"]*h-11[^"]*"[^>]*>(?:(?!<\/button>).)*Copy To Someone Else…<\/button>/);
  });

  it("a form holding unsaved changes asks for Save first, since a copy takes the shift as it's saved", () => {
    const edit = src("./edit-entry-button.tsx");
    expect(edit).toContain("disabled={pending || unsaved}");
    expect(edit).toContain("Save your changes first, then copy the shift to someone else.");
  });

  it("a saved Rate stops asking for Save: the copy opens again once the refreshed row holds it", () => {
    // Brian's Rate typed to 45: unsaved while the row still holds nothing (or 40)...
    expect(rateUnsavedOf({ rateDirty: true, ownerShift: false, rate: 45, stored: null })).toBe(true);
    expect(rateUnsavedOf({ rateDirty: true, ownerShift: false, rate: 45, stored: 40 })).toBe(true);
    // ...and saved once the refresh brings 45 back, even as a numeric string, with the field still "edited".
    expect(rateUnsavedOf({ rateDirty: true, ownerShift: false, rate: 45, stored: 45 })).toBe(false);
    expect(rateUnsavedOf({ rateDirty: true, ownerShift: false, rate: 45, stored: "45.00" })).toBe(false);
    // Cleared to 0 = "use the base rate", saved as no override.
    expect(rateUnsavedOf({ rateDirty: true, ownerShift: false, rate: 0, stored: null })).toBe(false);
    expect(rateUnsavedOf({ rateDirty: true, ownerShift: false, rate: 0, stored: 40 })).toBe(true);
    // Never edited, or the owner's shift (a Save never sends him a rate, 0286): nothing to save.
    expect(rateUnsavedOf({ rateDirty: false, ownerShift: false, rate: 45, stored: null })).toBe(false);
    expect(rateUnsavedOf({ rateDirty: true, ownerShift: true, rate: 45, stored: null })).toBe(false);
    // Wired: `unsaved` reads the value, never the bare flag.
    const edit = src("./edit-entry-button.tsx");
    expect(edit).toContain("const rateUnsaved = rateUnsavedOf({ rateDirty, ownerShift, rate, stored: entry.rate_override });");
    const unsavedExpr = edit.slice(edit.indexOf("const unsaved ="), edit.indexOf("function save()"));
    expect(unsavedExpr).toContain("rateUnsaved ||");
    expect(unsavedExpr).not.toMatch(/\brateDirty\b/);
  });

  it("a moved split's new times reach an editor that stays open, unless the person typed their own", () => {
    // Brian's shift, 7:00 AM to 3:30 PM Pacific; Move The Split ends it at 2:00 PM.
    const before = formTimesOf("2026-09-22T14:00:00Z", "2026-09-22T22:30:00Z");
    const after = formTimesOf("2026-09-22T14:00:00Z", "2026-09-22T21:00:00Z");
    expect(before.endT).not.toBe(after.endT);
    expect(after.startT).toBe(before.startT);
    expect(after.date).toBe(before.date);
    // An open clock's form ends where it starts, on the same day.
    const open = formTimesOf("2026-09-22T14:00:00Z", null);
    expect(open.endT).toBe(open.startT);
    expect(open.endDate).toBe(open.date);
    // Wired: when the stored times change, untouched fields follow the row; typed ones stay.
    const edit = src("./edit-entry-button.tsx");
    expect(edit).toMatch(/if \(seenSpan\.in !== entry\.clock_in \|\| seenSpan\.out !== entry\.clock_out\) \{/);
    expect(edit).toContain("const untouched = date === was.date && startT === was.startT && endT === was.endT && endDate === was.endDate;");
    expect(edit).toMatch(/if \(untouched\) \{\s*const now = formTimesOf\(entry\.clock_in, entry\.clock_out\);/);
  });
});

describe("no sentence sends anyone to a door that left", () => {
  it("a crew lead's filed report says the office reads it on My Day, not on the gone 'Crew Hours' card", () => {
    const debrief = src("../timeclock/daily-report-debrief.tsx");
    expect(debrief).toContain("The office reads it on their My Day.");
    expect(debrief).not.toMatch(/on Crew Hours\./);
    // My Day is where the reports are (with Mark Reviewed).
    expect(src("../planner/page.tsx")).toContain('.from("daily_reports")');
  });
});

describe("Split This Shift offers every job in flight, not the 50 newest (cc484d6e)", () => {
  /** 60 jobs, newest first as the old read ordered them; the 60th is an older job still running. */
  const sixty = Array.from({ length: 60 }, (_, i) => ({ id: `j${i + 1}`, job_number: `J-${String(i + 1).padStart(3, "0")}`, name: i === 59 ? "700 North Juniper Boulevard" : `Job ${i + 1}` }));
  const sheet = (jobs: typeof sixty) =>
    renderToStaticMarkup(
      createElement(SplitShiftSheet, { entry: entry() as any, jobs, jobCodes: [], tz: TZ, open: true, onClose: () => undefined, onSplit: () => undefined, knownClaim: null }),
    );

  it("the Second Part's picker lists an active job older than the 50 newest, under 'Jobs', never 'Recent Jobs'", () => {
    const html = sheet(sixty);
    expect(html).toContain('<option value="job:j60">700 North Juniper Boulevard</option>');
    expect(html).toContain('<optgroup label="Jobs">');
    expect(html).not.toContain("Recent Jobs");
    expect((html.match(/<option value="job:/g) ?? []).length).toBe(60);
  });

  it("a search that finds nothing says so, and where an older finished job went; an empty list with no search says nothing", () => {
    expect(jobSearchNote("lake", 0)).toBe(NO_JOB_MATCH);
    expect(NO_JOB_MATCH).toBe("No job matches that. Finished jobs older than 30 days are on the job's own Time tab.");
    expect(jobSearchNote("lake", 3)).toBeNull();
    expect(jobSearchNote("", 0)).toBeNull();
    expect(jobSearchNote("   ", 0)).toBeNull();
    expect(sheet([])).not.toContain("No job matches that");
    // Wired under the picker, from the live search and the jobs it leaves.
    expect(src("./split-shift-sheet.tsx")).toContain("{jobSearchNote(search, shownJobs.length) && <p className=\"text-xs text-slate-500\">{jobSearchNote(search, shownJobs.length)}</p>}");
  });

  it("Timecards hands the editor and the split sheet the SAME list Add Time Entry uses: every active job plus 30 days of finished ones, no cap", () => {
    const page = src("./page.tsx");
    expect(page).not.toContain(".limit(50)");
    expect(page).not.toContain("the 50 newest");
    expect(page).toContain('const pickJobs = addJobs.map((j) => ({ id: j.id, job_number: j.job_number ?? "", name: j.name ?? "" }));');
    expect(page).toContain("jobs={pickJobs}");
    expect(page).toContain("let focusJobs = pickJobs;");
    // Nort's fill still prepends a job the list does not hold.
    expect(page).toMatch(/if \(fj\) focusJobs = \[fj as \{ id: string; job_number: string; name: string \}, \.\.\.focusJobs\];/);
    // The job page's list has no cap either (verified: no limit(50) on its allJobs read).
    expect(src("../jobs/[id]/page.tsx")).not.toContain(".limit(50)");
  });

  it("a closed shift's editor carries Split This Shift in its footer too, a 44px secondary door reachable without scrolling the form; a running clock has none", () => {
    const html = renderEditor(entry());
    const doors = html.match(/<button[^>]*>(?:(?!<\/button>).)*Split This Shift<\/button>/g) ?? [];
    expect(doors.length).toBe(2);
    for (const d of doors) expect(d).toMatch(/class="[^"]*border-slate-300[^"]*h-11[^"]*"/);
    // The footer's: after the body's tools box, before Save Changes.
    const last = html.lastIndexOf("Split This Shift");
    expect(last).toBeGreaterThan(html.indexOf("Worked two jobs, or drove part of it?"));
    expect(last).toBeLessThan(html.indexOf("Save Changes"));
    // Delete stays the one red action, and both doors open the one sheet.
    expect(html.match(/text-red-600/g)?.length).toBe(1);
    const edit = src("./edit-entry-button.tsx");
    expect((edit.match(/onClick=\{openSplit\}/g) ?? []).length).toBe(2);
    expect(renderEditor(entry({ clock_out: null, status: "open" }))).not.toContain("Split This Shift");
  });
});
