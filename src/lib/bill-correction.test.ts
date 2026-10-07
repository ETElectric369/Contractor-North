import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canCorrect,
  carriesCorrectionRefusal,
  correctionFaces,
  correctionOfCorrectionRefusal,
  correctionsUnder,
  lineWords,
  paperGapWords,
  planBillCorrection,
  setAsideOriginalRefusal,
  signedMoney,
  type CorrectionOriginal,
} from "@/lib/bill-correction";

/**
 * THE CORRECTION DOOR'S ARITHMETIC AND WORDS (0381), pinned with no database.
 *
 * The fixture is J-011's counter ticket as it sits in the book (bill and paper numbers only): CED
 * 8802-SO-257899, $613.19, five lines, the undercabinet fixture priced at $0.00 by the counter. The
 * supplier's invoice for the same purchase, 8802-1109100, says $709.18: the fixture was $95.99.
 */
const TICKET: CorrectionOriginal = {
  amount: 613.19,
  billNumber: "8802-SO-257899",
  lines: [
    { description: "LUT DVELV300PWH", amount: 487.85, billable: true, category: null },
    { description: "WAC EN1260RAR", amount: 42.11, billable: true, category: null },
    { description: "RAB KNOOKFA32 UNDERCAB LED", amount: 0, billable: true, category: null },
    { description: "SYL LED6MR16", amount: 32.6, billable: true, category: null },
    { description: "Tax", amount: 50.63, billable: true, category: "Tax" },
  ],
};
const JOB = "J-011 · TEST Job";

