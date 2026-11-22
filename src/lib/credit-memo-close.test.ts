import { describe, it, expect } from "vitest";
import {
  bestHomes,
  correctionInput,
  creditMemoSentence,
  memoGapCents,
  memoScore,
  orderAfterSplits,
  pairCreditMemo,
  sameItemWords,
  type PurchaseLine,
} from "./credit-memo-close";
import { creditMemoNoneSentence, creditMemoReverses, isWaitingCreditMemo, CREDIT_MEMO_DOOR } from "./paperwork";

/**
 * THE PAIRING RULE A CREDIT MEMO CLOSES ITS BILL BY (cn-v1181, lane M). Pure, cent-exact. Each case
 * is one sentence of the rule in lib/credit-memo-close.ts.
 */

const line = (id: string, over: Partial<PurchaseLine> = {}): PurchaseLine => ({
  id,
  description: "4 in LED Shallow IC Housing",
  quantity: 4,
  unit_price: 11.83,
  amount: 47.32,
  category: null,
  billable: true,
  billed_amount: null,
  is_stock: false,
  returned: false,
  returned_credit_bill_id: null,
  sort_order: 0,
  ...over,
});
const tax = (id: string, amount: number, sort = 9): PurchaseLine => line(id, { description: "Sales Tax", category: "Tax", quantity: 1, unit_price: amount, amount, sort_order: sort });

describe("pairCreditMemo", () => {
  it("(1) an OPEN returned line of the same item and amount closes first, before a line that still bills", () => {
    const lines = [line("still", { sort_order: 0 }), line("back", { sort_order: 1, returned: true, billable: false })];
    const p = pairCreditMemo([{ description: "H245 4 in LED Shallow IC Housing", quantity: 4, amount: -47.32 }], lines, { invoiced: false });
    expect(p).toEqual([{ kind: "closeReturned", memoIndex: 0, line: lines[1] }]);
  });

  it("a returned line already closed by a memo is never closed again", () => {
    const lines = [line("back", { returned: true, billable: false, returned_credit_bill_id: "memo-old" })];
    const p = pairCreditMemo([{ description: "4 in LED Shallow IC Housing", amount: -47.32 }], lines, { invoiced: false });
    expect(p[0].kind).toBe("stays");
  });

  it("(1) needs the amount to the cent", () => {
    const lines = [line("back", { returned: true, billable: false })];
    const p = pairCreditMemo([{ description: "4 in LED Shallow IC Housing", amount: -47.31 }], lines, { invoiced: false });
    expect(p[0].kind).toBe("stays");
  });

  it("(2) a line that still bills closes WHOLE when the amounts agree", () => {
    const lines = [line("a")];
    expect(pairCreditMemo([{ description: "4 in LED Shallow IC Housing", quantity: 4, amount: -47.32 }], lines, { invoiced: false })[0]).toEqual({
      kind: "closeWhole",
      memoIndex: 0,
      line: lines[0],
    });
  });

  it("(2) part of a line is SPLIT cent-exact: kept + returned add back to the printed line", () => {
    const lines = [line("wire", { description: "12/2 NM-B Cable 250 ft", quantity: 10, unit_price: 12.345, amount: 123.45 })];
    const [p] = pairCreditMemo([{ description: "12/2 NM-B Cable 250 ft", quantity: 4, amount: -49.38 }], lines, { invoiced: false });
    expect(p).toMatchObject({ kind: "split", kept: { quantity: 6, amount: 74.07 }, back: { quantity: 4, amount: 49.38 } });
    if (p.kind !== "split") throw new Error("split");
    expect(Math.round((p.kept.amount + p.back.amount) * 100)).toBe(12345);
  });

  it("(2) a part that is not the line's own price is not split: it stays", () => {
    const lines = [line("wire", { description: "12/2 NM-B Cable 250 ft", quantity: 10, amount: 123.45 })];
    expect(pairCreditMemo([{ description: "12/2 NM-B Cable 250 ft", quantity: 4, amount: -40 }], lines, { invoiced: false })[0].kind).toBe("stays");
  });

  it("(2) a line with a part-used amount or shop stock taken from it is never closed or split", () => {
    for (const over of [{ billed_amount: 20 }, { is_stock: true }] as Partial<PurchaseLine>[]) {
      const lines = [line("box", over)];
      expect(pairCreditMemo([{ description: "4 in LED Shallow IC Housing", quantity: 4, amount: -47.32 }], lines, { invoiced: false })[0].kind).toBe("stays");
      expect(pairCreditMemo([{ description: "4 in LED Shallow IC Housing", quantity: 1, amount: -11.83 }], lines, { invoiced: false })[0].kind).toBe("stays");
    }
  });

  it("(3) on a purchase an invoice that went out already bills, nothing that still bills closes: it stays, said as invoiced", () => {
    const lines = [line("a")];
    const [p] = pairCreditMemo([{ description: "4 in LED Shallow IC Housing", amount: -47.32 }], lines, { invoiced: true });
    expect(p).toMatchObject({ kind: "stays", why: "invoiced", line: lines[0] });
  });

  it("(3) but an OPEN returned line still closes on an invoiced purchase (it was never billed)", () => {
    const lines = [line("back", { returned: true, billable: false })];
    expect(pairCreditMemo([{ description: "4 in LED Shallow IC Housing", amount: -47.32 }], lines, { invoiced: true })[0].kind).toBe("closeReturned");
  });

  it("words: the memo asks lib/supplier-returns sameItem itself, one rule and no copy (two doors, one thing)", async () => {
    const { sameItem } = await import("./supplier-returns");
    expect(sameItemWords).toBe(sameItem);
  });

  it("words: whole words, one description holding the other, never one word alone", () => {
    expect(sameItemWords("h245icat 4 in led shallow ic housing", "4 in led shallow ic housing")).toBe(true);
    expect(sameItemWords("wire", "wire")).toBe(false);
    const lines = [line("w", { description: "Wire" })];
    expect(pairCreditMemo([{ description: "Wire", amount: -47.32 }], lines, { invoiced: false })[0].kind).toBe("unmatched");
  });

  it("tax pairs with the bill's tax line; a positive line is a fee; $0 is nothing", () => {
    const lines = [line("a"), tax("t", 3.79)];
    const p = pairCreditMemo(
      [
        { description: "4 in LED Shallow IC Housing", amount: -47.32 },
        { description: "Tax", category: "Tax", amount: -3.79 },
        { description: "Restocking Fee", amount: 5 },
        { description: "Note line", amount: 0 },
      ],
      lines,
      { invoiced: false },
    );
    expect(p.map((x) => x.kind)).toEqual(["closeWhole", "tax", "fee", "zero"]);
    expect(p[1]).toMatchObject({ line: lines[1] });
  });

  it("each bill line pairs once: two memo lines for one bill line close one, the other stays", () => {
    const lines = [line("a")];
    const p = pairCreditMemo(
      [
        { description: "4 in LED Shallow IC Housing", amount: -47.32 },
        { description: "4 in LED Shallow IC Housing", amount: -47.32 },
      ],
      lines,
      { invoiced: false },
    );
    expect(p.map((x) => x.kind)).toEqual(["closeWhole", "stays"]);
  });
});

