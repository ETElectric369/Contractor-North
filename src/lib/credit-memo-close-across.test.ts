import { describe, it, expect } from "vitest";
import { andList, creditAcrossBillsSentence, pairCreditAcrossBills, pairCreditMemo, returnTaxCheck, type MemoLine, type PurchaseLine, type ReturnBill } from "./credit-memo-close";

/**
 * ONE CREDIT, SEVERAL BILLS ON ITS JOB (cn-v1184): a supplier's return slip often covers goods from
 * several invoices on one job. The pairing is built only from pairCreditMemo, per bill, in three passes.
 */
const L = (id: string, description: string, quantity: number, amount: number, over: Partial<PurchaseLine> = {}): PurchaseLine => ({
  id, description, quantity, amount, unit_price: quantity ? amount / quantity : 0, category: null, billable: true, billed_amount: null, is_stock: false,
  returned: false, returned_credit_bill_id: null, sort_order: 0, ...over,
});
const back = (id: string, description: string, quantity: number, amount: number) => L(id, description, quantity, amount, { billable: false, returned: true });
const M = (description: string, quantity: number, amount: number, category: string | null = null): MemoLine => ({ description, quantity, amount, category });
const B = (id: string, date: string, lines: PurchaseLine[], invoiced = false): ReturnBill => ({ id, bill_date: date, invoiced, lines });
const brief = (ps: ReturnType<typeof pairCreditAcrossBills>) => ps.map((p) => [p.kind, "billId" in p ? p.billId : "why" in p ? p.why : null]);

