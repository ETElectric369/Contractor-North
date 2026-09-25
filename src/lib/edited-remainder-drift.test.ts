import { describe, it, expect } from "vitest";
import { billItemisation, editedRemainderDrift, editedRemainderSentence, remainderKey, type BillLine } from "@/lib/bill-itemisation";

/**
 * INV-074, Kathy Walker (1cca5d10). Erik took the supplier's name off the three "Supplies & tax"
 * rows by hand, which marks a row edited and freezes its AMOUNT as well as its words (0175). The
 * markup then went from 25% to 30%: the import re-priced the parts and left the three tax rows at
 * their 25% figures, and the bill went out 77 cents short under a toast that said only "3 of your
 * edits kept". The bills and lines below are his, out of the database.
 */

const SWIGARDS_1 = { id: "b-swig-1", supplier: "Swigard's", amount: 17.15 };
const CED = { id: "b-ced", supplier: "CED", amount: 147.92 };
const SWIGARDS_2 = { id: "b-swig-2", supplier: "Swigard's", amount: 27.43 };
const BILLS = [SWIGARDS_1, CED, SWIGARDS_2];
const LINES: Record<string, BillLine[]> = {
  [SWIGARDS_1.id]: [
    { id: "flex", description: "Duct Flex", quantity: 1, amount: 15.99, category: "Materials" },
    { id: "t1", description: "Sales Tax", quantity: 1, amount: 1.16, category: "Sales Tax" },
  ],
  [CED.id]: [
    { id: "fan", description: "PANIS fan", quantity: 1, amount: 135.71, category: "Materials" },
    { id: "t2", description: "Sales Tax", quantity: 1, amount: 12.21, category: "Sales Tax" },
  ],
  [SWIGARDS_2.id]: [
    { id: "timer", description: "Timer", quantity: 1, amount: 23.99, category: "Materials" },
    { id: "plate", description: "Wallplate", quantity: 1, amount: 1.59, category: "Materials" },
    { id: "t3", description: "Sales Tax", quantity: 1, amount: 1.85, category: "Sales Tax" },
  ],
};

/** What importCostsIntoInvoice hands the RPC at `markup`: every bill's rows, each claiming its bill. */
const offerAt = (markup: number) =>
  BILLS.flatMap((b) => billItemisation(b, LINES[b.id], markup).map((r) => ({ ...r, source_ids: [b.id] })));
const lineTotal = (r: { quantity: number; unit_price: number }) => Math.round(r.quantity * r.unit_price * 100) / 100;

/** The invoice after the 30% run: parts refreshed (not edited), tax rows frozen at 25% (edited). */
function inv074() {
  const at25 = offerAt(25);
  const at30 = offerAt(30);
  return [
    ...at30.filter((r) => !r.import_key.endsWith(":remainder")).map((r) => ({ import_key: r.import_key, line_total: lineTotal(r), edited: false })),
    ...at25.filter((r) => r.import_key.endsWith(":remainder")).map((r) => ({ import_key: r.import_key, line_total: lineTotal(r), edited: true })),
  ];
}

describe("editedRemainderDrift — the tax rows his markup change left behind", () => {
  it("the arithmetic is his: 1.45 / 15.26 / 2.31 at 25%, 1.51 / 15.88 / 2.40 at 30%", () => {
    const rem = (m: number) => offerAt(m).filter((r) => r.import_key.endsWith(":remainder")).map(lineTotal);
    expect(rem(25)).toEqual([1.45, 15.26, 2.31]);
    expect(rem(30)).toEqual([1.51, 15.88, 2.4]);
  });

  it("names all three bills with the figure billItemisation gives at the new markup", () => {
    const drift = editedRemainderDrift(BILLS, offerAt(30), inv074());
    expect(drift).toEqual([
      { billId: SWIGARDS_1.id, supplier: "Swigard's", kept: 1.45, computed: 1.51 },
      { billId: CED.id, supplier: "CED", kept: 15.26, computed: 15.88 },
      { billId: SWIGARDS_2.id, supplier: "Swigard's", kept: 2.31, computed: 2.4 },
    ]);
    // The 77 cents INV-074 went out short, accounted for row by row.
    expect(Math.round(drift.reduce((t, d) => t + (d.computed - d.kept), 0) * 100)).toBe(77);
  });

  it("says it the way the toast reads it", () => {
    const [first] = editedRemainderDrift(BILLS, offerAt(30), inv074());
    expect(editedRemainderSentence(first, 30)).toBe("Swigard's: your edited Supplies & tax row stayed at $1.45; at 30% it would be $1.51");
    expect(editedRemainderSentence(first, 27.5)).toContain("at 27.5% it would be");
    expect(editedRemainderSentence(first, 30)).not.toContain("—");
  });

  it("an edited row that still matches says nothing — his words, the right money", () => {
    const at30 = offerAt(30);
    const matched = at30.map((r) => ({ import_key: r.import_key, line_total: lineTotal(r), edited: r.import_key.endsWith(":remainder") }));
    expect(editedRemainderDrift(BILLS, at30, matched)).toEqual([]);
  });

  it("an UNEDITED tax row is the importer's to refresh, so there is nothing to say", () => {
    const rows = inv074().map((r) => ({ ...r, edited: false }));
    expect(editedRemainderDrift(BILLS, offerAt(30), rows)).toEqual([]);
  });

  it("a bill the office froze entirely is consistent at its own numbers — no nag", () => {
    // Every row of Swigard's #1 edited: the importer refreshed none of it.
    const rows = inv074().map((r) => (r.import_key === "bli:flex" ? { ...r, edited: true } : r));
    expect(editedRemainderDrift(BILLS, offerAt(30), rows).map((d) => d.billId)).toEqual([CED.id, SWIGARDS_2.id]);
  });

  it("a bill this run did not offer (another invoice holds it) is not this invoice's business", () => {
    const offered = offerAt(30).filter((r) => !(r.source_ids ?? []).includes(CED.id));
    expect(editedRemainderDrift(BILLS, offered, inv074()).map((d) => d.billId)).toEqual([SWIGARDS_1.id, SWIGARDS_2.id]);
  });

  it("a receipt whose new itemisation has no tax row says what the row would be: nothing", () => {
    const offered = offerAt(30).filter((r) => r.import_key !== remainderKey(CED.id));
    const d = editedRemainderDrift([CED], offered, inv074());
    expect(d).toEqual([{ billId: CED.id, supplier: "CED", kept: 15.26, computed: 0 }]);
  });

  it("uses billItemisation's own key, so the two can never spell it differently", () => {
    expect(billItemisation(CED, LINES[CED.id], 30).some((r) => r.import_key === remainderKey(CED.id))).toBe(true);
  });
});

