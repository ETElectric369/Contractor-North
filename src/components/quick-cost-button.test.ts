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
 *   · Shop Stock (switch on only) saves from the sheet (W1-FU-misc B): what it is, how many, in what
 *     unit and where, into stock through addStockPurchase, with the ticket's door (Snap Or Note) one
 *     quiet line away. It used to be only that door, and it threw away what was typed.
 *
 * NORT'S PRODUCT MAP still says Add By Hand never adds stock: lane 6 (the wave's words) rewrites that
 * Money → Bills line and pins it in nort-product-map.test.ts. This file no longer pins the old words.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ createBill: vi.fn(), deleteBill: vi.fn(), linkReceiptToBill: vi.fn() }));
vi.mock("@/app/(app)/organize/actions", () => ({ billJobReceipt: vi.fn() }));
vi.mock("@/app/(app)/inventory/actions", () => ({ addStockPurchase: vi.fn(), shelfPickerItems: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ DIFFERENT_PURCHASE_DOOR: "", fileReceiptDocument: vi.fn() }));
vi.mock("@/components/snap-or-note", () => ({ openSnapOrNote: vi.fn() }));
// The sheet's body, drawn as if open: a static render never taps the trigger.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) =>
    createElement("div", { "data-sheet": title }, children, footer),
  ModalActions: ({ saveLabel }: { saveLabel?: string }) => createElement("button", { "data-save": "" }, saveLabel ?? "Save"),
}));

const {
  QuickCostButton,
  JOBS_UNREAD_LINE,
  STOCK_HAVE_THE_TICKET,
  StockFields,
  StockTicketLine,
  jobPickLabel,
  readerFallbackLine,
  typedCostBill,
  typedCostProblem,
  typedStockPurchase,
} = await import("./quick-cost-button");

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

  it("Shop Stock saves when it says what it is, how many, in what unit and where, asked in that order", () => {
    const stock = { ...base, target: "__stock" };
    expect(typedCostProblem(stock)).toBe("Pick or name the item.");
    expect(typedCostProblem({ ...stock, stockItem: "__new", stockName: "  " })).toBe("Pick or name the item.");
    expect(typedCostProblem({ ...stock, stockItem: "__new", stockName: "12/2 NM-B" })).toBe("Type how many.");
    expect(typedCostProblem({ ...stock, stockItem: "__new", stockName: "12/2 NM-B", stockPieces: 250 })).toBe("Say the unit.");
    expect(typedCostProblem({ ...stock, stockItem: "__new", stockName: "12/2 NM-B", stockPieces: 250, stockUnit: "ft" })).toBe("Say where it was bought.");
    expect(typedCostProblem({ ...stock, stockItem: "__new", stockName: "12/2 NM-B", stockPieces: 250, stockUnit: "ft", where: "CED" })).toBeNull();
    // An item already in stock carries its own unit (the sheet locks it and hands it in).
    expect(typedCostProblem({ ...stock, stockItem: "item-7", stockPieces: 2, stockUnit: "box", where: "CED" })).toBeNull();
    // The typed sheet's own rules still come first.
    expect(typedCostProblem({ ...stock, amount: 0, stockItem: "item-7", stockPieces: 2, stockUnit: "box", where: "CED" })).toBe("Type the amount.");
    expect(typedCostProblem({ ...stock, date: "", stockItem: "item-7", stockPieces: 2, stockUnit: "box", where: "CED" })).toBe("Pick the day it was bought.");
  });
});

