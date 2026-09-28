import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * TYPE IT IN: THE ONE TYPED COST SHEET (W1-23, W1-32). The job's Costs tab ⋯ opens it with the job
 * preselected; /bills' Add By Hand opens it with the job picker first. It replaced the Costs tab's
 * Add Bill sheet, /bills' Add Business Cost and its Add A Bill By Hand fold, so the rules those
 * three carried are pinned here, on the one sheet:
 *   · a blank job is not a business cost, and no bucket is picked for him;
 *   · On Account (still owed) is never saved as paid;
 *   · a business cost with no Where is saved under its bucket's own name;
 *   · Shop Stock (switch on only) is a door to Snap Or Note, never a guessed save.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ createBill: vi.fn(), deleteBill: vi.fn(), linkReceiptToBill: vi.fn() }));
vi.mock("@/app/(app)/organize/actions", () => ({ billJobReceipt: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ DIFFERENT_PURCHASE_DOOR: "", fileReceiptDocument: vi.fn() }));
vi.mock("@/components/snap-or-note", () => ({ openSnapOrNote: vi.fn() }));
// The sheet's body, drawn as if open: a static render never taps the trigger.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) =>
    createElement("div", { "data-sheet": title }, children, footer),
  ModalActions: ({ saveLabel }: { saveLabel?: string }) => createElement("button", { "data-save": "" }, saveLabel ?? "Save"),
}));

const { QuickCostButton, SHOP_STOCK_BY_PAPER, JOBS_UNREAD_LINE, jobPickLabel, typedCostBill, typedCostProblem } = await import("./quick-cost-button");

const base = { amount: 64.1, date: "2026-09-27", target: "", bucket: null, where: "", paid: "paid" as const, billNumber: "", poId: "" };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const buttons = (html: string) =>
  Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)).map((m) => ({ attrs: m[1], words: text(m[2]).trim() }));

describe("what the typed sheet refuses, in words", () => {
  it("a blank job is not a business cost: nothing picked asks for a job or Business Cost and its bucket", () => {
    expect(typedCostProblem(base)).toBe("Pick the job it's for, or Business Cost and its bucket.");
  });

  it("no bucket is picked for him: Business Cost with no bucket asks for one", () => {
    expect(typedCostProblem({ ...base, target: "__business" })).toBe("Tap the bucket this business cost goes in.");
    expect(typedCostProblem({ ...base, target: "__business", bucket: "Fuel" })).toBeNull();
  });

  it("a job's cost says where it was bought; a business cost's Where is optional", () => {
    expect(typedCostProblem({ ...base, target: "job-011" })).toBe("Say where it was bought (the supplier).");
    expect(typedCostProblem({ ...base, target: "job-011", where: "Supply House" })).toBeNull();
  });

  it("an amount and a day are needed", () => {
    expect(typedCostProblem({ ...base, amount: 0, target: "__business", bucket: "Fuel" })).toBe("Type the amount.");
    expect(typedCostProblem({ ...base, date: "", target: "__business", bucket: "Fuel" })).toBe("Pick the day it was bought.");
  });

  it("Shop Stock is never a typed save: it says the paper goes in through Snap Or Note", () => {
    expect(typedCostProblem({ ...base, target: "__stock" })).toBe(SHOP_STOCK_BY_PAPER);
    expect(SHOP_STOCK_BY_PAPER).toContain("Snap Or Note");
  });

  it("Nort's product map says the same: Add By Hand never adds stock, and stock comes in through Snap Or Note", async () => {
    const { NORT_PRODUCT_MAP } = await import("@/lib/nort-product-map");
    const bills = NORT_PRODUCT_MAP.split("\n").find((l) => l.includes("Money → Bills"))!;
    const hand = bills.slice(bills.indexOf("Add By Hand ("), bills.indexOf("), and All Bills"));
    expect(hand).toContain("a job or a business cost in its bucket");
    expect(hand).not.toMatch(/business cost in its bucket, or stock/);
    expect(hand).toContain("It never adds stock");
    expect(hand).toContain("through Snap Or Note");
  });
});

describe("what the typed sheet hands createBill", () => {
  it("On Account (still owed) is never saved as paid; Already Paid is", () => {
    expect(typedCostBill({ ...base, target: "job-011", where: "Supply House", paid: "unpaid" }).status).toBe("unpaid");
    expect(typedCostBill({ ...base, target: "job-011", where: "Supply House", paid: "paid" }).status).toBe("paid");
  });

  it("a business cost with no Where is saved under its bucket's own name, with no job and no order", () => {
    expect(typedCostBill({ ...base, target: "__business", bucket: "Fuel", poId: "po-1" })).toMatchObject({
      job_id: null,
      supplier: "Fuel",
      category: "Fuel",
      po_id: null,
      amount: 64.1,
      bill_date: "2026-09-27",
    });
    expect(typedCostBill({ ...base, target: "__business", bucket: "Auto", where: " Tire Shop " }).supplier).toBe("Tire Shop");
  });

  it("a job's cost is Materials on that job, with the order it pays and its Bill #", () => {
    expect(typedCostBill({ ...base, target: "job-011", where: "Supply House", poId: "po-7", billNumber: " 8802-1 " })).toMatchObject({
      job_id: "job-011",
      supplier: "Supply House",
      category: "Materials",
      po_id: "po-7",
      bill_number: "8802-1",
    });
    expect(typedCostBill({ ...base, target: "job-011", where: "Supply House" }).po_id).toBeNull();
  });

  it("names a job the way it is read: the place first, the number second", () => {
    expect(jobPickLabel({ job_number: "J-011", name: "13897 Herringbone" })).toBe("13897 Herringbone · J-011");
    expect(jobPickLabel({ job_number: "J-011", name: "" })).toBe("J-011");
  });
});

