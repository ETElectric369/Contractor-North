import { describe, it, expect } from "vitest";
import { billItemisation, type BillLine } from "@/lib/bill-itemisation";
import { isReturnBill, returnCreditCost, returnCreditRows, returnLinesAgainstPurchases, returnsSummaryParts, returnsThatFit } from "@/lib/supplier-returns";

/**
 * A SUPPLIER RETURN REACHES THE INVOICE — the arithmetic, pinned.
 *
 * The fixture is the INV-078 return as it sits in the database: four LED housings back to CED,
 * -$51.58, filed as a negative bill with the count, the price and the extension all negative. The
 * job's materials markup is 15%.
 */

const RETURN_ID = "2f328286-b134-428f-a8b5-ad7702c15453";
const bill = (amount: unknown, extra: Record<string, unknown> = {}) => ({
  id: RETURN_ID,
  supplier: "Consolidated Electrical Dist.",
  bill_number: null,
  amount,
  ...extra,
});

const HSG: BillLine = { id: "8a5a091c", description: "H245ICAT 4 in LED Shallow IC HSG", quantity: "-4.00", unit_price: "-11.83", amount: "-47.32", category: "Electrical", billable: true, billed_amount: null };
const TAX: BillLine = { id: "5f575ae5", description: "Sales Tax", quantity: "1.00", unit_price: "-4.26", amount: "-4.26", category: "Tax", billable: true, billed_amount: null };