describe("what the typed sheet hands addStockPurchase", () => {
  const stock = { ...base, amount: 180, target: "__stock", where: " CED ", stockPieces: 250, stockUnit: " ft " };

  it("an item in stock goes by its id, a new one by its name, never both", () => {
    expect(typedStockPurchase({ ...stock, stockItem: "item-7", stockName: "ignored" })).toMatchObject({ itemId: "item-7", newItemName: null, pieces: 250, unit: "ft", where: "CED", amount: 180, date: "2026-09-27" });
    expect(typedStockPurchase({ ...stock, stockItem: "__new", stockName: " 12/2 NM-B " })).toMatchObject({ itemId: null, newItemName: "12/2 NM-B" });
  });

  it("On Account (still owed) is never saved as paid; the Bill # rides along", () => {
    expect(typedStockPurchase({ ...stock, stockItem: "item-7", paid: "unpaid" }).paid).toBe("unpaid");
    expect(typedStockPurchase({ ...stock, stockItem: "item-7", paid: "paid" }).paid).toBe("paid");
    expect(typedStockPurchase({ ...stock, stockItem: "item-7", billNumber: " 8802-1 " }).billNumber).toBe("8802-1");
    expect(typedStockPurchase({ ...stock, stockItem: "item-7" }).billNumber).toBeNull();
  });

  it("the sheet saves Shop Stock through addStockPurchase, and its Undo is deleteBill", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/components/quick-cost-button.tsx"), "utf8");
    expect(src).toContain("if (target === STOCK) return saveStock(fields);");
    expect(src).toContain("callOrLost(() => addStockPurchase(purchase),");
    const saveStock = src.slice(src.indexOf("function saveStock("), src.indexOf("return (", src.indexOf("function saveStock(")));
    expect(saveStock).toContain('label: "Undo"');
    expect(saveStock).toContain('void deleteBill(id, "")');
    // Nothing typed is thrown away unless he chooses it; with nothing typed, the door just opens.
    const door = src.slice(src.indexOf("function openTheTicketDoor("), src.indexOf("function save("));
    expect(door).toContain("const typed = amount > 0 || !!where.trim() || !!billNumber.trim() || !!stockItem || !!stockName.trim() || stockPieces > 0 || !!stockUnit.trim();");
    expect(door).toContain('if (typed && !window.confirm("Open Snap Or Note? What you typed here won\'t be saved.")) return;');
    expect(door.indexOf("window.confirm")).toBeLessThan(door.indexOf("openSnapOrNote()"));
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

describe("the reader failed and the typed figure was saved instead", () => {
  const LINK_WARNING =
    "The cost is recorded, but its receipt did not get marked as billed. On the job's Costs tab it will say Not On A Bill Yet: tie it to this bill there, rather than Record As Cost (that would write a second bill).";

  it("with the paper linked to the bill, the sentence says so: receipt attached", () => {
    expect(readerFallbackLine({ typedAmount: 84.1, readerError: "unreadable file" })).toBe(
      "Couldn't read it (unreadable file) — saved your typed $84.10 instead, receipt attached.",
    );
    expect(readerFallbackLine({ typedAmount: 84.1, nortOn: true })).toBe("Nort couldn't read it (unreadable) — saved your typed $84.10 instead, receipt attached.");
    expect(readerFallbackLine({ typedAmount: 0, readerError: "no total" })).toBe("Couldn't read a total (no total) — saved as $0. Open the bill to enter the amount.");
  });

  it("createBill's receipt-link warning is the sentence, never dropped, and 'receipt attached' is not claimed", () => {
    const typed = readerFallbackLine({ typedAmount: 84.1, readerError: "unreadable file", linkWarning: LINK_WARNING });
    expect(typed).toBe(`Couldn't read it (unreadable file) — saved your typed $84.10 instead. ${LINK_WARNING}`);
    expect(typed).not.toContain("receipt attached");
    const zero = readerFallbackLine({ typedAmount: 0, linkWarning: LINK_WARNING });
    expect(zero).toBe(`Couldn't read a total (unreadable) — saved as $0. Open the bill to enter the amount. ${LINK_WARNING}`);
    expect(zero).not.toContain("receipt attached");
  });

  it("the sheet's fallback hands createBill's warning to that sentence (the receipt is filed, so it is not offered for a second upload)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/components/quick-cost-button.tsx"), "utf8");
    const fallback = src.slice(src.indexOf("async function afterRead("), src.indexOf("if (res.already && res.sameAs)"));
    expect(fallback).toContain("receipt_document_id: docId");
    expect(fallback).toContain("linkWarning: fb.warning");
    expect(fallback).toContain("setReceipt(null)");
    // No sentence a person reads there (quoted, never a comment) claims the tie on its own.
    const said = Array.from(fallback.matchAll(/(["`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)).map((m) => m[2]);
    expect(said.filter((w) => w.includes("receipt attached"))).toEqual([]);
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

  it("switched off, or on a job's own Costs tab: no Shop Stock, so none of its fields", () => {
    const off = renderToStaticMarkup(createElement(QuickCostButton, { typeOnly: true, jobs: JOBS, shopStock: false }));
    const costs = renderToStaticMarkup(createElement(QuickCostButton, { typeOnly: true, jobId: "job-011", shopStock: true }));
    for (const html of [off, costs]) {
      expect(buttons(html).some((b) => b.words === "Shop Stock")).toBe(false);
      for (const id of ["ti-item", "ti-pieces", "ti-unit"]) expect(html).not.toContain(`id="${id}"`);
      expect(text(html)).not.toContain(STOCK_HAVE_THE_TICKET);
    }
  });

  const ITEMS = [
    { id: "item-7", name: "12/2 NM-B", unit: "ft" },
    { id: "item-9", name: "Wire Nuts, Red", unit: "box" },
  ];
  const fields = (p: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(StockFields, {
        items: ITEMS,
        loaded: true,
        itemsError: null,
        stockItem: "",
        stockName: "",
        stockPieces: 0,
        unit: "",
        lockedTo: null,
        onItem: () => {},
        onName: () => {},
        onPieces: () => {},
        onUnit: () => {},
        ...p,
      }),
    );

  it("What Is It?: the items in stock (names and units, never a cost) and New Item, then How Many and Unit", () => {
    const html = fields();
    const t = text(html);
    for (const w of ["What Is It?", "How Many", "Unit"]) expect(t).toContain(w);
    const select = html.match(/<select[^>]*id="ti-item"[^>]*>([\s\S]*?)<\/select>/)!;
    const options = Array.from(select[1].matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)).map((m) => text(m[1]).trim());
    expect(options).toEqual(["Pick An Item", "New Item", "12/2 NM-B (ft)", "Wire Nuts, Red (box)"]);
    expect(html).not.toContain("$");
    // No name box until New Item is picked.
    expect(html).not.toContain('id="ti-item-name"');
  });

  it("New Item opens a name box, and its Unit is typed (ft, each)", () => {
    const html = fields({ stockItem: "__new", stockName: "Twister 500/BX", unit: "" });
    expect(html).toContain('id="ti-item-name"');
    expect(html).toContain('value="Twister 500/BX"');
    const unit = html.match(/<input[^>]*id="ti-unit"[^>]*>/)![0];
    expect(unit).not.toMatch(/\sdisabled=""/);
    expect(unit).toContain('placeholder="ft or each"');
  });

  it("an item in stock locks the Unit to its own", () => {
    const html = fields({ stockItem: "item-7", unit: "ft", lockedTo: ITEMS[0] });
    const unit = html.match(/<input[^>]*id="ti-unit"[^>]*>/)![0];
    expect(unit).toMatch(/\sdisabled=""/);
    expect(unit).toContain('value="ft"');
    expect(text(html)).toContain("12/2 NM-B is counted in ft, so this is too.");
  });

  it("a stock list that couldn't be read says so, and still lets a new item be named", () => {
    const html = fields({ items: [], itemsError: "The stock items couldn't be read. You can still name a new item." });
    expect(html).toMatch(/role="alert"[^>]*>The stock items couldn(?:&#x27;|')t be read/);
    expect(text(html)).toContain("New Item");
  });

  it("one quiet line under them: the ticket's own door, 44px and Title Case", () => {
    const html = renderToStaticMarkup(createElement(StockTicketLine, { onOpen: () => {} }));
    expect(text(html)).toContain("Have the ticket? Snap Or Note reads every line.");
    const door = buttons(html).find((b) => b.words === "Open Snap Or Note")!;
    expect(door.attrs).toContain("min-h-11");
    expect(STOCK_HAVE_THE_TICKET).toBe("Have the ticket? Snap Or Note reads every line.");
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