/**
 * THE WALDOW BOX ON PAID INV-069 (Shop Stock plan, Phase 4's cleanup, tested in Phase 1).
 *
 * Bill c0535cdb, $653.25 of CED on J-046, is claimed by eight lines of INV-069, which Jason has
 * paid. Erik typed the Twister row down to 60 nuts at 27 cents by hand (edited), and the invoice's
 * "Supplies & tax" row was never touched. The cleanup sets the Twister line's billed_amount to the
 * 60 nuts so the receipt agrees with the paper he already sent, and the other 440 go on the shelf.
 * That must not wake a drift banner on the paid invoice: its remainder row is not an edited row,
 * so there is nothing of his to be left behind, whatever the itemisation now says.
 */
describe("editedRemainderDrift: fixing the Waldow line stays quiet on paid INV-069", () => {
  const WALDOW = { id: "c0535cdb-e485-4679-8e56-fd0918fd728b", supplier: "Contractors Electrical Distributors", amount: 653.25 };
  const lines = (twisterBilled: number | null): BillLine[] => [
    { id: "90cf614c", description: "ITE PN1632L1125C 125A Plug On Neutral Load Center", quantity: 1, amount: 119.26, category: "Electrical" },
    { id: "374b0d23", description: "3M 33+SUPER3/4X76FT 3/4 x 76 33+ Super Vinyl Tape", quantity: 2, amount: 20.6, category: "Electrical" },
    { id: "24bfd5db", description: "IDEAL 30641 500/5000 Twister 341-Tan", quantity: 500, amount: 77.39, category: "Electrical", billed_amount: twisterBilled },
    { id: "ox", description: "IDEAL 30030 8-Oz Anti Oxidant Comp", quantity: 1, amount: 2.95, category: "Electrical" },
    { id: "eb753e54", description: "SQD HOM120 Miniature Circuit", quantity: 3, amount: 23.13, category: "Electrical" },
    { id: "266c063c", description: "SQD HOMT1515 Miniature Circuit", quantity: 4, amount: 75.6, category: "Electrical" },
    { id: "1c3216e4", description: "SQD HOMT2020 Miniature Circuit", quantity: 4, amount: 75.6, category: "Electrical" },
    { id: "99fb20d5", description: "SQD HOMT230250 Miniature Ckt Brkr", quantity: 2, amount: 94.48, category: "Electrical" },
    { id: "wc", description: "WIRE CONNECTOR (30641J)", quantity: 500, amount: 104.85, category: "Electrical", billable: false },
    { id: "tx", description: "Sales Tax (Invoice 8802-1108330)", quantity: 1, amount: 59.39, category: "Tax" },
  ];
  /** INV-069's rows for this bill, as they sit in the books: the Twister row edited, the rest not. */
  const inv069 = [
    { import_key: "bli:90cf614c", line_total: 134.16, edited: false },
    { import_key: "bli:374b0d23", line_total: 20.6, edited: false },
    { import_key: "bli:24bfd5db", line_total: 16.2, edited: true },
    { import_key: "bli:eb753e54", line_total: 23.13, edited: false },
    { import_key: "bli:266c063c", line_total: 75.6, edited: false },
    { import_key: "bli:1c3216e4", line_total: 75.6, edited: false },
    { import_key: "bli:99fb20d5", line_total: 94.48, edited: false },
    { import_key: remainderKey(WALDOW.id), line_total: 0.46, edited: false },
  ];
  const offered = (twisterBilled: number | null) =>
    billItemisation(WALDOW, lines(twisterBilled), 25).map((r) => ({ ...r, source_ids: [WALDOW.id] }));

  it("says nothing before the fix, and nothing after it (60 of 500 nuts = $9.29 billed)", () => {
    expect(editedRemainderDrift([WALDOW], offered(null), inv069)).toEqual([]);
    expect(editedRemainderDrift([WALDOW], offered(9.29), inv069)).toEqual([]);
  });

  it("and says nothing on any other invoice, which is never offered a bill INV-069 holds", () => {
    expect(editedRemainderDrift([WALDOW], [], inv069)).toEqual([]);
  });
});
