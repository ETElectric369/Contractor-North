import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countOpen,
  isOpenAppointment,
  isOpenBill,
  isOpenChangeOrder,
  isOpenInvoice,
  isOpenJob,
  isOpenPermit,
  isOpenPurchaseOrder,
  isOpenQuote,
  isOpenWorkOrder,
} from "@/lib/open-counts";

/**
 * EVERY BADGE COUNTS ONLY WHAT'S OPEN (Erik, 2026-09-27: "and all badges only show whats open").
 * A number on a chip, a tab or a tile is the rows that still need someone, and nothing at zero. A
 * total (shifts, items in the book, safety records, filed papers) is not a badge. Pinned two ways:
 * the per-kind rules (lib/open-counts), and every tab count in the app named here, so a new one is
 * a decision, not an accident.
 *
 * ONE NAMED EXCEPTION (Erik, minutes later: "keep the badge for total job photos"): the job's Photos
 * chip keeps a TOTAL, the number of job-site photos. It is the only total badge in the app.
 */

describe("the per-kind 'still needs someone' rules", () => {
  it("jobs: in flight, never done or cancelled", () => {
    for (const s of ["to_be_scheduled", "scheduled", "in_progress", "on_hold"]) expect(isOpenJob(s)).toBe(true);
    for (const s of ["complete", "cancelled", null]) expect(isOpenJob(s)).toBe(false);
  });

  it("estimates: a draft to send or one waiting on the customer", () => {
    expect(isOpenQuote("draft")).toBe(true);
    expect(isOpenQuote("sent")).toBe(true);
    for (const s of ["accepted", "declined", "expired"]) expect(isOpenQuote(s)).toBe(false);
  });

  it("invoices: an unsent draft or a sent bill with a balance; paid, void, and paid-with-a-lagging-status never", () => {
    expect(isOpenInvoice({ status: "draft", total: 100, amount_paid: 0 })).toBe(true);
    expect(isOpenInvoice({ status: "sent", total: 100, amount_paid: 0 })).toBe(true);
    expect(isOpenInvoice({ status: "partial", total: 100, amount_paid: 40 })).toBe(true);
    expect(isOpenInvoice({ status: "overdue", total: 100, amount_paid: 0 })).toBe(true);
    expect(isOpenInvoice({ status: "paid", total: 100, amount_paid: 100 })).toBe(false);
    expect(isOpenInvoice({ status: "void", total: 100, amount_paid: 0 })).toBe(false);
    expect(isOpenInvoice({ status: "sent", total: 100, amount_paid: 100 })).toBe(false);
  });

  it("change orders, work orders, permits, visits, bills, orders", () => {
    expect(isOpenChangeOrder("pending")).toBe(true);
    expect(isOpenChangeOrder("approved")).toBe(false);
    expect(isOpenWorkOrder("assigned")).toBe(true);
    expect(isOpenWorkOrder("complete")).toBe(false);
    expect(isOpenPermit("failed")).toBe(true);
    expect(isOpenPermit("inspection_scheduled")).toBe(true);
    expect(isOpenPermit("passed")).toBe(false);
    expect(isOpenPermit("closed")).toBe(false);
    expect(isOpenAppointment("scheduled")).toBe(true);
    expect(isOpenAppointment("proposed")).toBe(true);
    expect(isOpenAppointment("completed")).toBe(false);
    expect(isOpenBill({ status: "unpaid" })).toBe(true);
    expect(isOpenBill({ status: "unpaid", superseded: true })).toBe(false);
    expect(isOpenBill({ status: "paid" })).toBe(false);
    expect(isOpenPurchaseOrder("sent")).toBe(true);
    expect(isOpenPurchaseOrder("received")).toBe(false);
  });

  it("countOpen counts only the open rows, and nothing is 0", () => {
    expect(countOpen([{ s: "draft" }, { s: "accepted" }, { s: "sent" }], (r) => isOpenQuote(r.s))).toBe(2);
    expect(countOpen(null, () => true)).toBe(0);
  });
});

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

/** Every `count:` a tab definition carries, app-wide, and the open count it is. Adding a tab count
 *  means adding it here, with what it counts. */
const OPEN_TAB_COUNTS: Record<string, string> = {
  openTaskCount: "the job's open tasks + the live Buy Materials row while anything is left to buy",
  materialsOpen: "the job's materials lines still to buy",
  costsOpen: "the job's Not Billed Yet costs + supplier papers naming it that are in nobody's books + one for its hours not billed yet",
  panelCount: "suggested circuits waiting on a Keep or a Not This",
  "tray.length": "Organize's Needs Attention tray",
};

/** Erik's one exception, a TOTAL on purpose: "keep the badge for total job photos". The job's Photos
 *  chip counts the job-site photos: fix/photos-vs-bills' Photos grid, never the Plans & Other Papers
 *  fold under it (a plan or a permit is no job-site photo), a receipt or a bill. Nothing else may
 *  use a total. */
const PHOTOS_TOTAL_EXCEPTION: Record<string, string> = {
  "paperSort.photos.length": "Erik's exception: total job-site photos (the Photos grid, photos-vs-bills split)",
};

