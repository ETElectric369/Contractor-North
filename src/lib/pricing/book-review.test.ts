import { describe, it, expect } from "vitest";
import { reviewAgainstBook, type BookRowLite } from "./book-review";

const BOOK: BookRowLite[] = [
  { id: "1", code: "QO120", description: "20A single-pole breaker (QO120)", unit: "ea", buy_price: 11.95 },
  { id: "2", code: null, description: "3/4in EMT conduit, 10ft stick", unit: "ea", buy_price: 8.4 },
  { id: "3", code: "E-231", description: "200A load center, 40/60-circuit", unit: "ea", buy_price: 389.0 },
];

const line = (description: string, net: number, unit = "ea") => ({ description, quantity: 1, unit, net });

describe("reviewAgainstBook — conservative on purpose", () => {
  it("matches by CODE first, and reports the price move", () => {
    const r = reviewAgainstBook(BOOK, [line("QO120 20A 1-pole breaker", 12.4)]);
    expect(r.updates).toEqual([
      { itemId: "1", code: "QO120", description: "20A single-pole breaker (QO120)", oldBuy: 11.95, newBuy: 12.4, matchedBy: "code", oldUnit: expect.anything(), newUnit: expect.anything(), unitMismatch: false },
    ]);
    expect(r.additions).toEqual([]);
  });

  it("matches by exact normalized description when there is no code", () => {
    const r = reviewAgainstBook(BOOK, [line("3/4in EMT conduit 10ft stick", 9.1)]);
    expect(r.updates[0]).toMatchObject({ itemId: "2", oldBuy: 8.4, newBuy: 9.1, matchedBy: "description", oldUnit: expect.anything(), newUnit: expect.anything(), unitMismatch: false });
  });

  it("an identical price is unchanged, not an update", () => {
    const r = reviewAgainstBook(BOOK, [line("QO120 breaker", 11.95)]);
    expect(r.updates).toEqual([]);
    expect(r.unchanged).toBe(1);
  });

  it("NO FUZZY RUNG — a near-miss is an addition a human declines, never a corrupted book row", () => {
    // "Matched loosely" is fine for pricing one estimate line; here it would silently corrupt the
    // book itself, which is the price-list-import-damage class all over again.
    const r = reviewAgainstBook(BOOK, [line("200 amp load centre 40 circuit", 401)]);
    expect(r.updates).toEqual([]);
    expect(r.additions).toHaveLength(1);
  });

  it("a genuinely new product lands in additions with its unit and net", () => {
    const r = reviewAgainstBook(BOOK, [line("AFCI/GFCI dual-function breaker 20A", 43.2, "ea")]);
    expect(r.additions).toEqual([{ description: "AFCI/GFCI dual-function breaker 20A", unit: "ea", newBuy: 43.2 }]);
  });

  it("two quote lines cannot both update one book row — the second becomes an addition", () => {
    const r = reviewAgainstBook(BOOK, [line("QO120 breaker", 12.1), line("QO120 breaker bulk", 11.2)]);
    expect(r.updates).toHaveLength(1);
    expect(r.additions).toHaveLength(1);
  });

  it("zero-net and blank lines are skipped — a freight or note row must never become a product", () => {
    const r = reviewAgainstBook(BOOK, [line("", 5), line("Freight", 0)]);
    expect(r.updates).toEqual([]);
    expect(r.additions).toEqual([]);
  });

  it("two book rows sharing one description: first wins, and only once — the org's own ambiguity is not guessed at", () => {
    const dup: BookRowLite[] = [
      { id: "a", code: null, description: "Wire staple", unit: "box", buy_price: 3 },
      { id: "b", code: null, description: "Wire staple", unit: "box", buy_price: 4 },
    ];
    const r = reviewAgainstBook(dup, [line("Wire staple", 3.5)]);
    expect(r.updates).toEqual([
      { itemId: "a", code: null, description: "Wire staple", oldBuy: 3, newBuy: 3.5, matchedBy: "description", oldUnit: expect.anything(), newUnit: expect.anything(), unitMismatch: true },
    ]);
  });
});

describe("book-review — audit 7: ratings are not part numbers", () => {
  it("a leading size/rating token never claims a book row that happens to use it as a code", () => {
    const book: BookRowLite[] = [{ id: "x", code: "20A", description: "20A 1-pole breaker", unit: "ea", buy_price: 11.95 }];
    const r = reviewAgainstBook(book, [line("20A GFCI RECEPTACLE WR TR", 18.4)]);
    expect(r.updates).toEqual([]);
    expect(r.additions).toHaveLength(1);
  });
  it("a bracketed token is an explicit part number and still matches", () => {
    const book: BookRowLite[] = [{ id: "x", code: "20A", description: "weird code row", unit: "ea", buy_price: 5 }];
    const r = reviewAgainstBook(book, [line("thing [20A]", 6)]);
    expect(r.updates).toHaveLength(1);
  });
});

describe("reviewAgainstBook — units are compared, never converted (v800 audit)", () => {
  // A supplier prints the COIL net for a part the book prices per FOOT. Matching on the code
  // alone and comparing only money proposed "$0.75 → $187.50" — a 250x corruption of the price
  // book, on a card that showed no units at all. We flag it; we never guess what a coil holds.
  it("flags a per-coil net landing on a per-foot book row", () => {
    const book = [{ id: "1", code: "NMB12/2X250", description: "NMB 12/2 W/GND (250' COIL)", unit: "ft", buy_price: 0.75 }];
    const lines = [{ description: "NMB 12/2 W/GND (250' COIL)", quantity: 1, unit: "coil", net: 187.5 }];
    const r = reviewAgainstBook(book, lines);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].unitMismatch).toBe(true);
    expect(r.updates[0].oldUnit).toBe("ft");
    expect(r.updates[0].newUnit).toBe("coil");
    // the price is reported as-is — no conversion is attempted
    expect(r.updates[0].oldBuy).toBe(0.75);
    expect(r.updates[0].newBuy).toBe(187.5);
  });

  it("same unit, real price move: no mismatch flag", () => {
    const book = [{ id: "1", code: "QO120", description: "20A breaker", unit: "ea", buy_price: 11.0 }];
    const lines = [{ description: "20A breaker", quantity: 1, unit: "ea", net: 12.4 }];
    const r = reviewAgainstBook(book, lines);
    expect(r.updates[0].unitMismatch).toBe(false);
  });
});