describe("pairCreditAcrossBills", () => {
  it("one slip across three bills, each holding an open returned line: each closes on its own bill", () => {
    const bills = [
      B("b3", "2026-11-12", [back("l3", "Single Pole Switch White", 2, 19.8)]),
      B("b1", "2026-11-03", [back("l1", "1/2 in EMT Connector Steel", 4, 21)]),
      B("b2", "2026-11-07", [back("l2", "3/4 in Rigid Coupling Steel", 1, 7.1)]),
    ];
    const memo = [M("1/2 in EMT Connector Steel", -4, -21), M("3/4 in Rigid Coupling Steel", -1, -7.1), M("Single Pole Switch White", -2, -19.8), M("Sales Tax", 1, -3.84, "Tax")];
    expect(brief(pairCreditAcrossBills(memo, bills))).toEqual([
      ["closeReturned", "b1"],
      ["closeReturned", "b2"],
      ["closeReturned", "b3"],
      ["tax", null],
    ]);
  });

  it("two identical lines on two bills, one marked returned: the marked one closes, even on the later bill", () => {
    const bills = [B("b1", "2026-11-03", [L("u", "Duplex Receptacle Ivory", 5, 15)]), B("b2", "2026-11-09", [back("m", "Duplex Receptacle Ivory", 5, 15)])];
    const p = pairCreditAcrossBills([M("Duplex Receptacle Ivory", -5, -15)], bills);
    expect(p).toMatchObject([{ kind: "closeReturned", billId: "b2", line: { id: "m" } }]);
  });

  it("the same unmarked line on two bills: the earlier bill by its date closes, whatever its id", () => {
    const bills = [B("b1", "2026-11-09", [L("late", "Duplex Receptacle Ivory", 5, 15)]), B("b2", "2026-11-03", [L("early", "Duplex Receptacle Ivory", 5, 15)])];
    expect(pairCreditAcrossBills([M("Duplex Receptacle Ivory", -5, -15)], bills)).toMatchObject([{ kind: "closeWhole", billId: "b2", line: { id: "early" } }]);
  });

  it("an unmarked whole line closes whole; part of a line at its own price splits cent-exact", () => {
    const bills = [B("b1", "2026-11-03", [L("a", "1/2 in EMT Connector Steel", 2, 10.5)]), B("b2", "2026-11-05", [L("b", "3/4 in Rigid Coupling Steel", 3, 21.3)])];
    const p = pairCreditAcrossBills([M("1/2 in EMT Connector Steel", -2, -10.5), M("3/4 in Rigid Coupling Steel", -1, -7.1)], bills);
    expect(p[0]).toMatchObject({ kind: "closeWhole", billId: "b1", line: { id: "a" } });
    expect(p[1]).toMatchObject({ kind: "split", billId: "b2", line: { id: "b" }, kept: { quantity: 2, amount: 14.2 }, back: { quantity: 1, amount: 7.1 } });
  });

  it("a bill an invoice that went out holds: its open return still closes, a line that bills stays, why 'invoiced'", () => {
    const bills = [B("b1", "2026-11-03", [L("a", "1/2 in EMT Connector Steel", 2, 10.5), back("r", "Single Pole Switch White", 1, 9.9)], true)];
    const p = pairCreditAcrossBills([M("1/2 in EMT Connector Steel", -2, -10.5), M("Single Pole Switch White", -1, -9.9)], bills);
    expect(brief(p)).toEqual([
      ["stays", "invoiced"],
      ["closeReturned", "b1"],
    ]);
  });

  it("nothing matches: every part line stays, 'noMatch'; a fee is a fee, a zero is a zero, tax is tax", () => {
    const bills = [B("b1", "2026-11-03", [L("a", "1/2 in EMT Connector Steel", 2, 10.5)])];
    const p = pairCreditAcrossBills([M("Weatherproof Box Cover", -1, -9), M("Restocking Fee", 1, 5), M("Note Line Only", 0, 0), M("Sales Tax", 1, -0.7, "Tax")], bills);
    expect(brief(p)).toEqual([
      ["stays", "noMatch"],
      ["fee", null],
      ["zero", null],
      ["tax", null],
    ]);
  });

  it("the words match but nothing fits (more than the line): 'noFit'", () => {
    const p = pairCreditAcrossBills([M("1/2 in EMT Connector Steel", -9, -47.25)], [B("b1", "2026-11-03", [L("a", "1/2 in EMT Connector Steel", 2, 10.5)])]);
    expect(brief(p)).toEqual([["stays", "noFit"]]);
  });

  it("a one-bill credit pairs exactly as pairCreditMemo pairs it", () => {
    const lines = [
      back("house", "4 in LED Shallow IC Housing", 4, 47.32),
      L("wire", "12/2 NM-B Cable 250 ft", 10, 123.45, { sort_order: 1 }),
      L("switch", "Single Pole Switch White", 5, 49.5, { sort_order: 2 }),
      L("tax", "Sales Tax", 1, 24.04, { category: "Tax", sort_order: 3 }),
    ];
    const memo = [M("H245 4 in LED Shallow IC Housing", -4, -47.32), M("12/2 NM-B Cable 250 ft", -4, -49.38), M("Sales Tax", 1, -12, "Tax"), M("Restocking Fee", 1, 5)];
    for (const invoiced of [false, true]) {
      const old = pairCreditMemo(memo, lines, { invoiced });
      const now = pairCreditAcrossBills(memo, [B("b1", "2026-11-01", lines, invoiced)]);
      expect(now.map((p) => p.kind)).toEqual(old.map((p) => p.kind));
      now.forEach((p, i) => {
        const o = old[i] as any;
        if ("line" in p) expect([p.line.id, (p as any).kept, (p as any).back]).toEqual([o.line.id, o.kept, o.back]);
        if (p.kind === "stays") expect(p.why).toBe(o.why);
      });
    }
  });

  it("andList", () => {
    expect([andList(["T-543"]), andList(["T-543", "T-576"]), andList(["T-543", "T-576", "T-677"])]).toEqual(["T-543", "T-543 and T-576", "T-543, T-576 and T-677"]);
  });
});

