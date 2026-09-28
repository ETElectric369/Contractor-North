import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB HEADER (W1-17). The status badge IS the status control: the office taps the pill (its
 * status's colours, a chevron) for a glass menu of the statuses; a held job reads "On Hold · waiting
 * on the permit · back Oct 3" with Snooze beside it; the crew reads the same pill, not tappable. The
 * J-number is said once (the breadcrumb). Manage is three rows for the office and nothing for a tech.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("../actions", () => ({ setJobStatus: vi.fn() }));
vi.mock("../../schedule/actions", () => ({ setJobHold: vi.fn(), snoozeJobHold: vi.fn() }));

import { JobStatusControl, heldWords, statusTitle } from "./job-status-control";
import { MANAGE_ROW_CLS } from "./job-manage-menu";

const TODAY = "2026-09-27";
const render = (p: Partial<Parameters<typeof JobStatusControl>[0]> = {}) =>
  renderToStaticMarkup(createElement(JobStatusControl, { id: "j1", status: "in_progress", todayStr: TODAY, ...p }));
const src = (f: string) => readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]", f), "utf8");
/** The code alone: the comments may still tell the history of what moved. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

describe("the held line", () => {
  it("the reason and the day it comes back", () => {
    expect(heldWords("waiting on the permit", "2026-10-03", TODAY)).toBe("waiting on the permit · back Oct 3");
  });
  it("a day already come is back today, never days ago", () => {
    expect(heldWords("waiting on the permit", "2026-09-20", TODAY)).toBe("waiting on the permit · back today");
    expect(heldWords("x", TODAY, TODAY)).toBe("x · back today");
  });
  it("a hold from before 0366 says it has no day; a database without 0366 says no day at all", () => {
    expect(heldWords("waiting on the permit", null, TODAY)).toBe("waiting on the permit · no day set");
    expect(heldWords("waiting on the permit", undefined, TODAY)).toBe("waiting on the permit");
  });
});

describe("the office's pill", () => {
  it("one tappable pill, Title Case, in the status's colours, with a chevron and a menu", () => {
    const html = render({ status: "to_be_scheduled" });
    expect(statusTitle("to_be_scheduled")).toBe("To Be Scheduled");
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*>To Be Scheduled/);
    expect(html).toContain("min-h-11");
    expect(html).toContain("bg-amber-100");
    expect(html).toContain("lucide-chevron-down");
    // The menu opens on a tap; closed, no rows are drawn.
    expect(html).not.toContain('role="menu"');
  });

  it("held: the reason and the day beside the pill, and Snooze (44px)", () => {
    const html = render({ status: "on_hold", holdReason: "waiting on the permit", holdUntil: "2026-10-03" });
    expect(html).toMatch(/>On Hold<svg/);
    expect(html).toContain("· waiting on the permit · back Oct 3");
    expect(html).toMatch(/<button[^>]*min-h-11[^>]*>Snooze<\/button>/);
  });

  it("who held it rides along as the line's title", () => {
    const html = render({ status: "on_hold", holdReason: "waiting on the permit", holdUntil: "2026-10-03", holdBy: "Erik Taylor" });
    expect(html).toContain('title="Put on hold by Erik Taylor"');
  });

  it("not held: no Snooze and no held line", () => {
    const html = render({ status: "scheduled", holdReason: "stale words", holdUntil: "2026-10-03" });
    expect(html).not.toContain("Snooze");
    expect(html).not.toContain("stale words");
  });
});

describe("the crew's pill", () => {
  it("the same pill and words, nothing to tap", () => {
    const html = render({ viewerIsStaff: false, status: "on_hold", holdReason: "waiting on the permit", holdUntil: "2026-10-03" });
    expect(html).toContain(">On Hold<");
    expect(html).toContain("· waiting on the permit · back Oct 3");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Snooze");
  });
});

describe("the header and the dock (source)", () => {
  const page = src("page.tsx");
  const dock = src("job-action-dock.tsx");
  const manage = src("job-manage-menu.tsx");

  it("the J-number once: the breadcrumb keeps it, the header's subline doesn't", () => {
    expect(page).toContain('<span className="font-medium text-slate-700">{j.job_number}</span>');
    expect(page).not.toContain("<span>{j.job_number}</span>");
  });

  it("the status control lives in the header, and the Overview has no Status cell", () => {
    expect(page).toMatch(/<JobStatusControl\s+id=\{j\.id\}/);
    expect(page).toContain("todayStr={todayStrInTz(tz)}");
    expect(page).toContain('holdUntil={"hold_until" in j ?');
    expect(page).not.toMatch(/>Status<\/div>/);
  });

  it("Manage is the office's: Edit Job, Finish Job, a divider, Delete Job; a tech's dock draws none", () => {
    expect(dock).toMatch(/\{viewerIsStaff && \(\s*<div className="ml-auto shrink-0">\s*<JobManageMenu/);
    for (const gone of ["Create Invoice", "All Jobs", "createInvoice", "customerId", "ProposeDatesButton"]) {
      expect(code(manage) + code(dock), gone).not.toContain(gone);
    }
    expect(manage).toContain("Delete Job");
    expect(dock).toContain("<JobEditButton menuItem");
    expect(dock).toContain("<FinishJobButton");
    expect(MANAGE_ROW_CLS).toContain("min-h-11");
  });

  it("Offer Dates moved beside the Overview's Scheduled (not cut), for the office on a job still to schedule", () => {
    expect(page).toMatch(/\{schedulable && \(\s*<ProposeDatesButton/);
    const offer = src("propose-dates-button.tsx");
    expect(offer).toContain('"Dates Offered…" : "Offer Dates"');
    expect(offer).toContain("your job");
    expect(offer).not.toContain("electrical work");
  });
});
