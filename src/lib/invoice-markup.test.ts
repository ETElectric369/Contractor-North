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
  type InvoiceCostLine,
} from "./invoice-markup";

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