describe("the bill a memo names best", () => {
  const memo = [{ description: "4 in LED Shallow IC Housing", quantity: 4, amount: -47.32 }];
  it("one bill closes the line: it", () => {
    expect(bestHomes(memo, [{ bill: "A", lines: [line("a")] }, { bill: "B", lines: [line("b", { description: "Single Pole Switch White" })] }])).toEqual(["A"]);
  });
  it("two bills close it equally: both, for a person to pick", () => {
    expect(bestHomes(memo, [{ bill: "A", lines: [line("a")] }, { bill: "B", lines: [line("b")] }])).toEqual(["A", "B"]);
  });
  it("open returned lines weigh first", () => {
    expect(bestHomes(memo, [{ bill: "A", lines: [line("a")] }, { bill: "B", lines: [line("b", { returned: true, billable: false })] }])).toEqual(["B"]);
    expect(memoScore(memo, [line("b", { returned: true, billable: false })])).toEqual({ closes: 1, open: 1 });
  });
  it("none closes anything: none", () => {
    expect(bestHomes(memo, [{ bill: "A", lines: [line("a", { amount: 99 })] }])).toEqual([]);
  });
});

describe("what the correction door is handed", () => {
  it("each credit carries its bill line's words; a fee keeps its own; $0 is left out; closed lines and fees go off the bill", () => {
    const lines = [line("a", { description: "4 IN LED SHALLOW IC HOUSING" }), line("s", { description: "Single Pole Switch White", amount: 9.5, sort_order: 1 }), tax("t", 3.79)];
    const memo = [
      { description: "H245 4 in LED Shallow IC Housing", amount: -47.32 },
      { description: "Note line", amount: 0 },
      { description: "Single Pole Switch White", amount: -1 },
      { description: "Tax", category: "Tax", amount: -3.79 },
      { description: "Restocking Fee", amount: 5 },
    ];
    const pairs = pairCreditMemo(memo, lines, { invoiced: false });
    const got = correctionInput(memo, pairs);
    expect(got.lines).toEqual([
      { description: "4 IN LED SHALLOW IC HOUSING", amount: -47.32 },
      { description: "Single Pole Switch White", amount: -1 },
      { description: "Sales Tax", amount: -3.79 },
      { description: "Restocking Fee", amount: 5 },
    ]);
    expect(got.sortOf).toEqual([0, 2, 3, 4]);
    expect(got.offBill).toEqual([0, 3]);
  });
});