describe("planBillCorrection — the supplier's later paper for the same purchase", () => {
  it("J-011: one line with no amount takes the whole difference, and the sentence says the pair is one purchase", () => {
    const plan = planBillCorrection({
      original: TICKET,
      paperTotal: 709.18,
      paperNumber: " 8802-1109100 ",
      lines: [{ description: "RAB KNOOKFA32 UNDERCAB LED" }],
      jobLabel: JOB,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.delta).toBe(95.99);
    expect(plan.together).toBe(709.18);
    expect(plan.row).toEqual({ amount: 95.99, bill_number: "8802-1109100" });
    // ITS OWN ITEMIZED LINE (the invoice-line law): the fixture, billed to the customer.
    expect(plan.lines).toEqual([
      { description: "RAB KNOOKFA32 UNDERCAB LED", quantity: 1, unit_price: 95.99, amount: 95.99, billable: true, category: null, sort_order: 0 },
    ]);
    expect(plan.sentence).toBe(
      "8802-1109100 corrects 8802-SO-257899: +$95.99 (RAB KNOOKFA32 UNDERCAB LED). The pair is one purchase, $709.18. " +
        "The next invoice on J-011 · TEST Job carries the $95.99.",
    );
  });

  it("a business cost (no job) says nothing about an invoice", () => {
    const plan = planBillCorrection({ original: TICKET, paperTotal: 709.18, paperNumber: "8802-1109100", lines: [{ description: "Fixture" }] });
    expect(plan.ok && plan.sentence).toBe("8802-1109100 corrects 8802-SO-257899: +$95.99 (Fixture). The pair is one purchase, $709.18.");
  });

  it("refuses a paper that says the same figure: nothing to correct", () => {
    const plan = planBillCorrection({ original: TICKET, paperTotal: 613.19, paperNumber: "8802-1109100", lines: [{ description: "x" }] });
    expect(plan).toEqual({ ok: false, error: "The paper says the same $613.19 the bill says. Nothing to correct." });
  });

  it("compares the paper with the WHOLE purchase once a correction is already under it", () => {
    const corrected = { ...TICKET, corrections: [{ billNumber: "8802-1109100", amount: 95.99 }] };
    expect(planBillCorrection({ original: corrected, paperTotal: 709.18, paperNumber: "8802-1109200", lines: [{ description: "x" }] })).toEqual({
      ok: false,
      error: "The paper says the same $709.18 the bill and its correction say. Nothing to correct.",
    });
    const plan = planBillCorrection({ original: corrected, paperTotal: 719.18, paperNumber: "8802-1109200", lines: [{ description: "Freight" }] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.delta).toBe(10);
    expect(plan.sentence).toBe("8802-1109200 corrects 8802-SO-257899: +$10.00 (Freight). Together they are one purchase, $719.18.");
  });

  it("the lines must come to the difference to the cent, and the refusal names both figures", () => {
    const plan = planBillCorrection({
      original: TICKET,
      paperTotal: 709.18,
      paperNumber: "8802-1109100",
      lines: [
        { description: "Fixture", amount: 50 },
        { description: "Tax", amount: 40 },
      ],
    });
    expect(plan).toEqual({
      ok: false,
      error: "The lines come to +$90.00 and the paper is $95.99 more than the bill. Make them match. Nothing was attached.",
    });
  });

  it("an empty amount takes what the other lines leave, and a tax line is stored as tax", () => {
    const plan = planBillCorrection({
      original: TICKET,
      paperTotal: 709.18,
      paperNumber: "8802-1109100",
      lines: [{ description: "RAB KNOOKFA32 UNDERCAB LED", amount: 88.06 }, { description: "Sales Tax" }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.map((l) => [l.description, l.amount, l.category])).toEqual([
      ["RAB KNOOKFA32 UNDERCAB LED", 88.06, null],
      ["Sales Tax", 7.93, "Tax"],
    ]);
    // Float noise never decides a cent: 88.06 + 7.93 is the 95.99, exactly.
    expect(plan.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(9599);
  });

  it("only one line may take what is left", () => {
    const plan = planBillCorrection({ original: TICKET, paperTotal: 709.18, paperNumber: "N", lines: [{ description: "A" }, { description: "B" }] });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toBe("Give each line its amount: only one line can take what is left (A, B). Nothing was attached.");
  });

  it("asks for the paper's number, its total, and what the difference is for, one at a time", () => {
    expect(planBillCorrection({ original: TICKET, paperTotal: 709.18, paperNumber: "  ", lines: [{ description: "x" }] })).toEqual({
      ok: false,
      error: "Type the number printed on the supplier's paper in Paper Number. Nothing was attached.",
    });
    expect(planBillCorrection({ original: TICKET, paperTotal: null, paperNumber: "N", lines: [{ description: "x" }] })).toEqual({
      ok: false,
      error: "Type what the supplier's paper says the purchase comes to in Paper Total. Nothing was attached.",
    });
    expect(planBillCorrection({ original: TICKET, paperTotal: 709.18, paperNumber: "N", lines: [{ description: " " }] })).toEqual({
      ok: false,
      error: "Say what the difference is for (What Is It For?). Nothing was attached.",
    });
    expect(planBillCorrection({ original: TICKET, paperTotal: 709.18, paperNumber: "N", lines: [{ description: "", amount: 95.99 }] })).toEqual({
      ok: false,
      error: "Give every line its words: what is the $95.99 for? Nothing was attached.",
    });
  });

  it("a line that comes to $0.00 corrects nothing", () => {
    const plan = planBillCorrection({
      original: TICKET,
      paperTotal: 709.18,
      paperNumber: "N",
      lines: [{ description: "Fixture", amount: 95.99 }, { description: "Nothing" }],
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("Nothing comes to $0.00, which corrects nothing.");
  });
});

/**
 * A CREDIT FOLLOWS THE LINE IT CORRECTS (Erik, 2026-10-07, question 5: billable iff that line was
 * billed). The return path matches a credited line BY ITS WORDS to the purchase lines on the job, so
 * every credited line must carry the words of a line the purchase has, spelled the way the purchase
 * spells it; one that names nothing would be credited in full at markup.
 */
describe("planBillCorrection — a credit (the paper less than the bill)", () => {
  it("each credited line carries the original line's words, billing switch and category", () => {
    const plan = planBillCorrection({
      original: TICKET,
      paperTotal: 561.61,
      paperNumber: "8802-1109300",
      lines: [{ description: "wac en1260rar", amount: -42.11 }, { description: "TAX" }],
      jobLabel: JOB,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.delta).toBe(-51.58);
    expect(plan.lines).toEqual([
      { description: "WAC EN1260RAR", quantity: 1, unit_price: -42.11, amount: -42.11, billable: true, category: null, sort_order: 0 },
      { description: "Tax", quantity: 1, unit_price: -9.47, amount: -9.47, billable: true, category: "Tax", sort_order: 1 },
    ]);
    expect(plan.sentence).toBe(
      "8802-1109300 corrects 8802-SO-257899: −$51.58 (WAC EN1260RAR; Tax). The pair is one purchase, $561.61. " +
        "The next invoice on J-011 · TEST Job credits back what the customer was billed for it.",
    );
  });

  it("a credit on a line the customer was never billed for stays the company's own, and says no invoice credits it", () => {
    const own = { ...TICKET, lines: [...TICKET.lines, { description: "Kettle Chips", amount: 2.09, billable: false, category: "Other" }] };
    const plan = planBillCorrection({ original: own, paperTotal: 611.1, paperNumber: "N", lines: [{ description: "Kettle Chips" }], jobLabel: JOB });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0]).toMatchObject({ description: "Kettle Chips", amount: -2.09, billable: false, category: "Other" });
    expect(plan.sentence.endsWith("None of it was billed to the customer, so no invoice credits it.")).toBe(true);
  });

  it("refuses a credited line that names no line of the bill, and names it", () => {
    const plan = planBillCorrection({ original: TICKET, paperTotal: 561.61, paperNumber: "N", lines: [{ description: "Returned housings" }] });
    expect(plan).toEqual({
      ok: false,
      error: "Returned housings is not a line on 8802-SO-257899. A credit takes back a line the purchase has: pick it from the bill's lines. Nothing was attached.",
    });
  });

  it("a positive line in a credit is a charge (a restocking fee the supplier kept) and needs no match", () => {
    const plan = planBillCorrection({
      original: TICKET,
      paperTotal: 576.18,
      paperNumber: "N",
      lines: [{ description: "WAC EN1260RAR", amount: -42.11 }, { description: "Restocking fee", amount: 5.1 }],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.lines.map((l) => [l.description, l.amount, l.billable])).toEqual([["WAC EN1260RAR", -42.11, true], ["Restocking fee", 5.1, true]]);
  });
});

describe("the words", () => {
  it("a signed figure carries a true minus sign, and no sentence carries a dash", () => {
    expect(signedMoney(95.99)).toBe("+$95.99");
    expect(signedMoney(-51.58)).toBe("−$51.58");
    expect(paperGapWords(TICKET, 709.18)).toBe("+$95.99 more than the bill");
    expect(paperGapWords(TICKET, 561.61)).toBe("−$51.58 less: a credit");
    expect(paperGapWords(TICKET, 613.19)).toBe("The same as the bill: nothing to correct.");
    const sentences = [
      correctionOfCorrectionRefusal("8802-1109100"),
      setAsideOriginalRefusal(null),
      carriesCorrectionRefusal(["8802-1109100"], "delete it again"),
      paperGapWords(TICKET, 561.61),
    ];
    for (const s of sentences) {
      expect(s).not.toContain("—");
      expect(s).not.toContain("–");
    }
  });

  it("the delete doors' refusal names the correction to take down first", () => {
    expect(carriesCorrectionRefusal(["8802-1109100"])).toBe("This bill carries a correction (8802-1109100). Delete the correction first. Nothing was deleted.");
    expect(carriesCorrectionRefusal(["A", "B"], "press Undo again", "Nothing was undone.")).toBe(
      "This bill carries corrections (A, B). Delete the corrections first, then press Undo again. Nothing was undone.",
    );
  });

  /**
   * ONE SENTENCE, TWO PLACES: the door says first what 0381's guard_bill_correction would raise, so
   * Erik is taught one way out. Read off the migration itself, its placeholder filled the way the
   * trigger fills it (coalesce(nullif(bill_number, ''), 'that bill')).
   */
  it("the door's refusals are the trigger's own, word for word", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0381_a_bill_may_correct_an_earlier_bill.sql"), "utf8");
    const raised = (start: string) => {
      const m = sql.match(new RegExp(`raise exception '(% ${start}[^']*)'`));
      expect(m, `0381 no longer raises "% ${start}…"`).not.toBeNull();
      return m![1];
    };
    expect(correctionOfCorrectionRefusal("8802-1109100")).toBe(raised("is itself a correction").replace("%", "8802-1109100"));
    expect(setAsideOriginalRefusal("")).toBe(raised("was set aside as a duplicate").replace("%", "that bill"));
  });

  it("lineWords reads a line the way the return path does", () => {
    expect(lineWords(" RAB  KnookFA32, undercab-LED ")).toBe("rab knookfa32 undercab led");
  });
});

describe("the rows: a correction sits under its original, and both say so", () => {
  const rows = [
    // Paper order, newest first (cn-v1063): the correction is dated after the ticket, so it reads first.
    { id: "c", corrects_bill_id: "o", amount: 95.99, bill_number: "8802-1109100" },
    { id: "x", corrects_bill_id: null, amount: 40, bill_number: "OSH-1" },
    { id: "o", corrects_bill_id: null, amount: "613.19", bill_number: "8802-SO-257899" },
    { id: "orphan", corrects_bill_id: "gone", amount: 5, bill_number: "N-2" },
  ];

  it("each says its half of the pair, and the original says what the purchase comes to", () => {
    const faces = correctionFaces(rows);
    expect(faces.get("c")).toEqual({ kind: "corrects", originalId: "o", originalNumber: "8802-SO-257899", words: "Corrects 8802-SO-257899" });
    expect(faces.get("o")).toEqual({ kind: "correctedBy", words: "Corrected by 8802-1109100 · $709.18 together", together: 709.18 });
    expect(faces.get("x")).toBeUndefined();
    expect(faces.get("orphan")).toMatchObject({ words: "Corrects an earlier bill" });
    // The number the row prints wins over the typed one.
    const shown = correctionFaces([{ ...rows[2], shownNumber: "SO-257899" }, rows[0]]);
    expect(shown.get("c")?.words).toBe("Corrects SO-257899");
  });

  it("keeps the paper order and moves each correction directly under its original", () => {
    expect(correctionsUnder(rows).map((r) => r.id)).toEqual(["x", "o", "c", "orphan"]);
    // Two corrections keep the order they came in.
    const two = correctionsUnder([...rows, { id: "c2", corrects_bill_id: "o", amount: 1, bill_number: "N-3" }]);
    expect(two.map((r) => r.id)).toEqual(["x", "o", "c", "c2", "orphan"]);
  });

  it("Correct This Bill is offered on a bill that is not a correction and not set aside, once the column is read", () => {
    expect(canCorrect({ corrects_bill_id: null }, true)).toBe(true);
    expect(canCorrect({ corrects_bill_id: null }, false)).toBe(false);
    expect(canCorrect({ corrects_bill_id: "o" }, true)).toBe(false);
    expect(canCorrect({ superseded: true }, true)).toBe(false);
    expect(canCorrect({ superseded_by_bill_id: "k" }, true)).toBe(false);
  });
});