describe("every tab count in the app is an open count", () => {
  const files = walk(SRC).filter((f) => /<Tabs\b/.test(readFileSync(f, "utf8")));

  it("finds the tab strips", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("each count is a countOpen(...) with an isOpen rule, or a named open figure", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      for (const lineText of readFileSync(f, "utf8").split("\n")) {
        // A tab's count: its own line in a tab object, or inline in a one-line { id, label, count }.
        const own = lineText.match(/^\s*count:\s*(.+?),?\s*$/);
        const inline = lineText.match(/\{\s*id:\s*"[^"]+",\s*label:\s*"[^"]+",\s*count:\s*(.+?)(?:,\s*offStrip:[^}]*)?\s*\},?\s*$/);
        const expr = (own ?? inline)?.[1]?.trim();
        if (!expr || /^number\b/.test(expr)) continue; // no count here, or a type annotation
        seen += 1;
        if (/^countOpen\(/.test(expr) && /isOpen[A-Z]\w*/.test(expr)) continue;
        if (expr in OPEN_TAB_COUNTS || expr in PHOTOS_TOTAL_EXCEPTION) continue;
        bad.push(`${f.replace(SRC, "")}: count: ${expr}`);
      }
    }
    expect(bad).toEqual([]);
    // The scan really reads the strips (job 10, customer 3, bills 2, Organize 1), so it can't pass by
    // matching nothing.
    expect(seen).toBeGreaterThanOrEqual(16);
  });

  it("the job's Photos chip keeps its total (Erik's exception), Time carries no badge, and Materials counts only what's to buy", () => {
    const page = read("app/(app)/jobs/[id]/page.tsx");
    const tab = (id: string) => page.slice(page.indexOf(`id: "${id}",`), page.indexOf("content:", page.indexOf(`id: "${id}",`)));
    // "keep the badge for total job photos": the one total badge, and only the job-site photos.
    const photos = tab("photos").match(/^\s*count:\s*(.+?),?\s*$/m)?.[1]?.trim();
    expect(photos && photos in PHOTOS_TOTAL_EXCEPTION, `Photos count: ${photos}`).toBe(true);
    // Job-site photos only: no plan or permit (pictures), no receipt, no bill rides the total.
    expect(photos).not.toMatch(/pictures|byBill|moneyPictures|docs\./);
    expect(tab("time")).not.toMatch(/\bcount:/);
    expect(tab("materials")).toContain("count: materialsOpen");
    expect(page).not.toContain("count: canonicalItems?.length");
  });

  it("the job's Costs chip counts its hours not billed yet (as one), where the tab says them", () => {
    const page = read("app/(app)/jobs/[id]/page.tsx");
    const costsOpen = page.slice(page.indexOf("const costsOpen ="), page.indexOf(";", page.indexOf("const costsOpen =")));
    expect(costsOpen).toContain("costGroups?.open.ids.length");
    expect(costsOpen).toContain("costGroups && unbilled && unbilled.hours > 0 ? 1 : 0");
    // The tab's own sentence is behind the same costGroups && unbilled guard.
    expect(page).toMatch(/costGroups && unbilled \? \(\s*<div className="space-y-2">/);
  });

  it("the job's Tasks chip draws no number when the tasks couldn't be read (never the Buy Materials row alone)", () => {
    const page = read("app/(app)/jobs/[id]/page.tsx");
    expect(page).toContain("const openTaskCount = jobTasks.failed ? undefined : jobTaskTally(jobTasks.rows, buy).open;");
  });
});

describe("the chrome's other numbers", () => {
  it("the dock badges only Needs You (/planner, decisions only) and new unanswered leads (/leads)", () => {
    const layout = read("app/(app)/layout.tsx");
    expect(layout).toContain('return { "/planner": needsAction, "/leads": freshLeads };');
    expect(layout).toMatch(/\.eq\("status", "new"\)\s*\.is\("converted_at", null\)/);
  });

  it("the bell counts unread notifications only", () => {
    expect(read("components/app-shell/notification-bell.tsx")).toContain("const unread = items.filter((n) => !n.read_at).length;");
  });

  it("the section sheet's handle carries no page-count pill", () => {
    expect(read("components/section-sheet.tsx")).not.toContain('items.filter((c) => c.href).length}');
  });

  it("no badge pill anywhere draws a list's size ({x.length}): a total is plain text", () => {
    const pills: string[] = [];
    for (const f of walk(SRC)) {
      for (const m of readFileSync(f, "utf8").matchAll(/<Badge\b[^>]*>\s*\{[^}]*\.length\}\s*<\/Badge>/g)) {
        pills.push(`${f.replace(SRC, "")}: ${m[0]}`);
      }
    }
    expect(pills).toEqual([]);
  });

  it("the Completed shelf says its size in plain words, not a pill", () => {
    expect(read("app/(app)/jobs/completed-section.tsx")).not.toMatch(/rounded-full[^"]*">\{total\}/);
  });
});
