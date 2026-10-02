import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchingKeys, moneyWords, searchBills, wordsOf, type BillsSearchRow } from "./bills-search";

/**
 * ONE SEARCHABLE LIST (W1-32). The box at the top of /bills filters All Bills in place: every word
 * typed has to be on the row (number, street, job, supplier, bucket, $), and "business cost" or
 * "fuel" keeps just those. A supplier's own paper is not in the list: it stays a hit that lands on
 * its card. Made-up rows only.
 */
const row = (key: string, kind: BillsSearchRow["kind"], ...words: unknown[]): BillsSearchRow => ({
  key,
  kind,
  title: key,
  sub: "",
  words: wordsOf(...words),
  href: null,
});

const ROWS: BillsSearchRow[] = [
  row("bill:gas", "bill", "Corner Gas", moneyWords(64.1), "2026-09-10", "business cost", "Fuel", "settled paid"),
  row("bill:phone", "bill", "Phone Company", moneyWords(120), "business cost", "Phone & Office", "settled paid"),
  row("bill:ticket", "bill", "8802-1107820", "Supply House", moneyWords(187.64), "on account unpaid", "J-028", "41 Larkspur Place"),
  row("po:1", "po", "po purchase order", "PO-001", "Supply House", moneyWords(412.5), "draft", "13897 Honeysuckle"),
  row("file:1", "file", "file", "IMG_0412.jpg", "Receipt", "13897 Honeysuckle"),
];

describe("what All Bills keeps for a query", () => {
  it("nothing typed, or one character: no filter (never an empty list for a half-typed word)", () => {
    expect(matchingKeys(ROWS, "")).toBeNull();
    expect(matchingKeys(ROWS, " 8 ")).toBeNull();
  });

  it("typing business cost keeps the business costs; typing fuel keeps the Fuel bucket", () => {
    expect([...matchingKeys(ROWS, "business cost")!]).toEqual(["bill:gas", "bill:phone"]);
    expect([...matchingKeys(ROWS, "fuel")!]).toEqual(["bill:gas"]);
  });

  it("by number, street, job, supplier or money, every word on the row", () => {
    expect([...matchingKeys(ROWS, "1107820")!]).toEqual(["bill:ticket"]);
    expect([...matchingKeys(ROWS, "larkspur")!]).toEqual(["bill:ticket"]);
    expect([...matchingKeys(ROWS, "honeysuckle")!]).toEqual(["po:1", "file:1"]);
    expect([...matchingKeys(ROWS, "supply house 412")!]).toEqual(["po:1"]);
    expect([...matchingKeys(ROWS, "$187.64")!]).toEqual(["bill:ticket"]);
    expect([...matchingKeys(ROWS, "unpaid")!]).toEqual(["bill:ticket"]);
    expect([...matchingKeys(ROWS, "purchase order")!]).toEqual(["po:1"]);
    expect(matchingKeys(ROWS, "nothing like it")!.size).toBe(0);
  });

  it("the dropdown's hits are the supplier's own papers only (they live on their cards)", () => {
    const paper = row("paper:1", "paper", "8802-1107820", "41 LARKSPUR");
    expect(searchBills([...ROWS, paper].filter((r) => r.kind === "paper"), "1107820").hits.map((h) => h.key)).toEqual(["paper:1"]);
  });

  it("the page gives a bill with no job its business-cost words (or shop stock), and every order a row", () => {
    const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    expect(PAGE).toContain('const kindWords = b.job_id ? [] : isShelfTicket(b) ? ["shop stock"] : ["business cost", bucketOf(b.category)];');
    expect(PAGE).toContain('key: `po:${p.id}`,');
    expect(PAGE).toContain("for (const f of looseDocs as any[]) {");
  });
});
