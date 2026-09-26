import { describe, it, expect, vi, beforeEach } from "vitest";

const reported: string[] = [];
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void reported.push(where) }));

import { readPriceBookUnits } from "@/lib/price-book-kind";

/** A price_list_items read answering `answer` (or throwing it). */
const db = (answer: { data: unknown; error: unknown } | Error) => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: () => b,
    not: () => b,
    limit: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  };
  return b;
};

beforeEach(() => {
  reported.length = 0;
});

describe("readPriceBookUnits: a lost book is an empty book, and it is said (audit v1018 money-5)", () => {
  it("reads the book", async () => {
    const book = await readPriceBookUnits(db({ data: [{ code: "TM870LA", unit: "ea", supplier: "CED" }], error: null }), "org");
    expect(book.size).toBe(1);
    expect(reported).toEqual([]);
  });

  it("an error answer: empty, and logged", async () => {
    const book = await readPriceBookUnits(db({ data: null, error: { message: "statement timeout" } }), "org");
    expect(book.size).toBe(0);
    expect(reported).toEqual(["readPriceBookUnits"]);
  });

  it("a thrown read: empty, and logged", async () => {
    const book = await readPriceBookUnits(db(new Error("fetch failed")), "org");
    expect(book.size).toBe(0);
    expect(reported).toEqual(["readPriceBookUnits"]);
  });

  it("no org: nothing read, nothing to report", async () => {
    expect((await readPriceBookUnits(db({ data: [], error: null }), null)).size).toBe(0);
    expect(reported).toEqual([]);
  });
});
