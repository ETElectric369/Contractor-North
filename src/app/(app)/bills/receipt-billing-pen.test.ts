import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE BILL'S FACE FOR PEN MARKS (cn-v1181, lane K): each face a line can wear, the answer buttons,
 * the pen sentence on top, Read Again, and the reads that feed the card naming the three columns.
 */
const modal = vi.hoisted(() => ({ onSave: null as null | (() => void) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": "" }, children, footer),
  ModalActions: (p: { onSave: () => void; saveLabel?: string }) => {
    modal.onSave = p.onSave;
    return createElement("button", null, p.saveLabel ?? "Save");
  },
}));
const again = vi.hoisted(() => ({ fn: vi.fn(async (_id: string) => ({ ok: true, message: "Read again: $120.00, was $130.00." }) as { ok: boolean; error?: string; message?: string }) }));
vi.mock("@/app/(app)/organize/read-again-actions", () => ({ readFiledPaperAgain: again.fn }));
vi.mock("./receipt-billing-actions", () => ({
  putRestOnShelf: vi.fn(),
  setReceiptLineBillable: vi.fn(),
  setReceiptLineReturned: vi.fn(),
  setReceiptLineUsage: vi.fn(),
  takeRollOffShelf: vi.fn(),
}));

const { ReceiptLines, ReadAgainConfirm, READ_AGAIN_CONFIRM, penFaceOf, receiptPenSentence } = await import("./receipt-billing-card");
const { PEN_WORDS } = await import("@/lib/pen-marks");

const L = (o: Record<string, unknown>) => ({
  id: "l",
  description: "20A breaker",
  quantity: 1,
  amount: 10,
  unitPrice: 10,
  category: "Electrical",
  billable: true,
  billedAmount: null,
  isStock: false,
  ...o,
});
const receipt = (lines: any[], o: Record<string, unknown> = {}) =>
  ({ id: "bill-1", supplier: "Northline Supply", bill_date: "2026-11-20", job_id: "j", job_name: "Larkspur", amount: 0, billedOn: null, lines, ...o }) as any;
const render = (r: any) => renderToStaticMarkup(createElement(ReceiptLines, { receipt: r }));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const buttons = (h: string) => Array.from(h.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)).map((m) => text(m[1]).trim());

