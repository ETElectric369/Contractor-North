import { describe, expect, it } from "vitest";
import { applyPenMark, creditExpectedOf, penColumns, penFromColumns, penMarkOf, penSentence, penSummary, type PenLine } from "./pen-marks";

const line = (o: Partial<PenLine> = {}): PenLine => ({ description: "2P 30A breaker", quantity: 1, unit_price: 20.77, amount: 20.77, billable: true, ...o });

describe("penMarkOf", () => {
  it("reads the three marks and nothing else", () => {
    expect(penMarkOf("struck")).toBe("struck");
    expect(penMarkOf(" Quantity ")).toBe("quantity");
    expect(penMarkOf("unclear")).toBe("unclear");
    for (const x of [null, undefined, "", "none", "tick", 1, true]) expect(penMarkOf(x)).toBeNull();
  });
});

describe("applyPenMark", () => {
  it("a line with no mark is the line", () => {
    const l = line();
    expect(applyPenMark(l, {})).toEqual([l]);
    expect(applyPenMark(l, null)).toEqual([l]);
  });

  it("a struck line stays at its PRINTED price and comes off the customer's bill", () => {
    expect(applyPenMark(line(), { pen: "struck" })).toEqual([{ ...line(), pen: "struck", returned: true, billable: false }]);
  });

  it("a quantity changed by hand splits the printed extension: kept, and what went back", () => {
    const [kept, back] = applyPenMark(line({ quantity: 8, unit_price: 9.49, amount: 75.92 }), { pen: "quantity", hand_quantity: 3 });
    expect(kept).toMatchObject({ quantity: 3, amount: 28.47, returned: false, billable: true, pen: "quantity" });
    expect(back).toMatchObject({ quantity: 5, amount: 47.45, returned: true, billable: false, pen: "quantity" });
    expect(Math.round((kept.amount + back.amount) * 100)).toBe(7592);
  });

  it("the split is by the EXTENSION, never quantity times price (a line priced per thousand)", () => {
    // 15 ft at 4,952.50 per thousand: the extension is 74.29, and unit_price times quantity is not.
    const [kept, back] = applyPenMark(line({ quantity: 15, unit_price: 4952.5, amount: 74.29 }), { pen: "quantity", hand_quantity: 10 });
    expect(kept.amount).toBe(49.53);
    expect(back.amount).toBe(24.76);
    expect(kept.unit_price).toBe(4952.5);
  });

  it("the two halves always add back to the printed line, to the cent", () => {
    for (const [q, h, amount] of [[7, 3, 100], [3, 1, 0.1], [9, 4, 33.33], [1000, 1, 132.77]] as const) {
      const [kept, back] = applyPenMark(line({ quantity: q, amount }), { pen: "quantity", hand_quantity: h });
      expect(Math.round((kept.amount + back.amount) * 100)).toBe(Math.round(amount * 100));
    }
  });

  it("a quantity written down to zero is the line struck", () => {
    expect(applyPenMark(line({ quantity: 4, amount: 40 }), { pen: "quantity", hand_quantity: 0 })).toEqual([
      { ...line({ quantity: 4, amount: 40 }), pen: "struck", returned: true, billable: false },
    ]);
  });

  it("a handwritten quantity that is missing, unreadable, negative, or not LESS than printed is never guessed", () => {
    for (const hand of [undefined, null, "", "abc", -1, 8, 12]) {
      expect(applyPenMark(line({ quantity: 8, amount: 80 }), { pen: "quantity", hand_quantity: hand })).toEqual([
        { ...line({ quantity: 8, amount: 80 }), pen: "unclear", billable: false },
      ]);
    }
  });

  it("an unclear mark holds the line off the customer's bill, at its printed price, and answers nothing", () => {
    const [l] = applyPenMark(line(), { pen: "unclear" });
    expect(l).toEqual({ ...line(), pen: "unclear", billable: false });
    expect("returned" in l).toBe(false);
  });

  describe("idempotent on what is already stored (File It and Undo read the lines back)", () => {
    it("a struck line read back is the same line", () => {
      const [once] = applyPenMark(line(), { pen: "struck" });
      expect(applyPenMark(once, once)).toEqual([once]);
    });
    it("the two halves of a split are never split again", () => {
      const halves = applyPenMark(line({ quantity: 8, amount: 75.92 }), { pen: "quantity", hand_quantity: 3 });
      expect(halves.flatMap((h) => applyPenMark(h, h))).toEqual(halves);
    });
    it("an unanswered question read back is still the question", () => {
      const [q] = applyPenMark(line(), { pen: "unclear" });
      expect(applyPenMark(q, q)).toEqual([q]);
    });
    it("a person's Kept on a struck line stands: the mark stays, the line bills", () => {
      expect(applyPenMark(line(), { pen: "struck", returned: false })).toEqual([{ ...line(), pen: "struck", returned: false, billable: true }]);
    });
    it("a person's Returned on a line with no mark stands", () => {
      expect(applyPenMark(line(), { returned: true })).toEqual([{ ...line(), returned: true, billable: false }]);
    });
    it("Kept never switches a line back ON that was off for another reason (a snack stays off)", () => {
      expect(applyPenMark(line({ billable: false }), { pen: "struck", returned: false })[0].billable).toBe(false);
    });
  });
});

