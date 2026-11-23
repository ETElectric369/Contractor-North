import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * READ AGAIN IS ON THE JOB'S OWN BILL ROW (cn-v1182). The door lived one screen away, a small link
 * under a bill's lines on /bills, and the person standing on a job's Costs tab with marked papers in
 * front of him asked how to read them again, or whether to delete them and snap again. The row
 * carries it now, only where the server will not refuse it.
 */
vi.mock("@/app/(app)/jobs/actions", () => ({ deleteBill: vi.fn(), setBillStatus: vi.fn(), createBill: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));

const { JobBills, rowOffersReadAgain } = await import("./job-bills");

const owed = { status: "unpaid", amount: 120, amount_paid: 0, corrects_bill_id: null };

describe("rowOffersReadAgain", () => {
  it("a bill with its paper, on no invoice, nothing paid: offered", () => {
    expect(rowOffersReadAgain({ hasPaper: true, pile: "open", bill: owed, hasCorrections: false })).toBe(true);
    expect(rowOffersReadAgain({ hasPaper: true, pile: "nothing", bill: owed, hasCorrections: false })).toBe(true);
    // The number never read (an older row): the status word decides, and unpaid is owed.
    expect(rowOffersReadAgain({ hasPaper: true, pile: "open", bill: { status: "unpaid", amount: 120 }, hasCorrections: false })).toBe(true);
  });
  it("no paper: there is no picture to read", () => {
    expect(rowOffersReadAgain({ hasPaper: false, pile: "open", bill: owed, hasCorrections: false })).toBe(false);
  });
  it("the Billed fold and the one plain list never offer it: the row cannot know no sent invoice bills it", () => {
    expect(rowOffersReadAgain({ hasPaper: true, pile: "billed", bill: owed, hasCorrections: false })).toBe(false);
    expect(rowOffersReadAgain({ hasPaper: true, pile: "plain", bill: owed, hasCorrections: false })).toBe(false);
  });
  it("anything paid on it, or settled: a payment record would go with the bill", () => {
    expect(rowOffersReadAgain({ hasPaper: true, pile: "open", bill: { ...owed, amount_paid: 20 }, hasCorrections: false })).toBe(false);
    expect(rowOffersReadAgain({ hasPaper: true, pile: "open", bill: { ...owed, status: "paid", amount_paid: 120 }, hasCorrections: false })).toBe(false);
    expect(rowOffersReadAgain({ hasPaper: true, pile: "open", bill: { status: "paid", amount: 120 }, hasCorrections: false })).toBe(false);
  });
  it("a correction, or a bill with one under it: the pair is one purchase", () => {
    expect(rowOffersReadAgain({ hasPaper: true, pile: "open", bill: { ...owed, corrects_bill_id: "b0" }, hasCorrections: false })).toBe(false);
    expect(rowOffersReadAgain({ hasPaper: true, pile: "open", bill: owed, hasCorrections: true })).toBe(false);
  });
});

describe("the row draws it", () => {
  const bill = (id: string, o: Record<string, unknown> = {}) => ({
    id,
    supplier: "Northline Supply",
    bill_number: `N-${id}`,
    amount: 120,
    status: "unpaid",
    amount_paid: 0,
    bill_date: "2026-11-20",
    bill_line_items: [{ description: "20A breaker", amount: 120, billable: true }],
    ...o,
  });
  const bills = [bill("open1"), bill("nopaper"), bill("paid1", { status: "paid", amount_paid: 120 }), bill("billed1"), bill("own1")];
  const paper = (id: string) => [{ id: `p-${id}`, kind: "image", url: `https://example.com/${id}.jpg`, label: "Receipt" }];
  // Every bill shows a Receipt door; "nopaper" has one that was only TIED to it (it was typed by hand).
  const papers = { open1: paper("open1"), nopaper: paper("nopaper"), paid1: paper("paid1"), billed1: paper("billed1"), own1: paper("own1") };
  const madeFromPaper = ["open1", "paid1", "billed1", "own1"];
  const invoice = { id: "inv-900", invoice_number: "INV-900", status: "sent", created_at: "2026-11-21T10:00:00Z" };
  const groups = {
    open: { ids: ["open1", "nopaper", "paid1"], bills: 3, pos: 0, takes: 0, total: 360 },
    openOwn: {},
    billed: [{ ids: ["billed1"], bills: 1, pos: 0, takes: 0, total: 120, invoice, draft: false, offJobNumber: null }],
    nothing: [{ id: "own1", why: "own" }],
    stock: {},
  };
  /** One bill's row: from its own <li> to the next. */
  const rowOf = (html: string, number: string) => {
    const at = html.indexOf(`#${number} `);
    expect(at).toBeGreaterThan(-1);
    const start = html.lastIndexOf("<li", at);
    const end = html.indexOf("</li>", at);
    return html.slice(start, end);
  };
  const html = renderToStaticMarkup(createElement(JobBills, { jobId: "j-larkspur", bills: bills as any, pos: [], groups: groups as any, papers: papers as any, madeFromPaper }));

  it("on the open bill with its paper, a real button beside the row's other doors", () => {
    const row = rowOf(html, "N-open1");
    expect(row).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Read Again<\/button>/);
    // After the row's own doors, before Open the Bill.
    expect(row.indexOf("Read Again")).toBeGreaterThan(row.indexOf("Delete"));
    expect(row.indexOf("Read Again")).toBeLessThan(row.indexOf("Open the Bill"));
  });
  it("on a bill that is never billed, too", () => {
    expect(rowOf(html, "N-own1")).toContain("Read Again");
  });
  it("not on a bill a paper is only tied to, not on a paid bill, not in the Billed fold", () => {
    expect(rowOf(html, "N-nopaper")).toContain("Receipt");
    expect(rowOf(html, "N-nopaper")).not.toContain("Read Again");
    expect(rowOf(html, "N-paid1")).not.toContain("Read Again");
    expect(rowOf(html, "N-billed1")).not.toContain("Read Again");
  });
  it("the one plain list (the claims could not be read) offers none", () => {
    const plain = renderToStaticMarkup(createElement(JobBills, { jobId: "j-larkspur", bills: bills as any, pos: [], groups: null, papers: papers as any, madeFromPaper }));
    expect(plain).not.toContain("Read Again");
  });
  it("the confirm is not mounted until asked (never an open sheet on a fresh page)", () => {
    expect(html).not.toContain("taken down and made again");
  });
});

