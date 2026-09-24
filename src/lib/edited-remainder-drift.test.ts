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