describe("penSummary and penSentence", () => {
  const lines = [
    ...applyPenMark(line(), { pen: "struck" }),
    ...applyPenMark(line({ amount: 9.49 }), { pen: "struck" }),
    ...applyPenMark(line({ quantity: 8, amount: 75.92 }), { pen: "quantity", hand_quantity: 3 }),
    line(),
  ];

  it("counts what was read and what comes off", () => {
    expect(penSummary(lines)).toEqual({ struck: 2, quantity: 1, unclear: 0, returnedLines: 3, returnedAmount: 77.71, any: true });
    expect(penSummary([line()])).toMatchObject({ any: false });
    expect(penSummary(null)).toMatchObject({ any: false });
  });

  it("says nothing when there is nothing to say", () => {
    expect(penSentence(penSummary([line()]), { creditExpected: true })).toBeNull();
  });

  it("on account: returned, with a credit expected, and the total kept as printed", () => {
    expect(penSentence(penSummary(lines), { creditExpected: true, comesOff: 84.7 })).toBe(
      "Pen marks read: 2 lines crossed out, 1 quantity changed. $84.70 is marked returned: off the customer's bill, with a credit expected from the supplier. The total is kept as printed.",
    );
  });

  it("paid at purchase: it just comes off the customer's bill, and no credit is spoken of", () => {
    const said = penSentence(penSummary(applyPenMark(line(), { pen: "struck" })), { creditExpected: false });
    expect(said).toBe("Pen marks read: 1 line crossed out. $20.77 comes off the customer's bill. The total is kept as printed.");
    expect(said).not.toMatch(/credit/i);
  });

  it("a mark nobody could read is said as a question, with the two answers", () => {
    expect(penSentence(penSummary(applyPenMark(line(), { pen: "unclear" })), { creditExpected: true })).toBe(
      "1 pen mark couldn't be read for sure: that line is held off the customer's bill until you answer Kept or Returned.",
    );
  });

  it("a handwritten total that agrees is said; one that does not is said with both figures", () => {
    const s = penSummary(applyPenMark(line(), { pen: "struck" }));
    expect(penSentence(s, { creditExpected: true, handTotal: 100, keptTotal: 100.4 })).toMatch(/That matches your handwritten total\.$/);
    expect(penSentence(s, { creditExpected: true, handTotal: 100, keptTotal: 158.73 })).toMatch(/Your handwritten total says \$100\.00; the lines read as kept come to \$158\.73\.$/);
    expect(penSentence(s, { creditExpected: true, handTotal: 100 })).not.toMatch(/handwritten/);
  });
});