describe("the line order after a split", () => {
  it("the returned half sits right after its line; later lines move down one", () => {
    const lines = [line("a", { sort_order: 0 }), line("b", { sort_order: 1 }), line("c", { sort_order: 2 })];
    const { moves, halves } = orderAfterSplits(lines, ["a"]);
    expect([...halves]).toEqual([["a", 1]]);
    expect([...moves]).toEqual([
      ["b", 2],
      ["c", 3],
    ]);
    expect(orderAfterSplits(lines, []).moves.size).toBe(0);
  });
});

describe("words", () => {
  it("the gap between a memo's total and its lines, in cents", () => {
    expect(memoGapCents(-51.11, [{ amount: -47.32 }, { amount: -3.79 }])).toBe(0);
    expect(memoGapCents(-60, [{ amount: -47.32 }])).toBe(-1268);
  });

  it("the sentence says what closed, what was split, what stays a credit and why, and the fee", () => {
    const lines = [line("a"), line("w", { description: "12/2 NM-B Cable 250 ft", quantity: 10, amount: 123.45, sort_order: 1 }), line("s", { description: "Single Pole Switch White", amount: 9.5, sort_order: 2 })];
    const memo = [
      { description: "4 in LED Shallow IC Housing", amount: -47.32 },
      { description: "12/2 NM-B Cable 250 ft", quantity: 4, amount: -49.38 },
      { description: "Single Pole Switch White", amount: -2 },
      { description: "Restocking Fee", amount: 5 },
    ];
    const s = creditMemoSentence({ memoNumber: "CM-900", billWords: "INV-900", memoTotal: -93.7, memo, pairs: pairCreditMemo(memo, lines, { invoiced: false }) });
    expect(s).toContain("CM-900 is filed under INV-900: $93.70 back from the supplier.");
    expect(s).toContain("2 returned lines are closed (4 in LED Shallow IC Housing; 12/2 NM-B Cable 250 ft): off the customer's bill, credit received.");
    expect(s).toContain("12/2 NM-B Cable 250 ft was split: 6 kept ($74.07), 4 returned ($49.38).");
    expect(s).toContain("Single Pole Switch White stays a credit to the customer, as before.");
    expect(s).toContain("Restocking Fee ($5.00) is the company's cost, not billed to the customer.");
    const inv = creditMemoSentence({ memoNumber: "CM-900", billWords: "INV-900", memoTotal: -47.32, memo: memo.slice(0, 1), pairs: pairCreditMemo(memo.slice(0, 1), lines, { invoiced: true }) });
    expect(inv).toContain("stays a credit to the customer, as before: an invoice that went out already billed it.");
    const failed = creditMemoSentence({ memoNumber: "CM-900", billWords: "INV-900", memoTotal: -47.32, memo: memo.slice(0, 1), pairs: pairCreditMemo(memo.slice(0, 1), lines, { invoiced: false }), notClosed: [0] });
    expect(failed).not.toContain("closed (");
    expect(failed).toContain("stays a credit to the customer");
  });

  it("the paper's own words: the door, a waiting memo, the number it reverses, and the none sentence", () => {
    expect(CREDIT_MEMO_DOOR).toBe("File With Its Bill");
    expect(isWaitingCreditMemo({ id: "x", doc_type: "credit_memo", status: "needs_review" })).toBe(true);
    expect(isWaitingCreditMemo({ id: "x", doc_type: "credit_memo", status: "filed" })).toBe(false);
    expect(isWaitingCreditMemo({ id: "x", doc_type: "credit_memo", status: "needs_review", bill_id: "b" })).toBe(false);
    expect(isWaitingCreditMemo({ id: "x", doc_type: "receipt", status: "needs_review" })).toBe(false);
    expect(creditMemoReverses({ id: "x", proposal: { reverses: "  INV  900 " } })).toBe("INV 900");
    expect(creditMemoReverses({ id: "x", proposal: { reverses: "null" } })).toBeNull();
    expect(creditMemoReverses({ id: "x", proposal: {} })).toBeNull();
    expect(creditMemoNoneSentence("Northline Supply")).toBe(
      "No bill from Northline Supply carries the lines this credit memo returns, so it has no bill to file with. Fix Details can still file it on a job, as before.",
    );
  });
});