describe("creditAcrossBillsSentence", () => {
  it("what closed and where, each split, what stays and why, the fees; a failed close said", () => {
    const bills = [
      B("b1", "2026-11-03", [L("a", "1/2 in EMT Connector Steel", 2, 10.5)]),
      B("b2", "2026-11-05", [L("b", "3/4 in Rigid Coupling Steel", 3, 21.3)]),
      B("b3", "2026-11-06", [L("c", "Single Pole Switch White", 2, 19.8)], true),
    ];
    const memo = [M("1/2 in EMT Connector Steel", -2, -10.5), M("3/4 in Rigid Coupling Steel", -1, -7.1), M("Single Pole Switch White", -2, -19.8), M("Weatherproof Box Cover", -1, -9), M("Restocking Fee", 1, 5)];
    const pairs = pairCreditAcrossBills(memo, bills);
    const words = new Map([["b1", "T-543"], ["b2", "T-576"], ["b3", "T-677"]]);
    expect(creditAcrossBillsSentence({ creditWords: "CM-445", creditTotal: -41.4, memo, pairs, billWords: words })).toBe(
      "CM-445: $41.40 back from the supplier. 2 returned lines are closed on T-543 and T-576 (1/2 in EMT Connector Steel; 3/4 in Rigid Coupling Steel): off the customer's bill, credit received. " +
        "3/4 in Rigid Coupling Steel was split: 2 kept ($14.20), 1 returned ($7.10). " +
        "Single Pole Switch White stays a credit to the customer, as before: an invoice that went out already billed it. " +
        "Weatherproof Box Cover matched no line on this job's bills, so it stays a credit to the customer, as before. " +
        "Restocking Fee ($5.00) is the company's cost, not billed to the customer.",
    );
    const failed = creditAcrossBillsSentence({ creditWords: "The credit", creditTotal: -10.5, memo: memo.slice(0, 1), pairs: pairs.slice(0, 1), billWords: words, notClosed: [0] });
    expect(failed).toBe(
      "The credit: $10.50 back from the supplier. 1/2 in EMT Connector Steel changed on the bill just now, so it was not closed. 1/2 in EMT Connector Steel stays a credit to the customer, as before.",
    );
  });
});