describe("creditExpectedOf", () => {
  it("the paper's own word on tender wins: only paid at purchase expects no credit", () => {
    expect(creditExpectedOf({ paperPayment: "paid_at_purchase", billStatus: "unpaid", hasSupplierAccount: true })).toBe(false);
    expect(creditExpectedOf({ paperPayment: "on_account", billStatus: "paid" })).toBe(true);
    expect(creditExpectedOf({ paperPayment: "unknown", billStatus: "paid" })).toBe(true);
  });
  it("an account bill settled since is still owed its credit", () => {
    expect(creditExpectedOf({ paperPayment: "on_account", billStatus: "paid", hasSupplierAccount: true })).toBe(true);
    expect(creditExpectedOf({ billStatus: "paid", hasSupplierAccount: true })).toBe(true);
  });
  it("no paper: a paid bill with no supplier account is a counter sale; anything else is on account", () => {
    expect(creditExpectedOf({ billStatus: "paid", hasSupplierAccount: false })).toBe(false);
    expect(creditExpectedOf({ billStatus: "paid" })).toBe(false);
    expect(creditExpectedOf({ billStatus: "unpaid" })).toBe(true);
    expect(creditExpectedOf({})).toBe(true);
  });
});

describe("a paper's line and its bill's line (0417)", () => {
  it("on account, a returned line tracks its credit; paid at purchase it only comes off the bill", () => {
    const [l] = applyPenMark(line(), { pen: "struck" });
    expect(penColumns(l, true)).toEqual({ pen_mark: "struck", returned: true, billable: false });
    expect(penColumns(l, false)).toEqual({ pen_mark: "struck", returned: false, billable: false });
  });

  it("the open question is held off the bill and tracks nothing", () => {
    const [l] = applyPenMark(line(), { pen: "unclear" });
    expect(penColumns(l, true)).toEqual({ pen_mark: "unclear", returned: false, billable: false });
  });

  it("an unmarked line writes what it always wrote", () => {
    expect(penColumns(line(), true)).toEqual({ pen_mark: null, returned: false, billable: true });
    expect(penColumns(line({ billable: false }), true)).toEqual({ pen_mark: null, returned: false, billable: false });
  });

  it("never returned AND billed: the database's own check, kept here first", () => {
    for (const l of [...applyPenMark(line(), { pen: "struck" }), ...applyPenMark(line({ quantity: 8, amount: 80 }), { pen: "quantity", hand_quantity: 3 }), line()]) {
      for (const credit of [true, false]) {
        const c = penColumns(l, credit);
        expect(c.returned && c.billable).toBe(false);
      }
    }
  });

  it("an Undo brings back what the paper said and what a person answered", () => {
    // On account, struck: back as returned.
    expect(penFromColumns({ pen_mark: "struck", returned: true, billable: false })).toEqual({ pen: "struck", returned: true });
    // Paid at purchase, struck: no credit tracked, still off the bill.
    expect(penFromColumns({ pen_mark: "struck", returned: false, billable: false })).toEqual({ pen: "struck", returned: true });
    // A person switched it back to Kept on the bill.
    expect(penFromColumns({ pen_mark: "struck", returned: false, billable: true })).toEqual({ pen: "struck", returned: false });
    // The kept half of a changed quantity.
    expect(penFromColumns({ pen_mark: "quantity", returned: false, billable: true })).toEqual({ pen: "quantity", returned: false });
    // A person's Returned on a line the reader saw no mark on.
    expect(penFromColumns({ pen_mark: null, returned: true, billable: false })).toEqual({ returned: true });
    // An open question stays open.
    expect(penFromColumns({ pen_mark: "unclear", returned: false, billable: false })).toEqual({ pen: "unclear" });
    // An ordinary line says nothing.
    expect(penFromColumns({ pen_mark: null, returned: false, billable: true })).toEqual({});
  });

  it("round trip: paper to bill to paper keeps the line's state, both ways of paying", () => {
    for (const credit of [true, false]) {
      for (const l of [...applyPenMark(line(), { pen: "struck" }), ...applyPenMark(line({ quantity: 8, amount: 80 }), { pen: "quantity", hand_quantity: 3 })]) {
        const back = penFromColumns(penColumns(l, credit));
        expect(back).toEqual({ pen: l.pen, returned: l.returned });
      }
    }
  });
});