describe("which bills a paper made", () => {
  it("bill_id with a picture on file; never a paper only tied to a bill, never one with no file", async () => {
    const { billsMadeFromPaper } = await import("@/lib/job-photos");
    expect(
      billsMadeFromPaper([
        { bill_id: "b1", file_url: "org/a.jpg" },
        { bill_id: "b1", file_url: "org/a-2.jpg" },
        { bill_id: null, file_url: "org/b.jpg", tied_bill_id: "b2" } as any,
        { bill_id: "b3", file_url: null },
      ]),
    ).toEqual(["b1"]);
    expect(billsMadeFromPaper(null)).toEqual([]);
  });
  it("the page hands that list down, and nothing else decides the row", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toContain("madeFromPaper={billsMadeFromPaper(paperTies)}");
    const row = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-bills.tsx"), "utf8");
    expect(row).toContain("hasPaper: madeFrom.has(b.id), pile,");
  });
});

describe("one confirm, the one /bills uses", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-bills.tsx"), "utf8");
  it("the row opens ReadAgainConfirm from the bill's own card, mounted once and never keyed", () => {
    expect(src).toContain('import { ReadAgainConfirm } from "@/app/(app)/bills/receipt-billing-card";');
    expect(src.match(/<ReadAgainConfirm\b/g)?.length).toBe(1);
    expect(src).not.toMatch(/<ReadAgainConfirm[^>]*\bkey=/);
  });
  it("owed is asked of the one function", () => {
    expect(src).toContain('import { isStillOwed } from "@/lib/supplier-owed";');
  });
});