describe("each face a line wears", () => {
  it("penFaceOf reads the columns", () => {
    expect(penFaceOf(L({ pen: "unclear", billable: false }) as any)).toBe("needsAnswer");
    expect(penFaceOf(L({ pen: "struck", returned: true, billable: false }) as any)).toBe("creditExpected");
    expect(penFaceOf(L({ pen: "struck", returned: true, billable: false, creditBillId: "c1" }) as any)).toBe("creditReceived");
    expect(penFaceOf(L({ pen: "struck", returned: false, billable: false }) as any)).toBe("crossedOutNotBilled");
    expect(penFaceOf(L({ pen: "quantity", returned: false, billable: true }) as any)).toBeNull();
    expect(penFaceOf(L({}) as any)).toBeNull();
  });

  it("an open question on account: the question and two buttons, Kept and Returned", () => {
    const h = render(receipt([L({ pen: "unclear", billable: false })], { status: "unpaid", hasSupplierAccount: true }));
    expect(text(h)).toContain(PEN_WORDS.needsAnswer);
    expect(buttons(h)).toEqual(expect.arrayContaining(["Kept", "Returned"]));
    expect(h).toMatch(/min-h-11 min-w-11[^"]*"[^>]*>Kept</);
    expect(h).not.toContain('role="switch"');
  });

  it("an open question on a receipt paid at purchase: no Returned choice, Not Billed is that state", () => {
    const h = render(receipt([L({ pen: "unclear", billable: false })], { creditExpected: false }));
    expect(buttons(h)).toEqual(expect.arrayContaining(["Kept", "Not Billed"]));
    expect(buttons(h)).not.toContain("Returned");
  });

  it("returned, credit expected: the face and Kept; never the shop-stock doors", () => {
    const h = render(receipt([L({ pen: "struck", returned: true, billable: false })]));
    expect(text(h)).toContain(PEN_WORDS.creditExpected);
    expect(buttons(h)).toContain("Kept");
    expect(text(h)).not.toContain("Put the Rest in Stock");
    expect(text(h)).not.toContain("Not billed to the customer");
  });

  it("credit received: the face, and nothing to press", () => {
    const h = render(receipt([L({ pen: "struck", returned: true, billable: false, creditBillId: "credit-1" })]));
    expect(text(h)).toContain(PEN_WORDS.creditReceived);
    expect(buttons(h)).not.toContain("Kept");
    expect(h).not.toContain('role="switch"');
  });

  it("crossed out on a receipt paid at purchase: Crossed Out · Not Billed, Kept, no shop stock", () => {
    const h = render(receipt([L({ pen: "struck", returned: false, billable: false })], { creditExpected: false }));
    expect(text(h)).toContain(PEN_WORDS.crossedOutNotBilled);
    expect(buttons(h)).toContain("Kept");
    expect(text(h)).not.toContain("Put the Rest in Stock");
  });

  it("a marked line read as kept, on account: billed, with the way to Returned", () => {
    const h = render(receipt([L({ pen: "quantity", returned: false, billable: true })], { creditExpected: true }));
    expect(text(h)).toContain("Billed to the customer");
    expect(buttons(h)).toContain("Returned");
  });

  it("an ordinary line is drawn exactly as before the pen fields existed", () => {
    const before = render(receipt([L({})]));
    expect(render(receipt([L({ pen: null, returned: false, creditBillId: null })]))).toBe(before);
    expect(before).toContain('role="switch"');
    expect(text(before)).toContain("Put the Rest in Stock");
  });

  it("locked on a sent invoice: the face, no answer buttons", () => {
    const h = render(receipt([L({ pen: "unclear", billable: false })], { billedOn: { label: "INV-900", status: "sent" } }));
    expect(text(h)).toContain(PEN_WORDS.needsAnswer);
    expect(buttons(h)).not.toContain("Kept");
  });

  it("no face is amber", () => {
    for (const l of [L({ pen: "unclear", billable: false }), L({ pen: "struck", returned: true, billable: false })]) {
      const h = render(receipt([l]));
      expect(h).not.toMatch(/amber[^"]*"[^>]*>(Pen Mark|Returned ·|Crossed Out)/);
    }
  });
});

describe("the pen sentence on top of the card", () => {
  const lines = [
    L({ id: "a", amount: 100, pen: "struck", returned: true, billable: false }),
    L({ id: "b", amount: 50 }),
    L({ id: "t", description: "Sales tax", category: "Tax", amount: 15 }),
  ];
  it("says what ink was read and what came off, tax share included, credit expected", () => {
    const r = receipt(lines, { amount: 165, status: "unpaid" });
    const s = receiptPenSentence(r)!;
    expect(s).toContain("Pen marks read: 1 line crossed out.");
    expect(s).toContain("$110.00 is marked returned");
    expect(s).toContain("credit expected");
    const h = render(r);
    expect(h).toMatch(/bg-slate-50[^"]*text-slate-600">Pen marks read/);
  });
  it("a snack switched off is not a pen mark: nothing to say", () => {
    expect(receiptPenSentence(receipt([L({ billable: false, category: "Food & Drink" })]))).toBeNull();
    expect(text(render(receipt([L({ billable: false })])))).not.toContain("Pen marks");
  });
  it("paid at purchase: comes off the customer's bill, no credit", () => {
    const s = receiptPenSentence(receipt([L({ pen: "struck", returned: false, billable: false })], { creditExpected: false }))!;
    expect(s).toContain("$10.00 comes off the customer's bill.");
  });
  it("an open question is asked", () => {
    expect(receiptPenSentence(receipt([L({ pen: "unclear", billable: false })]))).toMatch(/Kept or Returned/);
  });
});

describe("Read Again", () => {
  beforeEach(() => {
    again.fn.mockClear();
    modal.onSave = null;
  });
  it("offered on a bill a paper made, not on one with no paper, not on one a sent invoice holds", () => {
    expect(buttons(render(receipt([L({})], { fromPaper: true })))).toContain("Read Again");
    expect(buttons(render(receipt([L({})])))).not.toContain("Read Again");
    expect(buttons(render(receipt([L({})], { fromPaper: true, billedOn: { label: "INV-900", status: "sent" } })))).not.toContain("Read Again");
  });
  it("the confirm says it in one sentence and calls the server action as it is typed; its message comes back", async () => {
    const done = vi.fn();
    const h = renderToStaticMarkup(createElement(ReadAgainConfirm, { billId: "bill-1", onClose: vi.fn(), onDone: done }));
    expect(text(h)).toContain(READ_AGAIN_CONFIRM);
    expect(READ_AGAIN_CONFIRM.split(". ").length).toBe(1);
    modal.onSave!();
    await new Promise((r) => setTimeout(r, 0));
    expect(again.fn).toHaveBeenCalledWith("bill-1");
    expect(done).toHaveBeenCalledWith("Read again: $120.00, was $130.00.");
  });
  it("a refusal is not taken for done", async () => {
    again.fn.mockResolvedValueOnce({ ok: false, error: "There's no picture for this bill." });
    const done = vi.fn();
    renderToStaticMarkup(createElement(ReadAgainConfirm, { billId: "bill-1", onClose: vi.fn(), onDone: done }));
    modal.onSave!();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).not.toHaveBeenCalled();
  });
});

describe("every read that feeds the card names the three columns (the projection law)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const PEN = ", pen_mark, returned, returned_credit_bill_id";
  it("/bills: on the line embed, above the ladder, falling back to the old top rung", () => {
    const page = src("src/app/(app)/bills/page.tsx");
    expect(page).toContain(`\${o.pen ? "${PEN}" : ""}, sort_order)`);
    expect(page).toContain("let attempt = await read({ ...ladder[0], pen: true });");
    expect(page).toContain("if (attempt.error && isMissingColumn(attempt.error)) attempt = await read(ladder[0]);");
    // ...and the map right after it carries them onto the card.
    expect(page).toContain("pen: penMarkOf(l.pen_mark),");
    expect(page).toContain("creditBillId: l.returned_credit_bill_id ?? null,");
  });
  it("the one receipt the Already Billed sheet reads", () => {
    const action = src("src/app/(app)/bills/receipt-for-billing-action.ts");
    expect(action).toContain(`sort_order\${pen ? "${PEN}" : ""})`);
    expect(action).toContain("pen: penMarkOf(l.pen_mark),");
    expect(action).toContain("creditBillId: l.returned_credit_bill_id ?? null,");
  });
  it("the job page's bills, for the costs list", () => {
    const job = src("src/app/(app)/jobs/[id]/page.tsx");
    expect(job).toContain(`billed_amount\${withCorrects ? "${PEN}" : ""})`);
  });
});

describe("cn-v1181 fixer: Returned by hand on an unmarked line (F4)", () => {
  const returnedButtons = (h: string) => Array.from(h.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)).filter((m) => text(m[2]).trim() === "Returned");

  it("a credit-tracked bill: an ordinary line that bills gets one quiet Returned, 44px, slate, never amber", () => {
    const h = render(receipt([L({})], { creditExpected: true }));
    const [b, ...more] = returnedButtons(h);
    expect(b).toBeTruthy();
    expect(more).toHaveLength(0);
    expect(b[1]).toMatch(/min-h-11/);
    expect(b[1]).toMatch(/text-slate-500/);
    expect(b[1]).not.toMatch(/amber/);
    expect(h).toContain('role="switch"');
  });

  it("a receipt paid at purchase keeps only its Bill switch", () => {
    const h = render(receipt([L({})], { creditExpected: false }));
    expect(returnedButtons(h)).toHaveLength(0);
    expect(h).toContain('role="switch"');
  });

  it("locked on a sent invoice, or a line switched off: no Returned", () => {
    expect(returnedButtons(render(receipt([L({})], { creditExpected: true, billedOn: { label: "INV-900", status: "sent" } })))).toHaveLength(0);
    expect(returnedButtons(render(receipt([L({ billable: false })], { creditExpected: true })))).toHaveLength(0);
  });

  it("after the tap the line reads Returned · Credit Expected, with Kept as the way back", () => {
    const h = render(receipt([L({ returned: true, billable: false })], { creditExpected: true }));
    expect(text(h)).toContain(PEN_WORDS.creditExpected);
    expect(buttons(h)).toContain(PEN_WORDS.kept);
  });
});

