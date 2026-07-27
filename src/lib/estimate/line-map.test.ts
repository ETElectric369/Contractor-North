import { describe, it, expect } from "vitest";
import { mapEstimatorLine, type BookRow, type LineMapContext } from "./line-map";

const book = (rows: Array<BookRow & { code: string }>): Map<string, BookRow> =>
  new Map(rows.map((r) => [r.code.toUpperCase(), r]));

const ctx = (over: Partial<LineMapContext> = {}): LineMapContext => ({
  rate: 125,
  byCode: book([
    { code: "THHN12", description: "#12 THHN", buy_price: 180, markup_pct: 0, unit: "roll" },
    { code: "4SBOX", description: "4S box", buy_price: 3.2, markup_pct: 10, unit: "ea" },
  ]),
  levelPct: null,
  orgDefaultPct: 0,
  ...over,
});

/**
 * THE HARM: an estimate is the number a contractor commits to in front of a customer. A line that
 * is quietly wrong in the customer's favour is money out of his pocket that he never sees leave,
 * because nobody audits an invoice that came in low.
 */
describe("labor is priced from the rate card, not the model's echo", () => {
  it("a hallucinated hourly does NOT override the company rate", () => {
    const l = mapEstimatorLine({ kind: "labor", description: "Rough-in", quantity: 8, unit_cost: 95 }, ctx());
    expect(l.unit_price).toBe(125);
    expect(l.flag).toBeUndefined();
  });

  it("the customer's pricing level still wins, because that's what `rate` already resolved to", () => {
    const l = mapEstimatorLine({ kind: "labor", quantity: 4, unit_cost: 95 }, ctx({ rate: 145 }));
    expect(l.unit_price).toBe(145);
  });

  it("with no rate configured the echo is used but FLAGGED, never presented as the company's rate", () => {
    const l = mapEstimatorLine({ kind: "labor", quantity: 4, unit_cost: 95 }, ctx({ rate: 0 }));
    expect(l.unit_price).toBe(95);
    expect(l.flag).toMatch(/no company labor rate/i);
  });

  it("labor is always billed in hours no matter what unit the model returned", () => {
    const l = mapEstimatorLine({ kind: "labor", quantity: 6, unit: "lot", unit_cost: 95 }, ctx());
    expect(l.unit).toBe("hr");
  });

  it("hours DO come from the model — that's the part it's actually for", () => {
    expect(mapEstimatorLine({ kind: "labor", quantity: 12 }, ctx()).quantity).toBe(12);
  });
});

describe("the price book's unit governs", () => {
  it("book-vs-model unit mismatch is flagged, not silently multiplied", () => {
    // The roll-vs-foot bug: book sells #12 THHN at $180 per ROLL, the model says 250 "ft".
    // Trusting either side alone gives a $45,000 wire line on a house.
    const l = mapEstimatorLine(
      { kind: "material", description: "#12 THHN", catalog: "THHN12", quantity: 250, unit: "ft", unit_cost: 0.36 },
      ctx(),
    );
    expect(l.unit).toBe("roll");
    expect(l.flag).toMatch(/priced per roll/i);
    expect(l.flag).toMatch(/given in ft/i);
  });

  it("matching units produce no flag", () => {
    const l = mapEstimatorLine({ kind: "material", catalog: "4SBOX", quantity: 12, unit: "ea" }, ctx());
    expect(l.unit).toBe("ea");
    expect(l.flag).toBeUndefined();
  });

  it("case and whitespace don't count as a mismatch", () => {
    const l = mapEstimatorLine({ kind: "material", catalog: "4SBOX", quantity: 12, unit: " EA " }, ctx());
    expect(l.flag).toBeUndefined();
  });

  it("book price wins over the model's cost, and carries the item markup", () => {
    const l = mapEstimatorLine({ kind: "material", catalog: "4SBOX", quantity: 12, unit: "ea", unit_cost: 99 }, ctx());
    expect(l.unit_price).toBe(3.52); // 3.20 + 10%
  });

  it("an off-book line uses the model's cost and is flagged for confirmation", () => {
    const l = mapEstimatorLine(
      { kind: "material", description: "Weatherhead", quantity: 1, unit: "ea", unit_cost: 42 },
      ctx({ orgDefaultPct: 25 }),
    );
    expect(l.unit_price).toBe(52.5);
    expect(l.flag).toMatch(/home depot/i);
  });

  it("book items carry their [CODE] so the supply-house order sheet resolves them", () => {
    const l = mapEstimatorLine({ kind: "material", description: "4S box", catalog: "4sbox", quantity: 2 }, ctx());
    expect(l.description).toBe("4S box [4SBOX]");
  });

  it("an unknown catalog code degrades to an off-book line rather than pricing at zero", () => {
    const l = mapEstimatorLine(
      { kind: "material", description: "Mystery part", catalog: "NOPE", quantity: 1, unit_cost: 10 },
      ctx(),
    );
    expect(l.unit_price).toBe(10);
    expect(l.flag).toMatch(/home depot/i);
  });
});

describe("junk from the model never becomes a silent zero-dollar line", () => {
  it("missing quantity defaults to 1, not 0", () => {
    expect(mapEstimatorLine({ kind: "material", catalog: "4SBOX" }, ctx()).quantity).toBe(1);
  });
  it("a non-numeric quantity defaults to 1", () => {
    expect(mapEstimatorLine({ kind: "material", catalog: "4SBOX", quantity: "twelve" }, ctx()).quantity).toBe(1);
  });
  it("anything not labelled labor is treated as material", () => {
    const l = mapEstimatorLine({ kind: "widget", description: "x", quantity: 1, unit_cost: 5 }, ctx());
    expect(l.unit).not.toBe("hr");
  });
});