const sum = (rows: { quantity: number; unit_price: number }[]) => Math.round(rows.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100;
const mark = (cost: number, pct: number) => Math.round(cost * (1 + pct / 100) * 100) / 100;

describe("returnCreditRows — a return is the receipt read backwards", () => {
  it("credits the returned line and its tax at the job's markup, labelled plainly", () => {
    const rows = returnCreditRows(bill("-51.58"), [HSG, TAX], 15);
    expect(rows.map((r) => [r.import_key, r.description, r.quantity, r.unit_price])).toEqual([
      // $47.32 × 1.15 = $54.42, shown per housing as 4 × $13.61 (the same presentation the
      // purchase side uses); the tax row carries the $4.26 tax marked up plus the two cents.
      ["bli:8a5a091c", "Returned: H245ICAT 4 in LED Shallow IC HSG", 4, -13.61],
      [`bill:${RETURN_ID}:remainder`, "Returned: tax", 1, -4.88],
    ]);
    // The anchor invariant, backwards: the rows credit exactly the marked-up return, on the cent.
    expect(sum(rows)).toBe(-mark(51.58, 15)); // -59.32
  });

  it("is the mirror of the purchase: the credit equals what billing the same paper would charge", () => {
    const purchase = billItemisation(
      { id: RETURN_ID, supplier: "Consolidated Electrical Dist.", bill_number: null, amount: "51.58" },
      [
        { ...HSG, quantity: "4.00", unit_price: "11.83", amount: "47.32" },
        { ...TAX, unit_price: "4.26", amount: "4.26" },
      ],
      15,
    );
    const credit = returnCreditRows(bill("-51.58"), [HSG, TAX], 15);
    expect(credit.map((r) => [r.import_key, r.quantity, r.unit_price])).toEqual(purchase.map((r) => [r.import_key, r.quantity, -r.unit_price]));
  });

  it("reads a return scanned with a positive count the same as one with a negative count", () => {
    const posQty = { ...HSG, quantity: "4.00", unit_price: "-11.83" };
    expect(returnCreditRows(bill("-51.58"), [posQty, TAX], 15)).toEqual(returnCreditRows(bill("-51.58"), [HSG, TAX], 15));
  });

  it("credits NOTHING when every line is switched off — the INV-078 rows as Erik left them", () => {
    const off = [{ ...HSG, billable: false }, { ...TAX, billable: false }];
    expect(returnCreditRows(bill("-51.58"), off, 15)).toEqual([]);
    expect(returnCreditCost("-51.58", off)).toBe(0);
  });

  it("credits nothing when the returned line is off, even with its tax line left on", () => {
    // Tax rides with what it taxes: an untouched tax line goes wherever its lines go.
    const off = [{ ...HSG, billable: false }, TAX];
    expect(returnCreditRows(bill("-51.58"), off, 15)).toEqual([]);
    expect(returnCreditCost("-51.58", off)).toBe(0);
  });

  it("a non-billable line is never credited, and takes its share of the tax with it", () => {
    const wire: BillLine = { id: "w", description: "Wire", quantity: "-1", unit_price: "-40.00", amount: "-40.00", category: "Electrical", billable: true, billed_amount: null };
    const snack: BillLine = { id: "s", description: "Gloves", quantity: "-1", unit_price: "-10.00", amount: "-10.00", category: "Electrical", billable: false, billed_amount: null };
    const tax: BillLine = { id: "t", description: "Tax", quantity: "1", unit_price: "-4.00", amount: "-4.00", category: "Tax", billable: true, billed_amount: null };
    const rows = returnCreditRows(bill("-54.00"), [wire, snack, tax], 25);
    // Off: $10 of gloves + 1/5 of the $4 tax = $10.80. Credit: (54 − 10.80) × 1.25 = $54.00.
    expect(rows.map((r) => [r.description, r.unit_price])).toEqual([
      ["Returned: Wire", -50],
      ["Returned: tax", -4],
    ]);
    expect(rows.some((r) => r.description.includes("Gloves"))).toBe(false);
    expect(returnCreditCost("-54.00", [wire, snack, tax])).toBe(43.2);
    expect(sum(rows)).toBe(-mark(43.2, 25));
  });

  it("a return line carrying a split credits only that part, tax in proportion (the mirror)", () => {
    // The mechanism the purchase cap below feeds: a split on the RETURN line (which
    // returnLinesAgainstPurchases writes from the purchase) reads exactly as 0272's split.
    const box: BillLine = { id: "box", description: "IDEAL 30641 500/5000 Twister 341-Tan", quantity: "-500", unit_price: "-108.36", amount: "-108.36", category: "Electrical", billable: true, billed_amount: "13.00", is_stock: true };
    const tax: BillLine = { id: "t", description: "Sales Tax", quantity: "1", unit_price: "-9.75", amount: "-9.75", category: "Tax", billable: true, billed_amount: null };
    const rows = returnCreditRows(bill("-118.11"), [box, tax], 25);
    expect(rows.map((r) => [r.description, r.quantity, r.unit_price])).toEqual([
      ["Returned: IDEAL 30641 500/5000 Twister 341-Tan (the part this job was billed)", 1, -16.25],
      ["Returned: tax", 1, -1.46],
    ]);
    const cost = returnCreditCost("-118.11", [box, tax]);
    expect(cost).toBe(14.17); // 13.00 + 9.75 × 13.00/108.36
    expect(sum(rows)).toBe(-mark(cost, 25));
  });

  it("a stock container the job was billed none of credits nothing", () => {
    const box: BillLine = { id: "box", description: "Twister box", quantity: "-1", unit_price: "-108.36", amount: "-108.36", category: "Electrical", billable: true, billed_amount: "0", is_stock: true };
    expect(returnCreditRows(bill("-108.36"), [box], 25)).toEqual([]);
    expect(returnCreditCost("-108.36", [box])).toBe(0);
  });

  it("every row lands on the cent, and the rows sum to the marked-up credit at awkward markups", () => {
    const lines: BillLine[] = [
      { id: "a", description: "Plate", quantity: "-33", unit_price: "-0.50", amount: "-16.50", category: "Electrical", billable: true, billed_amount: null },
      { id: "b", description: "Dimmer", quantity: "-11", unit_price: "-35.07", amount: "-385.77", category: "Electrical", billable: true, billed_amount: null },
      { id: "c", description: "Tax", quantity: "1", unit_price: "-36.20", amount: "-36.20", category: "Tax", billable: true, billed_amount: null },
    ];
    for (const pct of [0, 12.5, 15, 17.3, 33.333]) {
      const rows = returnCreditRows(bill("-438.47"), lines, pct);
      for (const r of rows) expect(Math.round(r.unit_price * 100) / 100).toBe(r.unit_price);
      expect(sum(rows)).toBe(-mark(returnCreditCost("-438.47", lines), pct));
    }
  });

  it("a return with no lines (hand-entered) credits its whole amount as one row", () => {
    const rows = returnCreditRows(bill("-80.00", { bill_number: "8802-1101363" }), [], 20);
    expect(rows).toEqual([
      { import_key: `bill:${RETURN_ID}`, description: "Returned: materials — Consolidated Electrical Dist. (bill #8802-1101363)", quantity: 1, unit: "lot", unit_price: -96 },
    ]);
    expect(returnCreditCost("-80.00", [])).toBe(80);
  });

  it("a restocking fee the supplier kept stays a charge, not a credit", () => {
    const fee: BillLine = { id: "fee", description: "Restocking fee", quantity: "1", unit_price: "5.00", amount: "5.00", category: "Fee", billable: true, billed_amount: null };
    const rows = returnCreditRows(bill("-42.32"), [HSG, fee], 10);
    expect(rows.map((r) => [r.description, r.unit_price])).toEqual([
      ["Returned: H245ICAT 4 in LED Shallow IC HSG", -13.01],
      ["Restocking fee", 5.5],
      // The cent the per-housing presentation rounded away, trued up like any receipt's remainder.
      ["Returned: other items — Consolidated Electrical Dist.", -0.01],
    ]);
    expect(sum(rows)).toBe(-mark(42.32, 10));
  });

  it("is not a return when the bill is a purchase, or zero", () => {
    expect(isReturnBill("51.58")).toBe(false);
    expect(isReturnBill("0.00")).toBe(false);
    expect(isReturnBill("-0.001")).toBe(false);
    expect(isReturnBill(null)).toBe(false);
    expect(isReturnBill("-0.01")).toBe(true);
    expect(returnCreditRows(bill("51.58"), [HSG, TAX], 15)).toEqual([]);
    expect(returnCreditCost("51.58", [HSG, TAX])).toBe(0);
  });
});

describe("returnsSummaryParts — the import says what happened to each return", () => {
  it("names the credit that landed", () => {
    expect(returnsSummaryParts([{ supplier: "CED", amount: -51.58, credit: 59.32 }], [])).toEqual([
      "a supplier return credited back to the customer: -$59.32",
    ]);
    expect(
      returnsSummaryParts(
        [
          { supplier: "CED", amount: -51.58, credit: 59.32 },
          { supplier: "Home Depot", amount: -10, credit: 11.5 },
        ],
        [],
      ),
    ).toEqual(["2 supplier returns credited back to the customer: -$70.82"]);
  });

  it("says why a return was not credited", () => {
    expect(returnsSummaryParts([], [{ supplier: "Consolidated Electrical Dist.", amount: -51.58, credit: 0 }])).toEqual([
      "the Consolidated Electrical Dist. return of $51.58 not credited — none of what went back was billed to the customer (its lines, or the purchase they came off, are marked as your own cost)",
    ]);
  });

  it("says a held return is held, with the amount and where it goes", () => {
    expect(returnsSummaryParts([], [], [{ supplier: "CED", amount: -51.58, credit: 59.32 }])).toEqual([
      "the CED return ($59.32 back to the customer) held — it is more than this invoice bills, and an invoice below zero would settle with the rest of the credit lost; it comes off the next invoice on this job that bills more than it",
    ]);
  });

  it("says nothing when there were no returns", () => {
    expect(returnsSummaryParts([], [])).toEqual([]);
  });
});

/**
 * A RETURN CREDITS WHAT THE CUSTOMER WAS BILLED, NEVER MORE - built from a purchase + return pair,
 * the way the rows sit in the database (the return line carries no split: the app cannot set one).
 */
describe("returnLinesAgainstPurchases — the return is held to the purchase it reverses", () => {
  type B = { id: string; amount: string; lines: BillLine[] };
  const credit = (bills: B[], pct: number) => {
    const held = returnLinesAgainstPurchases(bills, (b) => b.lines);
    return bills
      .filter((b) => isReturnBill(b.amount))
      .map((b) => sum(returnCreditRows({ id: b.id, supplier: "CED", amount: b.amount }, held.get(b) ?? b.lines, pct)));
  };
  const BOX_BUY: BillLine = { id: "p-box", description: "IDEAL 30641 Twister 341-Tan 500", quantity: "1", unit_price: "108.36", amount: "108.36", category: "Electrical", billable: true, billed_amount: null };
  const BOX_BACK: BillLine = { id: "r-box", description: "IDEAL 30641 Twister 341-Tan 500", quantity: "-1", unit_price: "-108.36", amount: "-108.36", category: "Electrical", billable: true, billed_amount: null };
  const TAX_BUY: BillLine = { id: "p-tax", description: "Tax", quantity: "1", unit_price: "9.75", amount: "9.75", category: "Tax", billable: true, billed_amount: null };
  const TAX_BACK: BillLine = { id: "r-tax", description: "Tax", quantity: "1", unit_price: "-9.75", amount: "-9.75", category: "Tax", billable: true, billed_amount: null };

  it("a box billed in part credits only that part: $13.00 of $108.36, tax share and markup included", () => {
    const bills: B[] = [
      { id: "buy", amount: "118.11", lines: [{ ...BOX_BUY, billed_amount: "13.00" }, TAX_BUY] },
      { id: "back", amount: "-118.11", lines: [BOX_BACK, TAX_BACK] },
    ];
    // (13.00 + 9.75 × 13/108.36) × 1.25 = 14.17 × 1.25 = $17.71 - what the customer was billed.
    expect(credit(bills, 25)).toEqual([-17.71]);
    const purchaseBilled = sum(billItemisation({ id: "buy", supplier: "CED", amount: "118.11" }, bills[0].lines, 25));
    expect(purchaseBilled).toBe(17.71);
  });

  it("a purchase switched off credits nothing when it goes back", () => {
    const bills: B[] = [
      { id: "buy", amount: "118.11", lines: [{ ...BOX_BUY, billable: false }, TAX_BUY] },
      { id: "back", amount: "-118.11", lines: [BOX_BACK, TAX_BACK] },
    ];
    expect(credit(bills, 25)).toEqual([0]);
  });

  it("a purchase billed in full credits the whole return, unchanged", () => {
    const bills: B[] = [
      { id: "buy", amount: "118.11", lines: [BOX_BUY, TAX_BUY] },
      { id: "back", amount: "-118.11", lines: [BOX_BACK, TAX_BACK] },
    ];
    const held = returnLinesAgainstPurchases(bills, (b) => b.lines);
    expect(held.get(bills[1])).toEqual(bills[1].lines); // untouched
    expect(credit(bills, 25)).toEqual([-mark(118.11, 25)]);
  });

  it("two returns of one purchase share what it billed, and never credit more between them", () => {
    const bills: B[] = [
      { id: "buy", amount: "108.36", lines: [{ ...BOX_BUY, billed_amount: "13.00" }] },
      { id: "back-1", amount: "-108.36", lines: [{ ...BOX_BACK, id: "r1" }] },
      { id: "back-2", amount: "-108.36", lines: [{ ...BOX_BACK, id: "r2" }] },
    ];
    expect(credit(bills, 0)).toEqual([-13, 0]);
  });

  it("matches the return's words to the purchase's even with the catalogue number in front", () => {
    // The INV-078 pair as CED printed it: the purchase line was switched off, so the return credits
    // nothing even if nobody had switched the return lines off too.
    const bills: B[] = [
      { id: "buy", amount: "873.66", lines: [{ id: "p", description: "4 in LED SHALLOW IC HSG", quantity: "4.00", unit_price: "11.83", amount: "47.32", category: "Electrical", billable: false, billed_amount: null }] },
      { id: "back", amount: "-51.58", lines: [HSG, TAX] },
    ];
    expect(credit(bills, 15)).toEqual([0]);
  });

  it("a returned line with no matching purchase on the job credits in full", () => {
    const bills: B[] = [
      { id: "buy", amount: "95.40", lines: [{ id: "p", description: "4 in RL 600/900LM 5CCT D2W", quantity: "4", unit_price: "23.85", amount: "95.40", category: "Electrical", billable: true, billed_amount: null }] },
      { id: "back", amount: "-51.58", lines: [HSG, TAX] },
    ];
    expect(credit(bills, 15)).toEqual([-59.32]);
  });

  it("one word in common is not a match", () => {
    const bills: B[] = [
      { id: "buy", amount: "10", lines: [{ id: "p", description: "Wire", quantity: "1", unit_price: "10", amount: "10", category: "Electrical", billable: false, billed_amount: null }] },
      { id: "back", amount: "-10", lines: [{ id: "r", description: "Wire nuts", quantity: "-1", unit_price: "-10", amount: "-10", category: "Electrical", billable: true, billed_amount: null }] },
    ];
    expect(credit(bills, 0)).toEqual([-10]);
  });

  it("the Herringbone job as it sits today reads the same: nothing new to credit on INV-078", () => {
    // Every return line is switched off (Erik's hand fix), and so is the purchase line it reverses.
    const bills: B[] = [
      {
        id: "0c93fb13",
        amount: "873.66",
        lines: [
          { id: "51f476d0", description: "4 in LED SHALLOW IC HSG", quantity: "4.00", unit_price: "11.83", amount: "47.32", category: "Electrical", billable: false, billed_amount: null },
          { id: "479c0ea0", description: "Tax @ 9.00000%", quantity: "1.00", unit_price: "72.14", amount: "72.14", category: "Tax", billable: true, billed_amount: null },
        ],
      },
      { id: RETURN_ID, amount: "-51.58", lines: [{ ...HSG, billable: false }, { ...TAX, billable: false }] },
    ];
    expect(credit(bills, 15)).toEqual([0]);
  });
});

/**
 * WHICH RETURN SPENDS THE PURCHASE FIRST (audit v994, DB3). The budget used to go in uuid order,
 * blind to what was already credited, so a later return whose id happened to sort first took the
 * purchase an earlier CREDITED return had used up - and was credited again on top of it.
 */
describe("returnLinesAgainstPurchases — the credited return spends first, then filing order", () => {
  type B = { id: string; amount: string; created_at?: string; lines: BillLine[] };
  const BUY: BillLine = { id: "p1", description: "4 in LED SHALLOW IC HSG", quantity: "4", unit_price: "25", amount: "100", category: "Electrical", billable: true, billed_amount: null };
  const back = (id: string, count: number, created_at?: string): B => ({
    id,
    amount: String(-25 * count),
    created_at,
    lines: [{ id: `${id}-l`, description: "H245ICAT 4 in LED Shallow IC HSG", quantity: String(-count), unit_price: "-25", amount: String(-25 * count), category: "Electrical", billable: true, billed_amount: null }],
  });
  /** What each return credits, at cost, keyed by bill id. */
  const credits = (bills: B[], claimed?: Set<string>) => {
    const held = returnLinesAgainstPurchases(bills, (b) => b.lines, claimed);
    return Object.fromEntries(
      bills
        .filter((b) => isReturnBill(b.amount))
        .map((b) => [b.id, 0 - sum(returnCreditRows({ id: b.id, supplier: "CED", amount: b.amount }, held.get(b) ?? b.lines, 0)) || 0]),
    );
  };
  const buy: B = { id: "5555-buy", amount: "100", created_at: "2026-09-01T10:00:00Z", lines: [BUY] };

  it("a return already credited on an invoice keeps the purchase even when its uuid sorts LAST", () => {
    const r1 = back("ffff-credited", 4, "2026-09-05T10:00:00Z"); // credited $100 on INV-A
    const r2 = back("0000-later", 2, "2026-09-20T10:00:00Z"); // a later return, uuid sorts first
    // Before: R2 took the whole $100 and was offered $50 on top of the $100 already credited.
    expect(credits([buy, r2, r1], new Set(["ffff-credited"]))).toEqual({ "0000-later": 0, "ffff-credited": 100 });
  });

  it("the claim wins over filing order: a credited return filed AFTER a pending one still spends first", () => {
    const pending = back("0000-pending", 2, "2026-09-02T10:00:00Z");
    const credited = back("ffff-credited", 4, "2026-09-10T10:00:00Z");
    expect(credits([buy, pending, credited], new Set(["ffff-credited"]))).toEqual({ "0000-pending": 0, "ffff-credited": 100 });
  });

  it("with nothing credited, the older return spends first whatever the uuids say, and the two never credit more than was billed", () => {
    const older = back("ffff-older", 3, "2026-09-05T10:00:00Z");
    const newer = back("0000-newer", 2, "2026-09-20T10:00:00Z");
    const got = credits([buy, newer, older]);
    expect(got).toEqual({ "0000-newer": 25, "ffff-older": 75 });
  });

  it("the card and the importer agree whatever order their queries returned the bills in", () => {
    const buy2: B = { id: "1111-buy", amount: "50", created_at: "2026-09-02T10:00:00Z", lines: [{ ...BUY, id: "p2", quantity: "2", amount: "50" }] };
    const r = back("aaaa-ret", 5, "2026-09-05T10:00:00Z");
    const r2 = back("bbbb-ret", 2, "2026-09-06T10:00:00Z");
    const a = credits([buy, buy2, r, r2]);
    const b = credits([r2, buy2, r, buy]);
    expect(a).toEqual(b);
    expect(a["aaaa-ret"] + a["bbbb-ret"]).toBe(150); // 6 housings billed $150 in all; 7 went back
  });

  it("two returns filed in one statement (one timestamp) fall back to the bill id, so the order is still fixed", () => {
    const at = "2026-09-24T23:10:19.210Z";
    const x = back("aaaa", 3, at);
    const y = back("bbbb", 3, at);
    expect(credits([buy, y, x])).toEqual({ aaaa: 75, bbbb: 25 });
    expect(credits([buy, x, y])).toEqual({ aaaa: 75, bbbb: 25 });
  });
});

describe("returnsThatFit — a credit never takes an invoice below zero", () => {
  it("lands a return the invoice bills more than, and holds one it does not", () => {
    const a = { billId: "a", credit: 40 };
    const b = { billId: "b", credit: 70 };
    expect(returnsThatFit(100, [a, b])).toEqual({ land: [a], held: [b] });
  });
  it("a credit exactly the size of the invoice lands (the invoice reads $0, nothing lost)", () => {
    const a = { billId: "a", credit: 59.32 };
    expect(returnsThatFit(59.32, [a])).toEqual({ land: [a], held: [] });
  });
  it("an empty invoice holds every credit, and a net charge always fits", () => {
    const a = { billId: "a", credit: 0.01 };
    const fee = { billId: "f", credit: -5 };
    expect(returnsThatFit(0, [a, fee])).toEqual({ land: [fee], held: [a] });
  });
});