// ── cn-v1184 fixer (skeptic #86) ──────────────────────────────────────────────────────────────────
describe("returnTaxCheck: filing never changes what the customer pays in tax (S1, S13)", () => {
  const tax = (id: string, amount: number, over: Partial<PurchaseLine> = {}) => L(id, "Sales Tax", 1, amount, { category: "Tax", sort_order: 9, ...over });
  const check = (memo: MemoLine[], bills: ReturnBill[]) => returnTaxCheck({ credit: memo, memo, pairs: pairCreditAcrossBills(memo, bills), bills });

  it("the skeptic's ticket: a taxed part, an untaxed delivery charge, the tax: refused ($8.00 against $4.00)", () => {
    const bills = [B("t416", "2026-11-03", [L("part", "Ground Rod Clamp Bronze", 1, 100), L("dlv", "Delivery Charge", 1, 100, { sort_order: 1 }), tax("tx", 8)])];
    const v = check([M("Ground Rod Clamp Bronze", -1, -100), M("Sales Tax", 1, -8, "Tax")], bills);
    expect(v).toEqual({ checked: true, ok: false, creditTaxCents: 800, billsTaxCents: 400, billIds: ["t416"] });
  });

  it("a bill taxed evenly on every line: passes", () => {
    const bills = [B("b1", "2026-11-03", [L("a", "Duplex Receptacle Ivory", 10, 100), L("b", "Single Pole Switch White", 5, 50, { sort_order: 1 }), tax("tx", 12)])];
    expect(check([M("Duplex Receptacle Ivory", -10, -100), M("Sales Tax", 1, -8, "Tax")], bills)).toMatchObject({ checked: true, ok: true, creditTaxCents: 800, billsTaxCents: 800 });
  });

  it("a split, taxed evenly: the kept half bills its tax, the returned half's comes off: passes", () => {
    const bills = [B("b1", "2026-11-03", [L("a", "3/4 in Rigid Coupling Steel", 3, 21.3), tax("tx", 1.7)])];
    const v = check([M("3/4 in Rigid Coupling Steel", -1, -7.1), M("Sales Tax", 1, -0.57, "Tax")], bills);
    expect(v).toMatchObject({ checked: true, ok: true, creditTaxCents: 57, billsTaxCents: 57 });
  });

  it("three bills, each rounding its own tax by a cent: passes (2 cents + 1 per bill)", () => {
    const bills = [
      B("b1", "2026-11-03", [L("x1", "Ground Rod Clamp Bronze", 1, 10.33), L("y1", "Wire Nut Yellow Bag", 1, 7.77, { sort_order: 1 }), tax("t1", 1.49)]),
      B("b2", "2026-11-04", [L("x2", "Weatherproof Box Cover", 1, 4.19), L("y2", "Conduit Strap One Hole", 1, 22.05, { sort_order: 1 }), tax("t2", 2.16)]),
      B("b3", "2026-11-05", [L("x3", "Duplex Receptacle Ivory", 1, 13.07), L("y3", "Cable Staple Box", 1, 0.99, { sort_order: 1 }), tax("t3", 1.16)]),
    ];
    const memo = [M("Ground Rod Clamp Bronze", -1, -10.33), M("Weatherproof Box Cover", -1, -4.19), M("Duplex Receptacle Ivory", -1, -13.07), M("Sales Tax", 1, -2.28, "Tax")];
    const v = check(memo, bills);
    expect(v).toMatchObject({ checked: true, ok: true, creditTaxCents: 228, billsTaxCents: 227 });
    if (v.checked) expect(v.billIds).toHaveLength(3);
  });

  it("a purchase whose tax line a person split by hand: none of its tax comes off with the line: refused", () => {
    const bills = [B("b1", "2026-11-03", [L("a", "Duplex Receptacle Ivory", 10, 100), L("b", "Single Pole Switch White", 10, 100, { sort_order: 1 }), tax("tx", 16, { billed_amount: 10 })])];
    expect(check([M("Duplex Receptacle Ivory", -10, -100), M("Sales Tax", 1, -8, "Tax")], bills)).toMatchObject({ checked: true, ok: false, creditTaxCents: 800, billsTaxCents: 0 });
  });

  it("a credit whose pairs all close returns already marked is never checked", () => {
    const bills = [B("b1", "2026-11-03", [back("r", "Ground Rod Clamp Bronze", 1, 100), L("dlv", "Delivery Charge", 1, 100, { sort_order: 1 }), tax("tx", 8)])];
    const memo = [M("Ground Rod Clamp Bronze", -1, -100), M("Sales Tax", 1, -8, "Tax")];
    expect(pairCreditAcrossBills(memo, bills)[0].kind).toBe("closeReturned");
    expect(check(memo, bills)).toEqual({ checked: false, ok: true });
  });

  it("the credit's part lines already off still count in its tax share (the tax the credit gives back is its own proportion)", () => {
    const bills = [B("b1", "2026-11-03", [L("a", "Duplex Receptacle Ivory", 10, 100), L("b", "Single Pole Switch White", 10, 100, { sort_order: 1 }), tax("tx", 16)])];
    const credit = [M("Duplex Receptacle Ivory", -10, -100), M("Single Pole Switch White", -10, -100), M("Sales Tax", 1, -16, "Tax")];
    const memo = [credit[0], credit[2]];
    const pairs = pairCreditAcrossBills(memo, bills);
    expect(returnTaxCheck({ credit, memo, pairs, bills })).toMatchObject({ checked: true, ok: true, creditTaxCents: 800, billsTaxCents: 800 });
  });
});

describe("pairCreditAcrossBills: lines this credit already closed (S2)", () => {
  it("a bill line naming this credit, same item and amount: closed before, on its bill; never without the credit's id", () => {
    const closed = L("p1", "1/2 in EMT Connector Steel", 2, 10.5, { billable: false, returned: true, returned_credit_bill_id: "cred" });
    const other = L("p2", "1/2 in EMT Connector Steel", 2, 10.5, { billable: false, returned: true, returned_credit_bill_id: "another" });
    const bills = [B("b0", "2026-11-01", [other]), B("b1", "2026-11-03", [closed])];
    const memo = [M("1/2 in EMT Connector Steel", -2, -10.5), M("1/2 in EMT Connector Steel", -2, -10.5)];
    expect(brief(pairCreditAcrossBills(memo, bills, { creditId: "cred" }))).toEqual([
      ["closedBefore", "b1"],
      ["stays", "noFit"],
    ]);
    expect(brief(pairCreditAcrossBills(memo.slice(0, 1), bills))).toEqual([["stays", "noFit"]]);
    // A different amount is not the same line.
    expect(brief(pairCreditAcrossBills([M("1/2 in EMT Connector Steel", -1, -5.25)], bills, { creditId: "cred" }))).toEqual([["stays", "noFit"]]);
  });
});
