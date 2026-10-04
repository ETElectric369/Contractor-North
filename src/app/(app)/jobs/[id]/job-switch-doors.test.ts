import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE DOORS A SWITCH HIDES ON AND AROUND A JOB (0352). Each component's switch prop defaults to on,
 * so a page that passes nothing (and a company with no switches stored) draws exactly what it did.
 * Off, the door that MAKES something goes; what already exists stays listed and workable.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/jobs/j1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn(), setTaskDonePhoto: vi.fn() }));
vi.mock("@/app/(app)/permits/actions", () => ({ createPermit: vi.fn(), updatePermit: vi.fn(), deletePermit: vi.fn() }));
vi.mock("@/app/(app)/permits/edit-permit-button", () => ({ EditPermitButton: () => null }));
vi.mock("@/app/(app)/materials/stock-actions", () => ({ loadShelf: vi.fn(), takeFromStockAction: vi.fn(), undoTakeAction: vi.fn() }));
vi.mock("@/app/(app)/recurring/actions", () => ({ generateOne: vi.fn(), setRecurringActive: vi.fn() }));
vi.mock("@/app/(app)/leads/actions", () => ({ convertInquiry: vi.fn(), suggestVisitSlots: vi.fn() }));
vi.mock("@/app/(app)/appointments/new-inspection-button", () => ({ NewInspectionButton: () => createElement("button", null, "Inspect") }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));

vi.mock("@/app/(app)/jobs/actions", () => ({ deleteDocument: vi.fn(), updateDocument: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ captureReceipt: vi.fn(), prettyBytes: () => "1 KB", readReceiptDocument: vi.fn() }));

import { JobTaskList } from "./job-task-list";
import { JobDocuments } from "./job-documents";
import { TellNort } from "@/components/tell-nort";
import { JobPermits } from "./job-permits";
import { TookFromStock } from "../../materials/took-from-stock";
import { RecurringRowActions } from "../../recurring/recurring-actions-ui";
import { ConvertMenu } from "../../leads/convert-menu";

const r = (c: any, p: any) => renderToStaticMarkup(createElement(c, p));

describe("To-Do Extras never reaches a job's Tasks (0358: the switch is the Reminders' now)", () => {
  const tasks = [
    { id: "t1", title: "Pull the permit", status: "open", created_by: "u1", created_at: "2026-09-20T17:00:00Z", completed_at: null, done_by: null, done_by_name: null, photo_path: null, done_photo_path: null, sort_order: 0 },
  ];
  const base = { jobId: "j1", orgId: "o1", tasks, viewerId: "u1", viewerIsStaff: true, tz: "America/Los_Angeles", nowIso: "2026-09-26T19:00:00Z", stamps: true };
  it("the job's list asks no priority and draws no flag, Done fold open or closed, whatever the switch says", () => {
    for (const doneOpen of [false, true]) {
      const html = r(JobTaskList, { ...base, doneOpen });
      expect(html).toContain("Pull the permit");
      expect(html).not.toMatch(/priority/i);
      expect(html).not.toMatch(/due date/i);
    }
  });
  it("the job page hands the Tasks tab no switch at all", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).not.toContain('extras={on("todo_extras")}');
    expect(page).toContain("content: <JobTaskList {...taskListProps} />");
  });
});

describe("Permits & Inspections on the job's Permits tab", () => {
  // No inspection_date / inspector / inspection_result on a permit any more (0378): a permit's visits
  // are rows of their own, and tests/no-superseded-permit-columns fails if they come back.
  const permits = [{ id: "p1", type: "Electrical", permit_number: "E-1", authority: null, status: "applied", applied_date: null, issued_date: null, fee: 0, notes: null, portal_url: null }];
  const TOWN = "Town of Truckee";
  const UTIL = "Liberty Utilities";
  const visit = (over: any) => ({ id: `i${over.position}`, permit_id: "p1", authority: TOWN, scheduled_for: null, scheduled_window: null, inspector: null, result: null, result_on: null, ...over });
  const booked = [
    visit({ position: 1, authority: TOWN, scheduled_for: "2026-10-15", scheduled_window: "morning" }),
    visit({ position: 2, authority: UTIL, scheduled_for: "2026-10-15", scheduled_window: "morning" }),
  ];

  it("on (the default): Add Permit", () => {
    expect(r(JobPermits, { jobId: "j1", permits })).toContain("Add Permit");
  });
  it("off: no Add Permit; the permit on the job is still listed", () => {
    const html = r(JobPermits, { jobId: "j1", permits, canAdd: false });
    expect(html).not.toContain("Add Permit");
    expect(html).toContain("E-1");
  });

  it("the permit says who still has to come, in order, with the day and the part of the day", () => {
    const html = r(JobPermits, { jobId: "j1", permits, inspections: booked, todayStr: "2026-10-14" });
    expect(html).toContain("Town of Truckee · Thu Oct 15, morning");
    // The utility is booked for the same morning AND waits on the town: both halves are true.
    expect(html).toContain("Liberty Utilities · Thu Oct 15, morning · Waits for Town of Truckee");
    expect(html).toContain("Waiting on Town of Truckee");
    expect(html).toContain("Add Inspection");
    expect(html.indexOf("Town of Truckee ·")).toBeLessThan(html.indexOf("Liberty Utilities ·"));
  });

  it("a permit with no inspections says so, and the switch off leaves the list readable with nothing to press", () => {
    expect(r(JobPermits, { jobId: "j1", permits, todayStr: "2026-10-14" })).toContain("No inspections on this permit yet");
    const off = r(JobPermits, { jobId: "j1", permits, inspections: booked, todayStr: "2026-10-14", canAdd: false });
    expect(off).toContain("Town of Truckee · Thu Oct 15, morning");
    expect(off).not.toContain("Add Inspection");
    expect(off).not.toContain("Say How It Went");
  });

  it("a lost read says so, and claims nothing about who has been", () => {
    const html = r(JobPermits, { jobId: "j1", permits, inspections: [], inspectionsUnread: true, todayStr: "2026-10-14" });
    expect(html).toContain("Couldn’t read this permit’s inspections just now");
    expect(html).not.toContain("No inspections on this permit yet");
    expect(html).not.toContain("Waiting on");
  });

  it("every inspection passed: the card says so in words that hold in every trade", () => {
    const done = booked.map((b) => ({ ...b, result: "passed", result_on: "2026-10-15" }));
    const html = r(JobPermits, { jobId: "j1", permits, inspections: done, todayStr: "2026-10-16" });
    // NOT "the meter is on": that is a fact about an electrical job whose last authority is the
    // utility, and this card draws a deck's and a plumber's permits too.
    expect(html).toContain("Every inspection passed — the job is done");
    expect(html).not.toContain("meter is on");
  });

  it("a visit that HAPPENED has no Remove button — only a booking nobody went to can be taken off", () => {
    const done = booked.map((b) => ({ ...b, result: "passed", result_on: "2026-10-15" }));
    expect(r(JobPermits, { jobId: "j1", permits, inspections: done, todayStr: "2026-10-16" })).not.toContain("Remove the");
    // An open booking still has it.
    expect(r(JobPermits, { jobId: "j1", permits, inspections: booked, todayStr: "2026-10-14" })).toContain("Remove the Town of Truckee inspection");
  });
});

