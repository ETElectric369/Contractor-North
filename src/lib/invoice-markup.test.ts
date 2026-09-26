import { describe, it, expect } from "vitest";
import {
  markupBoxApplied,
  markupBoxOnSeed,
  markupBoxSeed,
  markupBoxStart,
  markupBoxTyped,
  markupBoxWords,
  markupOnInvoice,
  markupReading,
  materialsImportPlan,
  type InvoiceCostLine,
} from "./invoice-markup";
import { billItemisation, type BillLine } from "./bill-itemisation";

/** INV-078's untouched CED bills on 2026-09-24: $199.48 → $229.40, $150.27 → $172.81, $103.99 →
 *  $119.59 - every one at 15.00% (read from Erik's database). */
const BILLS = [
  { id: "b-1", amount: "199.48" },
  { id: "b-2", amount: "150.27" },
  { id: "b-3", amount: "103.99" },
];
const line = (billId: string, total: number, extra: Partial<InvoiceCostLine> = {}): InvoiceCostLine => ({
  import_key: `bill:${billId}`,
  source_ids: [billId],
  line_total: total,
  edited: false,
  ...extra,
});
const base = { dismissed: new Set<string>(), bills: BILLS, linesByBill: new Map(), pos: [] as { id: string; total: unknown }[] };

describe("markupOnInvoice — the invoice's lines say what markup they were priced at", () => {
  it("INV-078: 15%", () => {
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 229.4), line("b-2", 172.81), line("b-3", 119.59)] })).toBe(15);
  });

  it("after the % box was set to 20", () => {
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 239.38), line("b-2", 180.32), line("b-3", 124.79)] })).toBe(20);
  });

  it("an edited bill, a deleted row, or a return has no vote", () => {
    const lines = [line("b-1", 229.4), line("b-2", 999, { edited: true }), line("b-3", 1)];
    expect(markupOnInvoice({ ...base, dismissed: new Set(["bill:b-3:remainder"]), lines })).toBe(15);
    expect(markupOnInvoice({ ...base, bills: [...BILLS, { id: "r-1", amount: "-40" }], lines: [line("b-1", 229.4), line("r-1", -46)] })).toBe(15);
  });

  it("bills priced at two different markups have no single answer", () => {
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 229.4), line("b-2", 180.32)] })).toBeNull();
  });

  it("nothing to read it from → null (the caller's markup applies)", () => {
    expect(markupOnInvoice({ ...base, lines: [] })).toBeNull();
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 229.4, { edited: true })] })).toBeNull();
  });

  it("a PO line reads its total", () => {
    expect(markupOnInvoice({ ...base, bills: [], pos: [{ id: "po-1", total: 500 }], lines: [{ import_key: "po:po-1", source_ids: ["po-1"], line_total: 625, edited: false }] })).toBe(25);
  });
});

describe("markupReading — takes from stock vote too (Shop Stock, Phase 3)", () => {
  const take = (group: string, moveIds: string[], cost: number) => ({ group, moveIds, cost });
  const stockLine = (group: string, moveIds: string[], total: number, extra: Partial<InvoiceCostLine> = {}): InvoiceCostLine => ({
    import_key: `stock:${group}`,
    source_ids: moveIds,
    line_total: total,
    edited: false,
    ...extra,
  });
  const takes = [take("g1", ["m1"], 43.24), take("g2", ["m2", "m3"], 100)];

  it("a stock-only invoice at 11% reads 11, not none (so a refresh at the usual 15 keeps it)", () => {
    const lines = [stockLine("g1", ["m1"], 48.0), stockLine("g2", ["m3", "m2"], 111)];
    expect(markupReading({ ...base, bills: [], lines, takes })).toEqual({ kind: "one", pct: 11 });
    // Without the takes, nothing votes: the old reading, and the trap.
    expect(markupReading({ ...base, bills: [], lines })).toEqual({ kind: "none" });
  });

  it("an edited or deleted stock line, or one that no longer bills the take whole, has no vote", () => {
    const edited = [stockLine("g1", ["m1"], 99, { edited: true }), stockLine("g2", ["m2", "m3"], 111)];
    expect(markupReading({ ...base, bills: [], lines: edited, takes })).toEqual({ kind: "one", pct: 11 });
    const tomb = [stockLine("g1", ["m1"], 99), stockLine("g2", ["m2", "m3"], 111)];
    expect(markupReading({ ...base, bills: [], dismissed: new Set(["stock:g1"]), lines: tomb, takes })).toEqual({ kind: "one", pct: 11 });
    const changed = [stockLine("g1", ["m1"], 48.0), stockLine("g2", ["m2"], 999)];
    expect(markupReading({ ...base, bills: [], lines: changed, takes })).toEqual({ kind: "one", pct: 11 });
  });

  it("stock lines and bills at different markups are mixed, not one answer", () => {
    const lines = [line("b-1", 229.4), stockLine("g2", ["m2", "m3"], 111)];
    expect(markupReading({ ...base, lines, takes })).toEqual({ kind: "mixed" });
  });
});

