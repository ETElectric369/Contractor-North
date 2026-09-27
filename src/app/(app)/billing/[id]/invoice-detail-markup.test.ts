import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE INVOICE PAGE SEEDS ITS % BOX FROM WHAT THE LINES ARE PRICED AT (2026-09-25), rendered through
 * the real InvoiceDetail. INV-078 was moved to 11%; the box read 15 (Andrew's level), and touching
 * it sent the 15 back. Here the page's seed (markupBoxSeed over readInvoiceMarkup) reaches the box.
 */

const { importCostsIntoInvoice } = vi.hoisted(() => ({ importCostsIntoInvoice: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/crm/actions", () => ({ createCustomer: vi.fn() }));
vi.mock("@/app/(app)/quotes/actions", () => ({ emailQuote: vi.fn(), textQuote: vi.fn() }));
vi.mock("@/app/(app)/billing/actions", () => ({
  importCostsIntoInvoice,
  ...Object.fromEntries(
    [
      "addInvoiceItem", "updateInvoiceItem", "reorderInvoiceItems", "parkInvoice", "deleteInvoiceItem", "setInvoiceStatus",
      "setInvoiceTaxRate", "setInvoiceDescription", "setInvoiceTitle", "setInvoiceDueDate", "setInvoiceCustomerJob",
      "recordPayment", "importQuoteItemsIntoInvoice", "importLaborIntoInvoice", "reimportFromScratch",
      "importChangeOrdersIntoInvoice", "updatePayment", "deletePayment", "emailInvoice", "textInvoice",
    ].map((k) => [k, vi.fn()]),
  ),
}));

import { InvoiceDetail, dueWords, liveHoldDay } from "./invoice-detail";
import { markupBoxSeed } from "@/lib/invoice-markup";
import { bringInNewWorkSteps, bringInSentence } from "@/lib/actuals-draw";

const invoice = {
  id: "09ff65de-2ec8-4884-a31f-583a8943b09a",
  invoice_number: "INV-078",
  status: "draft",
  invoice_kind: "standard",
  job_id: "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1",
  customer_id: "c-1",
  total: 3318.62,
  subtotal: 3318.62,
  amount_paid: 0,
  tax_rate: 0,
  tax_amount: 0,
} as any;
const items = [
  { id: "ii-1", invoice_id: invoice.id, description: "Flexbox", quantity: 1, unit: "ea", unit_price: 221.42, line_total: 221.42, import_source: "costs", import_key: "bill:11e96fc3", source_ids: ["11e96fc3"], edited: false, sort_order: 1 },
] as any[];

function render(seed: ReturnType<typeof markupBoxSeed>, levelMarkupPct: number | null = 15) {
  return renderToStaticMarkup(
    createElement(InvoiceDetail, { invoice, items, payments: [], markupSeed: seed, levelMarkupPct, customerName: "Andrew Cohen", importMode: "standard" }),
  );
}

function box(html: string) {
  const at = html.indexOf('aria-label="Material markup percent"');
  return html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at) + 1);
}

describe("InvoiceDetail's % box", () => {
  it("INV-078 at 11%: the box reads 11 and says so, with Andrew's usual beside it", () => {
    const html = render(markupBoxSeed({ kind: "one", pct: 11 }, 15));
    expect(box(html)).toContain('value="11"');
    expect(html).toContain("Priced at 11%");
    expect(html).toContain("Andrew Cohen&#x27;s usual is 15%");
    expect(html).not.toContain(">Apply<");
    expect(importCostsIntoInvoice).not.toHaveBeenCalled();
  });

  it("lines at different markups: the usual figure, and the sentence that stops anyone assuming", () => {
    const html = render(markupBoxSeed({ kind: "mixed" }, 15));
    expect(box(html)).toContain('value="15"');
    expect(html).toContain("Lines are at different markups");
  });

  it("no pricing level: the org default is named as the default, not as the customer's", () => {
    const html = render(markupBoxSeed({ kind: "one", pct: 11 }, 20), null);
    expect(html).toContain("Your default is 20%");
  });
});

/**
 * BRING IN NEW WORK (W1-27): one button where the Import row had four. ONE pure function decides
 * what it runs (lib/actuals-draw bringInNewWorkSteps), and one sentence says what landed
 * (bringInSentence) - a part that failed is named beside the parts that came in.
 */
describe("what Bring In New Work runs", () => {
  const base = { importMode: "standard" as const, hasJob: true, quoteId: null, quoteLinesOnInvoice: 0 };
  it("a Time & Material job, or a job with no estimate that is its price: Labor, then Materials, then Approved Change Orders", () => {
    expect(bringInNewWorkSteps({ ...base, estimateIsContract: false })).toEqual(["labor", "materials", "change_orders"]);
    // The rule before this wave when the page didn't ask: the job's work comes in.
    expect(bringInNewWorkSteps({ ...base })).toEqual(["labor", "materials", "change_orders"]);
  });
  it("an actuals draw (INV-078) takes the work like an invoice", () => {
    expect(bringInNewWorkSteps({ ...base, importMode: "actuals", estimateIsContract: true })).toEqual(["labor", "materials", "change_orders"]);
  });
  it("an estimate's invoice: its lines only while it holds none, then Approved Change Orders - never labor or materials on top of a price", () => {
    expect(bringInNewWorkSteps({ ...base, quoteId: "q-1", estimateIsContract: true })).toEqual(["quote", "change_orders"]);
    expect(bringInNewWorkSteps({ ...base, quoteId: "q-1", quoteLinesOnInvoice: 12, estimateIsContract: true })).toEqual(["change_orders"]);
    // Even on a T&M job: an estimate copied onto the bill takes no actuals (the estimate and the work on one bill).
    expect(bringInNewWorkSteps({ ...base, quoteId: "q-1", estimateIsContract: false })).not.toContain("labor");
    // No job behind an estimate's invoice: its lines only.
    expect(bringInNewWorkSteps({ ...base, hasJob: false, quoteId: "q-1" })).toEqual(["quote"]);
  });
  it("a fixed-price job whose estimate is the contract, on a bill that isn't the estimate's: its approved change orders only", () => {
    expect(bringInNewWorkSteps({ ...base, estimateIsContract: true })).toEqual(["change_orders"]);
  });
  it("the job couldn't be read: only what can't bill a contract twice", () => {
    expect(bringInNewWorkSteps({ ...base, estimateIsContract: null })).toEqual(["change_orders"]);
  });
  it("a draw for set amounts: nothing (the row isn't drawn)", () => {
    expect(bringInNewWorkSteps({ ...base, importMode: "none" })).toEqual([]);
  });
});

describe("the one sentence Bring In New Work says", () => {
  const stats = (s: Record<string, unknown>) => ({ inserted: 0, updated: 0, removed: 0, kept_edited: 0, pulled_in: 0, ...s });
  it("says what came in, in the office's nouns, with the edits it kept", () => {
    const said = bringInSentence([
      { step: "labor", ok: true, stats: stats({ inserted: 1, pulled_in: 5, kept_edited: 2 }) },
      { step: "materials", ok: true, stats: stats({ inserted: 2, pulled_in: 2, stock_pulled_in: 1, kept_edited: 1 }) },
      { step: "change_orders", ok: true, stats: stats({ inserted: 1, pulled_in: 1 }) },
    ]);
    expect(said.sentence).toBe("Brought in: 5 time entries · 2 bills · 1 take from stock · 1 change order · 3 of your edits kept.");
    expect(said.partial).toBe(false);
    expect(said.stuck).toEqual([]);
  });
  it("a part that failed is named beside what landed - never one 'failed' for the lot", () => {
    const said = bringInSentence([
      { step: "labor", ok: true, stats: stats({ inserted: 1, pulled_in: 3 }) },
      { step: "materials", ok: false, error: "Couldn't read this job's bills just now." },
      { step: "change_orders", ok: false, empty: true, error: "No approved change orders." },
    ]);
    expect(said.sentence).toBe("Brought in: 3 time entries. Materials didn't come in: Couldn't read this job's bills just now.");
    expect(said.partial).toBe(true);
  });
  it("nothing new is said as such, with what another invoice already holds", () => {
    const said = bringInSentence([{ step: "labor", ok: true, stats: stats({ skipped_claimed: 9, claimed_on: ["INV-061"] }) }]);
    expect(said.sentence).toBe("Nothing new to bring in. 9 time entries already on INV-061.");
  });
  it("a part whose every row is already billed elsewhere says where, even though it answered empty", () => {
    // The importers' own answer when every hour / change order is claimed: empty, the reason in `error`.
    const said = bringInSentence([
      { step: "labor", ok: false, empty: true, error: "Every hour on this job is already on INV-061 — nothing new to bill." },
      { step: "materials", ok: false, empty: true, error: "No purchase orders or bills on this job yet." },
      { step: "change_orders", ok: false, empty: true, error: "No approved change orders on this job yet." },
    ]);
    expect(said.sentence).toBe("Nothing new to bring in. Every hour on this job is already on INV-061 — nothing new to bill.");
    expect(said.partial).toBe(false);
    // Beside work that did land, the held part is still named.
    const mixed = bringInSentence([
      { step: "labor", ok: false, empty: true, error: "Every hour on this job is already on INV-061 — nothing new to bill." },
      { step: "materials", ok: true, stats: stats({ inserted: 2, pulled_in: 2 }) },
    ]);
    expect(mixed.sentence).toBe("Brought in: 2 bills. Every hour on this job is already on INV-061 — nothing new to bill.");
    // A receipt whose every line is the company's own cost says where the switch is.
    const own = "Nothing here to bill: on that receipt, every line is marked as your own cost rather than the customer's. Open the bill to change what the customer pays for.";
    expect(bringInSentence([{ step: "materials", ok: false, empty: true, error: own }]).sentence).toBe(`Nothing new to bring in. ${own}`);
    // A plain "nothing yet" with a stock note: only the note rides along.
    expect(bringInSentence([{ step: "materials", ok: false, empty: true, error: "Nothing here to bill yet. 2 pieces taken past the stock.", emptyNote: "2 pieces taken past the stock" }]).sentence).toBe(
      "Nothing new to bring in. 2 pieces taken past the stock.",
    );
  });
  it("a part that had rows to place and placed none is stuck (Start It Over is offered for it)", () => {
    expect(bringInSentence([{ step: "materials", ok: true, stats: stats({ pulled_in: 4 }) }]).stuck).toEqual(["materials"]);
    expect(bringInSentence([{ step: "materials", ok: true, stats: stats({ pulled_in: 0 }) }]).stuck).toEqual([]);
  });
  it("a money warning makes it a heads-up and rides along", () => {
    const said = bringInSentence([{ step: "materials", ok: true, stats: stats({ updated: 3, pulled_in: 0, warnings: ["The edited Supplies & tax row still reads $41.10"] }) }]);
    expect(said.partial).toBe(true);
    expect(said.warnings).toEqual(["The edited Supplies & tax row still reads $41.10"]);
  });
});

describe("the invoice body (W1-27)", () => {
  const html = (inv: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(InvoiceDetail, {
        invoice: { ...invoice, ...inv },
        items,
        payments: [],
        markupSeed: markupBoxSeed({ kind: "one", pct: 11 }, 15),
        customerName: "Andrew Cohen",
        importMode: "standard",
        netDays: 14,
        ...extra,
      }),
    );

  it("one Bring In New Work button, the % box beside it on a T&M invoice - and the four old buttons are gone", () => {
    const out = html({}, { estimateIsContract: false });
    expect(out).toContain("Bring In New Work");
    expect(out).toContain('aria-label="Material markup percent"');
    for (const gone of ["Labor from Timecards", "Materials from Costs", ">From Estimate<", ">Approved Change Orders<", "Import:"]) expect(out).not.toContain(gone);
  });

  it("an estimate's invoice on a fixed-price job: the button, and no % box (no materials come onto a price)", () => {
    const out = html({ quote_id: "q-1" }, { estimateIsContract: true });
    expect(out).toContain("Bring In New Work");
    expect(out).not.toContain('aria-label="Material markup percent"');
  });

  it("the due line comes from the terms: an untouched draft says when it will be due", () => {
    expect(html({ due_date: "2026-10-08", due_date_by_hand: false })).toContain("Due 14 days after you send it");
    const picked = html({ due_date: "2026-10-08", due_date_by_hand: true });
    expect(picked).toContain("Due Oct 8");
    expect(picked).toContain("Net 14");
    // Before 0366 (no column): the stored date is the date.
    expect(html({ due_date: "2026-10-08" })).toContain("Net 14");
    // Save, Unsaved and Clear are gone; Change is a 44px link.
    expect(picked).toMatch(/class="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">Change</);
    expect(picked).not.toContain(">Unsaved<");
    expect(picked).not.toContain(">Clear<");
  });

  it("a void invoice shows its title, due date and description as text: nothing to change", () => {
    const out = html({ status: "void", title: "Kitchen rewire", description: "Scope as billed", due_date: "2026-10-08" });
    expect(out).toContain("Kitchen rewire");
    expect(out).toContain("Scope as billed");
    expect(out).not.toContain('id="inv-descr"');
    expect(out).not.toContain(">Change<");
    expect(out).not.toContain("Bring In New Work");
  });

  it("the description saves itself: no Save button, and its states are said beside the label", () => {
    const out = html({ description: "Rough-in" });
    expect(out).toContain('id="inv-descr"');
    expect(out).not.toMatch(/>Save<\/button>/);
  });

  it("the one-step move chevrons are gone from the lines", () => {
    const two = [...items, { ...items[0], id: "ii-2", description: "Wire" }];
    const out = renderToStaticMarkup(createElement(InvoiceDetail, { invoice, items: two, payments: [], importMode: "standard" }));
    expect(out).not.toContain('aria-label="Move up"');
    expect(out).not.toContain('aria-label="Move down"');
    expect(out).toContain("Group Materials &amp; Labor");
  });

  it("a two-line invoice can still swap its lines: Move To Top / Move To Bottom show from two lines", async () => {
    // The line's edit form opens on a tap (state), so the gate is pinned in the source.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/invoice-detail.tsx"), "utf8");
    const at = src.indexOf("Move To Top");
    const gate = src.slice(src.lastIndexOf("{items.length", at), at);
    expect(gate).toMatch(/^\{items\.length > 1 && \(/);
  });

  it("a set-aside draft says until when and why, with Change and Put Back", () => {
    // A day still ahead in the company's timezone (the page's default, Pacific).
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const ahead = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    const said = new Date(`${ahead}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const out = html({ hold_until: ahead, hold_reason: "Waiting on the change order" });
    expect(out).toContain(`Set aside until ${said} · Waiting on the change order`);
    expect(out).toContain(">Change</button>");
    expect(out).toContain(">Put Back</button>");
  });

  it("a set-aside day that has come is no hold: Needs You has the draft back, so the line is gone", () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    for (const gone of ["2026-09-20", today]) {
      const out = html({ hold_until: gone, hold_reason: "Waiting on the change order" });
      expect(out).not.toContain("Set aside until");
      expect(out).not.toContain(">Put Back</button>");
    }
    // The rule itself: only a day after today is a live hold (the query's hold_until <= today is back).
    expect(liveHoldDay("2026-09-20", "2026-09-27")).toBeNull();
    expect(liveHoldDay("2026-09-27", "2026-09-27")).toBeNull();
    expect(liveHoldDay("2026-10-04", "2026-09-27")).toBe("2026-10-04");
    expect(liveHoldDay(null, "2026-09-27")).toBeNull();
  });

  it("a bill that went out and came Back To Draft says its date: its next send keeps it", () => {
    expect(dueWords({ isDraft: true, dueDate: "2026-08-31", byHand: false, netDays: 30, sentBefore: true })).toBe("Due Aug 31 · Net 30");
    expect(dueWords({ isDraft: true, dueDate: "2026-08-31", byHand: false, netDays: 30, sentBefore: false })).toBe("Due 30 days after you send it");
    expect(html({ due_date: "2026-08-31", due_date_by_hand: false, sent_at: "2026-08-01T18:00:00Z" })).not.toContain("after you send it");
  });
});
