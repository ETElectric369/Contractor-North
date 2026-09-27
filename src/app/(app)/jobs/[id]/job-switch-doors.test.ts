import { describe, it, expect, vi } from "vitest";
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
vi.mock("@/app/(app)/tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn() }));
vi.mock("@/app/(app)/permits/actions", () => ({ createPermit: vi.fn(), updatePermit: vi.fn(), deletePermit: vi.fn() }));
vi.mock("@/app/(app)/permits/edit-permit-button", () => ({ EditPermitButton: () => null }));
vi.mock("@/app/(app)/materials/stock-actions", () => ({ loadShelf: vi.fn(), takeFromStockAction: vi.fn(), undoTakeAction: vi.fn() }));
vi.mock("@/app/(app)/recurring/actions", () => ({ generateDue: vi.fn(), generateOne: vi.fn(), setRecurringActive: vi.fn() }));
vi.mock("@/app/(app)/leads/actions", () => ({ convertInquiry: vi.fn(), suggestVisitSlots: vi.fn() }));
vi.mock("@/app/(app)/appointments/new-inspection-button", () => ({ NewInspectionButton: () => createElement("button", null, "Inspect") }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));

vi.mock("@/app/(app)/jobs/actions", () => ({ deleteDocument: vi.fn(), updateDocument: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ captureReceipt: vi.fn(), prettyBytes: () => "1 KB", readReceiptDocument: vi.fn() }));

import { JobTasks } from "./job-tasks";
import { JobDocuments } from "./job-documents";
import { TellNort } from "@/components/tell-nort";
import { JobPermits } from "./job-permits";
import { TookFromStock } from "../../materials/took-from-stock";
import { RecurringRowActions } from "../../recurring/recurring-actions-ui";
import { ConvertMenu } from "../../leads/convert-menu";

const r = (c: any, p: any) => renderToStaticMarkup(createElement(c, p));

describe("To-Do Extras on the job's Tasks tab", () => {
  const tasks = [{ id: "t1", title: "Pull the permit", category: null, status: "open", priority: 1, due_date: null }];
  it("on (the default): the High Priority box", () => {
    expect(r(JobTasks, { jobId: "j1", tasks })).toContain("High priority");
  });
  it("off: no box; a task that has a priority keeps its flag", () => {
    const html = r(JobTasks, { jobId: "j1", tasks, extras: false });
    expect(html).not.toContain("High priority");
    expect(html).toContain("Pull the permit");
    expect(html).toContain("text-red-500"); // the flag on the task that already has one
  });
});

describe("Permits & Inspections on the job's Permits tab", () => {
  const permits = [{ id: "p1", type: "Electrical", permit_number: "E-1", authority: null, status: "applied", applied_date: null, issued_date: null, inspection_date: null, inspector: null, inspection_result: "pending", fee: 0, notes: null, portal_url: null }];
  it("on (the default): Add Permit", () => {
    expect(r(JobPermits, { jobId: "j1", permits })).toContain("Add Permit");
  });
  it("off: no Add Permit; the permit on the job is still listed", () => {
    const html = r(JobPermits, { jobId: "j1", permits, canAdd: false });
    expect(html).not.toContain("Add Permit");
    expect(html).toContain("E-1");
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
  it("the voice fill on a walk-through keeps working, as Just Say It", () => {
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
