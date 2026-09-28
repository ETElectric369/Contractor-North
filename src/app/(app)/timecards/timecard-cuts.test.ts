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
  duplicateTimeEntry: vi.fn(async () => ({ ok: true })),
  stopShift: vi.fn(async () => ({ ok: true })),
  updateOpenEntry: vi.fn(async () => ({ ok: true })),
}));

import { SchedulingSettings } from "../settings/scheduling-settings";
import { getOrgSettings } from "@/lib/org-settings";
import { ShiftList, type StackEntry } from "./timecard-stack";
import { EditEntryButton, sourceLine } from "./edit-entry-button";
import { DuplicateEntryButton } from "./duplicate-entry-button";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const TZ = "America/Los_Angeles";

/** One of Brian's shifts as the week list gets it: 7:00 AM to 3:30 PM Pacific, on 85 Whitney. */
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
  label: "Brian · 85 Whitney",
  sub: "7:00 AM–3:30 PM",
  color: "",
  dot: "bg-sky-500",
  href: "/timecards?week=0&entry=e1",
  job: { href: "/jobs/j28", label: "85 Whitney" },
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
  job: { job_number: "J-028", name: "85 Whitney" },
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
});