describe("the sheet as it is drawn", () => {
  const JOBS = [{ id: "job-011", label: "13897 Herringbone · J-011" }];
  const bills = renderToStaticMarkup(createElement(QuickCostButton, { typeOnly: true, jobs: JOBS, label: "Add By Hand", icon: "none" }));

  it("Add By Hand opens Type It In: What's It For? with the job picker first, then Business Cost", () => {
    expect(bills).toContain('data-sheet="Type It In"');
    const t = text(bills);
    expect(t).toContain("What's It For?");
    const select = bills.match(/<select[^>]*id="ti-job"[^>]*>([\s\S]*?)<\/select>/)!;
    expect(select).not.toBeNull();
    expect(text(select[1]).trim().startsWith("Pick A Job")).toBe(true);
    expect(select[1]).toContain("13897 Herringbone · J-011");
    const business = buttons(bills).find((b) => b.words === "Business Cost")!;
    expect(business.attrs).toContain("min-h-11");
    expect(business.attrs).toContain('aria-checked="false"');
  });

  it("no jobs yet and a jobs read that failed get different sentences (a failed read is never 'no jobs')", () => {
    const none = text(renderToStaticMarkup(createElement(QuickCostButton, { typeOnly: true, jobs: [], label: "Add By Hand", icon: "none" })));
    expect(none).toContain("No jobs to pick from yet. A cost with no job is a Business Cost.");
    expect(none).not.toContain(JOBS_UNREAD_LINE);
    const failed = renderToStaticMarkup(createElement(QuickCostButton, { typeOnly: true, jobs: [], jobsUnread: true, label: "Add By Hand", icon: "none" }));
    expect(text(failed)).toContain(JOBS_UNREAD_LINE);
    expect(text(failed)).not.toContain("No jobs to pick from yet");
    expect(failed).toMatch(/role="alert"/);
    expect(JOBS_UNREAD_LINE).toBe("Couldn't load your jobs just now. Reload the page to put this cost on a job.");
  });

  it("Shop Stock is offered only while the Shop Stock switch is on", () => {
    expect(buttons(bills).some((b) => b.words === "Shop Stock")).toBe(false);
    const on = renderToStaticMarkup(createElement(QuickCostButton, { typeOnly: true, jobs: JOBS, shopStock: true }));
    expect(buttons(on).find((b) => b.words === "Shop Stock")?.attrs).toContain("min-h-11");
  });

  it("Paid? starts on Already Paid, with On Account (Still Owed) beside it, both 44px", () => {
    const paid = buttons(bills).find((b) => b.words === "Already Paid")!;
    const owed = buttons(bills).find((b) => b.words === "On Account (Still Owed)")!;
    expect(paid.attrs).toContain('aria-checked="true"');
    expect(owed.attrs).toContain('aria-checked="false"');
    for (const b of [paid, owed]) expect(b.attrs).toContain("min-h-11");
  });

  it("Bill # waits inside More; Amount, Date and Where are on the sheet; it saves as Save Cost", () => {
    const more = bills.slice(bills.indexOf("<details"));
    expect(text(more)).toContain("More");
    expect(more).toContain('id="ti-number"');
    for (const id of ["ti-amount", "ti-date", "ti-where"]) expect(bills).toContain(`id="${id}"`);
    expect(bills).toMatch(/data-save="">Save Cost</);
  });

  it("the trigger is the words alone for Add By Hand, and the Costs tab's row names Type It In", () => {
    expect(buttons(bills)[0].words).toBe("Add By Hand");
    const costs = renderToStaticMarkup(createElement(QuickCostButton, { typeOnly: true, jobId: "job-011" }));
    expect(buttons(costs)[0].words).toBe("Type It In");
    // The job is preselected there: no picker, and the sheet says which cost it is.
    expect(costs).not.toContain('id="ti-job"');
    expect(text(costs)).toContain("A cost on this job, with no paper to snap.");
  });

  it("the snap sheet never sends a receipt to Receipts & Papers (it has no uploader); a saved cost's receipt is retried here", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/components/quick-cost-button.tsx"), "utf8");
    // Every sentence a person reads (quoted), never a comment: no "from the job's Receipts & Papers".
    const said = Array.from(src.matchAll(/(["`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)).map((m) => m[2]);
    expect(said.filter((w) => w.includes("Receipts & Papers"))).toEqual([]);
    const mod = await import("./quick-cost-button");
    // Before a save: one door or the other, named where it is.
    expect(mod.NO_PICKER_LINE("your photos")).toContain("Snap The Bill on the job's Costs tab");
    expect(mod.NO_PICKER_LINE("your photos")).toContain("Not both");
    // After a save: Retry Receipt, because Snap The Bill or Upload would record it again.
    expect(mod.RETRY_HERE_LINE).toContain("tap Retry Receipt");
    expect(mod.RETRY_HERE_LINE).toContain("record the cost a second time");
    expect(src).toContain("Cost saved ✓ — but the receipt ${attachClause()}. ${RETRY_HERE_LINE}");
    expect(src).toContain("Still couldn't attach it — the receipt ${attachClause()}. ${RETRY_HERE_LINE}");
  });

  it("the Now card's sheet is the snap sheet, as before (Add Cost, the receipt block)", () => {
    const now = renderToStaticMarkup(createElement(QuickCostButton, { jobId: "job-011", snapFirst: true }));
    expect(buttons(now)[0].words).toBe("Add Cost");
    expect(now).toContain('data-sheet="Add a cost"');
    expect(now).not.toContain('data-sheet="Type It In"');
  });
});
