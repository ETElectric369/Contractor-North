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
  costsOpen: "the job's Not Billed Yet costs + supplier papers naming it that are in nobody's books + its receipts on no bill yet (every one a row on the tab)",
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
    // The scan really reads the strips (job 11, customer 3, Organize 1), so it can't pass by matching
    // nothing. /bills has no tab strip any more: All Bills is one searchable list (W1-32), led by
    // what's open on its own line.
    expect(seen).toBeGreaterThanOrEqual(15);
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

  it("the job's Costs chip counts only rows the tab draws: no made-up 1 for the hours (fada712a)", () => {
    const page = read("app/(app)/jobs/[id]/page.tsx");
    const costsOpen = page.slice(page.indexOf("const costsOpen ="), page.indexOf(";", page.indexOf("const costsOpen =")));
    // The three piles, each a list of rows: Not Billed Yet, the supplier's papers in nobody's books,
    // and the receipts the Receipts & Papers fold calls "Not On A Bill Yet" (from the very list the
    // fold is handed). Not Billed Yet is counted as the pile ids the tab DRAWS (a bill, an order, a
    // take from stock — lib/job-cost-groups openRowsDrawn), and an id no row stands behind is
    // reported, never counted (J-013 again, 2026-09-29: the chip still said 3 on one live bill).
    expect(costsOpen).toContain("openDrawn.drawn.length");
    expect(costsOpen).not.toContain("open.ids.length");
    expect(page).toContain("openRowsDrawn(costGroups,");
    expect(page).toContain('reportError("jobs.[id].costsChip"');
    expect(costsOpen).toContain("(paperViews ?? []).filter((p) => !p.waitingOnCredit).length");
    expect(costsOpen).toContain("viewerIsStaff && paperSort.loose ? paperSort.loose.length : 0");
    expect(page).toContain("looseIds={paperSort.loose ? paperSort.loose.map(");
    // J-013 (ARR #56): 1 live bill, 0 papers, and the chip said 3. A "1" that is no row could never
    // be checked against the tab; the hours are said in words beside the door that bills them.
    expect(costsOpen).not.toContain("unbilled.hours");
    expect(costsOpen).not.toMatch(/\? 1 : 0/);
    // The tab's sentence about the hours is still there, behind its costGroups && unbilled guard.
    expect(page).toMatch(/costGroups && unbilled \? \(\s*<div className="space-y-2">/);
    expect(page).toContain("`Also not billed yet: ${formatDuration(unbilled.hours)} of time, ${formatCurrency(unbilled.laborAmount)}.`");
  });

  it("the job's Tasks chip draws no number when the tasks couldn't be read (never the Buy Materials row alone)", () => {
    const page = read("app/(app)/jobs/[id]/page.tsx");
    expect(page).toContain("const openTaskCount = jobTasks.failed ? undefined : jobTaskTally(jobTasks.rows, buy).open;");
  });
});

/**
 * A PILE OF OPEN WORK WEARS NO SETTLED PILL EITHER (report 8592392b, 2026-10-02: "glaring on the
 * front is [a customer] tagged Done while it sits in the open box"). /inspections draws ONE row
 * component for the open piles and the filed pile, and its green Done pill came off
 * `status === "completed"` alone — so every row of "To write up", Create Estimate button and all,
 * said it was finished. The tags now come from ONE rule (lib/inspections inspectionRowTags) and the
 * page writes none of its own, which is what stops the next one riding into the wrong pile.
 */
describe("the open Inspections pile wears no Done pill", () => {
  it("every tag on a row comes from the one rule — the page writes none itself", () => {
    const page = read("app/(app)/inspections/page.tsx");
    expect(page).toContain("{inspectionRowTags(a, writeUp).map((t) => (");
    // One <Badge> on the page, and it is the mapped one. A tag written inline here is the bug.
    expect([...page.matchAll(/<Badge\b/g)].length).toBe(1);
    expect(page).not.toMatch(/<Badge[^>]*tone="/);
  });
});

describe("the chrome's other numbers", () => {
  it("the dock badges Needs You (/planner), new unanswered leads (/leads) and Reconcile — and nothing else", () => {
    const layout = read("app/(app)/layout.tsx");
    expect(layout).toContain('return { "/planner": needsAction, "/leads": freshLeads, "/reconcile": await reconcileP };');
    expect(layout).toMatch(/\.eq\("status", "new"\)\s*\.is\("converted_at", null\)/);
    // Three keys in the whole map, and the amber dot on a tile is their sum over the rows it draws.
    expect([...layout.matchAll(/"\/(planner|leads|reconcile)":/g)].length).toBe(6);
  });

  /**
   * RECONCILE'S DOT IS A ROLLUP OVER KINDS, NOT A PILE OF ROWS (cn-v1037).
   *
   * A reconcile pile is undated and unbounded — papers under five spellings wait as long as nobody
   * sorts them — and the badge invariant forbids counting a set like that on chrome. So the dot is
   * how many KINDS have anything open, bounded by the union, and it reads THE SAME function the page
   * reads so the two can never say different things.
   */
  it("Reconcile's dot counts kinds (a rollup), from the page's own read, and never through Needs You", () => {
    const layout = read("app/(app)/layout.tsx");
    expect(layout).toContain('import { readReconcileWork } from "@/app/(app)/reconcile/reconcile-read"');
    expect(layout).toContain("return reconcileBadge(work.counts);");
    // Not a row count, and not the Needs You engine (My Day stockpiled what he could not act on).
    expect(layout).not.toMatch(/reconcile[^\n]*\.length/);
    expect(layout).not.toContain("getActionItemsCount({ ...");
    // Staff only: a tech's shell never spends a query on a page he cannot open.
    expect(layout).toContain("if (!isStaff || !profile.org_id) return 0;");
  });

  it("the Sales dot counts only the leads due now: a lead snoozed from Needs You waits for its day, like its row", () => {
    const layout = read("app/(app)/layout.tsx");
    // Right after the two pinned calls, the same rule as Needs You's lead read: no day, or a day that
    // has come, by the company's today.
    expect(layout).toMatch(/\.eq\("status", "new"\)\s*\.is\("converted_at", null\)\s*\.or\(`next_follow_up_at\.is\.null,next_follow_up_at\.lte\.\$\{today\}`\)/);
    expect(layout).toMatch(/const today = todayStrInTz\(getOrgSettings\(\(await orgP\)\?\.settings\)\.timezone/);
  });

  it("the bell counts unread notifications only, as the database counts them (never the 20 lines it shows)", () => {
    const bell = read("components/app-shell/notification-bell.tsx");
    expect(bell).toContain("const badge = bellBadge(unread);");
    expect(bell).toContain("setUnread(r.unread);");
    expect(bell).not.toContain("items.filter((n) => !n.read_at).length");
    // The count is an exact head count of the unread lines, the partial index's own predicate.
    const actions = read("app/(app)/notification-actions.ts");
    expect(actions).toMatch(/\.select\("id", \{ count: "exact", head: true \}\)\.eq\("user_id", user\.id\)\.is\("read_at", null\)/);
    // 9+ above nine, and nothing at zero.
    expect(read("lib/bell-words.ts")).toContain('return n > 9 ? "9+" : String(n);');
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