describe("cn-v1181 fixer: Read Again is not drawn on a bill paid other than at the counter (F3)", () => {
  it("paid, on account: no Read Again", () => {
    expect(buttons(render(receipt([L({})], { fromPaper: true, status: "paid", creditExpected: true })))).not.toContain("Read Again");
  });
  it("paid at the counter: Read Again, as before", () => {
    expect(buttons(render(receipt([L({})], { fromPaper: true, status: "paid", creditExpected: false })))).toContain("Read Again");
  });
  it("owed on account: Read Again, as before", () => {
    expect(buttons(render(receipt([L({})], { fromPaper: true, status: "unpaid", creditExpected: true })))).toContain("Read Again");
  });
});

describe("cn-v1181 fixer: the card words Returned from the paper's own tender (F11)", () => {
  it("paperOfBillForCard: the paper's word decides; no word, or no paper, leaves it to the bill", async () => {
    const { paperOfBillForCard } = await import("./receipt-billing");
    expect(paperOfBillForCard("bill-1", [{ bill_id: "bill-1", payment: "paid_at_purchase" }])).toEqual({ fromPaper: true, creditExpected: false });
    expect(paperOfBillForCard("bill-1", [{ bill_id: "bill-1", payment: "on_account" }])).toEqual({ fromPaper: true, creditExpected: true });
    expect(paperOfBillForCard("bill-1", [{ bill_id: "bill-1", payment: null }])).toEqual({ fromPaper: true, creditExpected: null });
    expect(paperOfBillForCard("bill-1", [{ bill_id: "bill-2", payment: "paid_at_purchase" }])).toEqual({ fromPaper: false, creditExpected: null });
  });
  it("/bills reads the paper's tender with its ties and hands it to the card", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    expect(page).toContain('.select("id, kind, category, bill_id, tied_bill_id, file_url, document_id, payment")');
    expect(page).toContain("...paperOfBillForCard(String(b.id), billTies");
  });
  it("a paid-at-purchase paper on a bill with a supplier account: Not Billed, not Returned", () => {
    const h = render(receipt([L({ pen: "unclear", billable: false })], { status: "unpaid", hasSupplierAccount: true, creditExpected: false }));
    expect(buttons(h)).toContain("Not Billed");
    expect(buttons(h)).not.toContain("Returned");
  });
});