describe("Shop Stock: Took From Stock", () => {
  const takes = [{ drawGroup: "g1", takenAt: "2026-09-20T17:00:00Z", itemId: "i1", item: "12/2 NM-B", unit: "ft", qty: 60, short: 0, back: 0, who: "Brian", mine: false, billedOn: null }];
  it("on (the default): the button, for the crew and the office", () => {
    for (const viewerIsStaff of [true, false]) expect(r(TookFromStock, { jobId: "j1", takes: [], viewerIsStaff })).toContain("Took From Stock");
  });
  it("off: no button; the job's takes stay listed", () => {
    const html = r(TookFromStock, { jobId: "j1", takes, viewerIsStaff: true, canTake: false });
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Took From Stock/);
    expect(html).toContain("12/2 NM-B");
  });
});

describe("Recurring Billing: a template's row", () => {
  it("on (the default): Generate One Now and Pause", () => {
    const html = r(RecurringRowActions, { id: "r1", active: true });
    expect(html).toContain('title="Generate One Now"');
    expect(html).toContain('title="Pause"');
  });
  it("off: nothing is made, so no Generate; Pause stays", () => {
    const html = r(RecurringRowActions, { id: "r1", active: true, canGenerate: false });
    expect(html).not.toContain("Generate One Now");
    expect(html).toContain('title="Pause"');
  });
});

describe("Estimates on a lead's row", () => {
  it("on (the default): Estimate beside Schedule", () => {
    const html = r(ConvertMenu, { inquiryId: "i1", inquiryName: "Sarah" });
    expect(html).toMatch(/ Estimate<\/button>/);
    expect(html).toContain("Schedule");
  });
  it("off: no Estimate; Schedule stays", () => {
    const html = r(ConvertMenu, { inquiryId: "i1", inquiryName: "Sarah", estimateDoor: false });
    expect(html).not.toMatch(/ Estimate<\/button>/);
    expect(html).toContain("Schedule");
  });
});

describe("Nort off: the surfaces that stay say it without the name", () => {
  const hear = vi.fn();
  it("the voice fill on an inspection keeps working, as Just Say It", () => {
    expect(r(TellNort, { hear, answers: {}, onFilled: () => {} })).toContain("Just tell Nort");
    const html = r(TellNort, { hear, answers: {}, onFilled: () => {}, nortOn: false });
    expect(html).toContain("Just Say It");
    expect(html).not.toContain("Nort");
  });

  const docs = [{ id: "d1", name: "ced.pdf", category: "Receipt", file_url: "o/j/ced.pdf", signedUrl: "https://x.test/ced.pdf", size_bytes: 10, created_at: "2026-09-20T17:00:00Z" }];
  it("the receipt reader's tooltip on a job's documents", () => {
    expect(r(JobDocuments, { orgId: "o1", jobId: "j1", docs })).toContain("Nort reads the receipt");
    const html = r(JobDocuments, { orgId: "o1", jobId: "j1", docs, nortOn: false });
    expect(html).toContain("Reads the receipt and adds it to this job");
    expect(html).not.toContain("Nort");
  });

  it("Customer Portal off: no plans door pointing at the Customer Page tab", () => {
    expect(r(JobDocuments, { orgId: "o1", jobId: "j1", docs, plansDoor: true })).toContain("tab=customer");
    expect(r(JobDocuments, { orgId: "o1", jobId: "j1", docs, plansDoor: false })).not.toContain("tab=customer");
  });
});