describe("markupReading — one answer, disagreeing lines, or nothing to read", () => {
  it("tells mixed apart from nothing", () => {
    expect(markupReading({ ...base, lines: [line("b-1", 229.4), line("b-2", 172.81), line("b-3", 119.59)] })).toEqual({ kind: "one", pct: 15 });
    expect(markupReading({ ...base, lines: [line("b-1", 229.4), line("b-2", 180.32)] })).toEqual({ kind: "mixed" });
    expect(markupReading({ ...base, lines: [] })).toEqual({ kind: "none" });
  });
});

describe("the % box's seed and words (Erik 2026-09-25: '11% ... but the marker still shows 15')", () => {
  it("lines at one markup: the box starts there, and names the customer's usual only because it differs", () => {
    const seed = markupBoxSeed({ kind: "one", pct: 11 }, 15);
    expect(seed).toEqual({ pct: 11, source: "invoice", usualPct: 15 });
    expect(markupBoxWords(seed, "Andrew Cohen")).toEqual({ main: "Priced at 11%", usual: "Andrew Cohen's usual is 15%" });
    // No pricing level: the usual is the org's default, not the customer's.
    expect(markupBoxWords(seed, null)).toEqual({ main: "Priced at 11%", usual: "Your default is 15%" });
    // At the usual (numeric arrives as "15.00" from some reads): nothing secondary to say.
    expect(markupBoxWords(markupBoxSeed({ kind: "one", pct: 15 }, "15.00"), "Andrew Cohen")).toEqual({ main: "Priced at 15%", usual: null });
  });

  it("a fresh invoice (no materials lines) starts at the customer's level, claiming nothing about lines", () => {
    const seed = markupBoxSeed(null, 15);
    expect(seed).toEqual({ pct: 15, source: "usual", usualPct: 15 });
    expect(markupBoxWords(seed, "Andrew Cohen")).toEqual({ main: null, usual: null });
    expect(markupBoxSeed({ kind: "none" }, 15).pct).toBe(15);
  });

  it("lines at different markups: says so, and starts at the customer's level", () => {
    const seed = markupBoxSeed({ kind: "mixed" }, 15);
    expect(seed).toEqual({ pct: 15, source: "mixed", usualPct: 15 });
    expect(markupBoxWords(seed, "Andrew Cohen").main).toBe("Lines are at different markups");
  });

  it("a failed read is said as a failed read, never as 'no lines'", () => {
    const seed = markupBoxSeed("unread", 15);
    expect(seed.source).toBe("unread");
    expect(markupBoxWords(seed, null).main).toMatch(/Couldn't read/);
  });
});

describe("the % box's state: opening the page never reprices, a refresh never undoes what was applied", () => {
  const at11 = markupBoxSeed({ kind: "one", pct: 11 }, 15);

  it("starts with the applied figure equal to the seed, so nothing is 'typed' on load", () => {
    const box = markupBoxStart(at11);
    expect(box).toEqual({ value: 11, applied: 11, appliedHere: false });
    expect(markupBoxTyped(box)).toBe(false);
  });

  it("the server's new reading is taken when nothing is typed", () => {
    expect(markupBoxOnSeed(markupBoxStart(at11), markupBoxSeed({ kind: "one", pct: 20 }, 15))).toEqual({ value: 20, applied: 20, appliedHere: false });
  });

  it("never over what the person is typing", () => {
    const typing = { ...markupBoxStart(at11), value: 18 };
    expect(markupBoxOnSeed(typing, markupBoxSeed({ kind: "one", pct: 20 }, 15))).toBe(typing);
  });

  it("after an apply the box keeps the number just applied, even when the re-read has no one answer", () => {
    const applied = markupBoxApplied({ ...markupBoxStart(at11), value: 20 }, 20);
    expect(applied).toEqual({ value: 20, applied: 20, appliedHere: true });
    expect(markupBoxTyped(applied)).toBe(false);
    // Every line edited since, or bills that disagree: the re-read falls back to the usual 15 -
    // not what the invoice is at, so it does not overwrite the 20 just applied.
    expect(markupBoxOnSeed(applied, markupBoxSeed({ kind: "none" }, 15))).toBe(applied);
    expect(markupBoxOnSeed(applied, markupBoxSeed({ kind: "mixed" }, 15))).toBe(applied);
    // A real reading is still taken.
    expect(markupBoxOnSeed(applied, markupBoxSeed({ kind: "one", pct: 20 }, 15)).value).toBe(20);
  });

  it("typing again while an import ran stays typed", () => {
    const typedAgain = markupBoxApplied({ value: 25, applied: 11, appliedHere: false }, 20);
    expect(typedAgain).toEqual({ value: 25, applied: 20, appliedHere: true });
    expect(markupBoxTyped(typedAgain)).toBe(true);
  });
});

describe("a receipt that changed after its lines were written is not read as a markup (review of this branch)", () => {
  // One $100 receipt: $80 of wire and $20 of snacks, imported at 11% as $88.80 and $22.20.
  const receipt: BillLine[] = [
    { id: "wire", amount: 80, quantity: 1, category: "Electrical" },
    { id: "snacks", amount: 20, quantity: 1, category: "Electrical" },
  ];
  const imported = billItemisation({ id: "b-1", amount: 100 }, receipt, 11).map(
    (r): InvoiceCostLine => ({ import_key: r.import_key, source_ids: ["b-1"], line_total: r.quantity * r.unit_price, edited: false }),
  );
  const oneBill = (amount: unknown, lines: BillLine[]) => ({
    lines: imported,
    dismissed: new Set<string>(),
    bills: [{ id: "b-1", amount }],
    linesByBill: new Map([["b-1", lines]]),
    pos: [] as { id: string; total: unknown }[],
  });

  it("as imported: 11", () => {
    expect(markupReading(oneBill(100, receipt))).toEqual({ kind: "one", pct: 11 });
  });

  it("the snacks switched off after the import: no reading, so the box never seeds 38.7 and re-bills them", () => {
    const reading = markupReading(oneBill(100, [receipt[0], { ...receipt[1], billable: false }]));
    expect(reading).toEqual({ kind: "none" });
    const seed = markupBoxSeed(reading, 15);
    expect(seed.pct).not.toBe(38.7);
    expect(seed.source).toBe("usual");
  });

  it("a supplier credit off the bill's amount after the import: no reading", () => {
    expect(markupReading(oneBill(90, receipt))).toEqual({ kind: "none" });
  });

  it("beside bills that did not change, the changed one drops out and the rest still say 11", () => {
    const other: BillLine[] = [{ id: "o1", amount: 150, quantity: 1, category: "Electrical" }];
    const otherRows = billItemisation({ id: "b-2", amount: 150 }, other, 11).map(
      (r): InvoiceCostLine => ({ import_key: r.import_key, source_ids: ["b-2"], line_total: r.quantity * r.unit_price, edited: false }),
    );
    expect(
      markupReading({
        lines: [...imported, ...otherRows],
        dismissed: new Set(),
        bills: [{ id: "b-1", amount: 100 }, { id: "b-2", amount: 150 }],
        linesByBill: new Map([["b-1", [receipt[0], { ...receipt[1], billable: false }]], ["b-2", other]]),
        pos: [],
      }),
    ).toEqual({ kind: "one", pct: 11 });
  });

  it("a lump bill whose amount grew reads below zero: that is no markup, never a seed", () => {
    const reading = markupReading({ ...base, lines: [line("b-1", 110)], bills: [{ id: "b-1", amount: 120 }] });
    expect(reading).toEqual({ kind: "mixed" });
    expect(markupBoxSeed(reading, 15).pct).toBe(15);
  });
});

describe("what Materials from Costs sends (review of this branch)", () => {
  it("a failed read: the usual is never sent as a decision - the import keeps the lines' markup or refuses", () => {
    const seed = markupBoxSeed("unread", 15);
    const plan = materialsImportPlan(markupBoxStart(seed), seed);
    expect(plan.pct).toBe(15);
    expect(plan.keepInvoiceMarkup).toBe(true);
    expect(plan.confirmNote).toMatch(/couldn't read/);
    expect(plan.rebuildNote).toMatch(/rebuilt at 15%.*check that figure/);
  });

  it("lines at different markups: keeps what it can, and the confirm names the percent the rest land at", () => {
    const seed = markupBoxSeed({ kind: "mixed" }, 15);
    const plan = materialsImportPlan(markupBoxStart(seed), seed);
    expect(plan.keepInvoiceMarkup).toBe(true);
    expect(plan.confirmNote).toBe("Lines are at different markups - this prices every untouched materials line at 15%.");
  });

  it("INV-078 at 11%, nothing typed: 11, kept", () => {
    const seed = markupBoxSeed({ kind: "one", pct: 11 }, 15);
    const plan = materialsImportPlan(markupBoxStart(seed), seed);
    expect(plan).toMatchObject({ pct: 11, keepInvoiceMarkup: true });
    expect(plan.confirmNote).toMatch(/stay at 11%/);
  });

  it("a number the person typed is the one decision sent as-is", () => {
    const seed = markupBoxSeed("unread", 15);
    const plan = materialsImportPlan({ ...markupBoxStart(seed), value: 11 }, seed);
    expect(plan).toMatchObject({ pct: 11, keepInvoiceMarkup: false });
    expect(plan.confirmNote).toMatch(/repriced at 11%, the markup you typed/);
  });
});
