import { describe, it, expect } from "vitest";
import { tableFromPositionedItems, tableReadsAsList, type PositionedItem } from "./pdf-table";
import { findHeaderRow, listReadFacts, pdfReadSaid, readHeaderRow, readOpenListTable } from "./supplier-open-list";
import { downloadReadFacts, readBankTable } from "./bank-download";

/**
 * THE PDF STATEMENT READS (2026-10-02). Erik: "i want to upload my bank statement and supplier
 * statement, every item will either match or need a category." These pin the geometry, because the
 * geometry is where a parsed PDF goes confidently wrong: a column found by its left x alone puts an
 * amount under the wrong heading, a dropped empty cell shifts every value after it, and an aging
 * footer read as a paper invents money.
 *
 * EVERY MARK HERE IS INVENTED. No PDF is opened, no real supplier, customer or account appears, and
 * the positions reproduce the SHAPE measured off real statements (page width 595, 9-point type, money
 * right-aligned, credits printed with a TRAILING minus) with made-up names and figures in it.
 */

const H = 9;
/** One text run: a monospace-ish statement face, about five points to the character. */
const CH = 5;
const run = (x: number, y: number, str: string, page = 0): PositionedItem => ({ str, x, y, width: str.length * CH, height: H, page });
/** Money is printed RIGHT-aligned, so it is placed by where it ENDS, never by where it starts. */
const money = (right: number, y: number, str: string, page = 0): PositionedItem => run(right - str.length * CH, y, str, page);

// ── THE LAYOUT, AS MEASURED ────────────────────────────────────────────────────────────────────
// header:   x25 AGE  x58 DATE  x97 CODE  x142 REFERENCE  x251 CUSTOMER PO#  x364 DISCOUNT
//           x420 OPEN AMOUNT  x502 ORIG AMOUNT
// a paper:  x29 age  x51 date  x105 code  x127 reference  x212 po  money ending at 496 and 577
// a credit: a TRAILING minus on the discount, the open amount and the original amount
// the foot: TOTAL DUE | CURRENT / 1 - 30 | PAST DUE 31 - 60 | PAST DUE 61 - 90 | PAST DUE Over 90,
//           then a row of five amounts right-aligned under those labels.

const HEADINGS: [number, string][] = [
  [25, "AGE"],
  [58, "DATE"],
  [97, "CODE"],
  [142, "REFERENCE"],
  [251, "CUSTOMER PO#"],
  [364, "DISCOUNT"],
  [420, "OPEN AMOUNT"],
  [502, "ORIG AMOUNT"],
];

type Paper = { age: string; date: string; code: string; reference: string; po: string; open: string; orig: string; discount?: string };

const PAPERS: Paper[] = [
  { age: "47", date: "08/12/26", code: "IN", reference: "7741-2203118", po: "3302 PINEBROOK", open: "412.90", orig: "412.90" },
  { age: "47", date: "08/12/26", code: "IN", reference: "7741-2203204", po: "3302 PINEBROOK", open: "88.15", orig: "88.15" },
  { age: "33", date: "08/26/26", code: "IN", reference: "7741-2206611", po: "3318 HARROWGATE", open: "1,204.66", orig: "1,204.66" },
  { age: "33", date: "08/26/26", code: "IN", reference: "7741-2206745", po: "3318 HARROWGATE", open: "275.40", orig: "275.40" },
  { age: "19", date: "09/09/26", code: "IN", reference: "7741-2209002", po: "3402 WESTMERE", open: "96.08", orig: "96.08" },
  { age: "19", date: "09/09/26", code: "SC", reference: "7741-2209051", po: "3402 WESTMERE", open: "14.22", orig: "14.22" },
  { age: "5", date: "09/23/26", code: "IN", reference: "7741-2211380", po: "3415 CALDERWOOD", open: "640.75", orig: "640.75" },
  { age: "5", date: "09/23/26", code: "IN", reference: "7741-2211412", po: "3415 CALDERWOOD", open: "52.31", orig: "52.31" },
  // A CREDIT, printed the way the paper prints it: a TRAILING minus, not a leading one.
  { age: "19", date: "09/11/26", code: "CRM", reference: "7741-2209914", po: "3402 WESTMERE", discount: "1.24-", open: "60.75-", orig: "60.75-" },
];

const FOOTER: [number, string][] = [
  [52, "TOTAL DUE"],
  [150, "CURRENT / 1 - 30"],
  [261, "PAST DUE 31 - 60"],
  [372, "PAST DUE 61 - 90"],
  [481, "PAST DUE Over 90"],
];
/** The paper's own aging footer: the four buckets add to the TOTAL DUE, and so do its nine papers. */
const FOOTER_AMOUNTS = ["2,723.72", "742.61", "1,480.06", "501.05", "0.00"];
const TOTAL_DUE = "$2,723.72";

/** One page of the statement: the title, the address block, the headings, its papers, the footer. */
function page(papers: readonly Paper[], n = 0, opts: { foot?: boolean; furniture?: boolean } = {}): PositionedItem[] {
  const out: PositionedItem[] = [];
  const furniture = opts.furniture !== false;
  if (furniture) {
    out.push(run(250, 780, "STATEMENT", n));
    out.push(run(25, 760, "NORTHGATE ELECTRIC SUPPLY", n));
    out.push(run(25, 748, "4120 HARROW ROAD", n));
    out.push(run(25, 736, "RIVERBEND CA 95605", n));
  }
  for (const [x, word] of HEADINGS) out.push(run(x, 700, word, n));
  papers.forEach((p, i) => {
    const y = 680 - i * 12;
    out.push(run(29, y, p.age, n), run(51, y, p.date, n), run(105, y, p.code, n), run(127, y, p.reference, n), run(212, y, p.po, n));
    if (p.discount) out.push(money(415, y, p.discount, n));
    out.push(money(496, y, p.open, n), money(577, y, p.orig, n));
  });
  if (opts.foot !== false) {
    // Clear of the last paper row: a statement prints its aging footer at the bottom of the page.
    const y = 680 - papers.length * 12 - 40;
    for (const [x, word] of FOOTER) out.push(run(x, y, word, n));
    FOOTER.forEach(([x, word], i) => out.push(money(x + word.length * CH, y - 12, FOOTER_AMOUNTS[i], n)));
  }
  return out;
}

const cellsAt = (table: string[][], at: number) => table.map((r) => r[at]).filter(Boolean);

describe("a supplier's statement, laid out the way the paper lays it out", () => {
  const table = tableFromPositionedItems(page(PAPERS));
  const header = table[findHeaderRow(table)];

  it("every heading lands in its own column, in the order it is printed", () => {
    const where = HEADINGS.map(([, word]) => header.indexOf(word));
    expect(where).not.toContain(-1);
    expect(where).toEqual([...where].sort((a, b) => a - b));
    expect(new Set(where).size).toBe(HEADINGS.length);
  });

  /**
   * NINE COLUMNS FOR EIGHT HEADINGS, ON PURPOSE. One of the aging footer's five figures sits in the
   * gutter between CUSTOMER PO# and DISCOUNT and belongs to no column on the paper, so it is given a
   * column of its own rather than shoved into a neighbour — a figure in the wrong column is silent,
   * and a column every paper leaves blank changes no answer, because the readers find their columns
   * by the header row's own position.
   */
  it("a figure that belongs to no column gets one of its own, and every paper leaves it blank", () => {
    expect(table.every((r) => r.length === table[0].length)).toBe(true);
    expect(header).toHaveLength(HEADINGS.length + 1);
    const spare = header.findIndex((c) => c === "");
    expect(spare).toBeGreaterThan(-1);
    const reference = header.indexOf("REFERENCE");
    for (const row of table.filter((r) => r[reference].startsWith("7741-"))) expect(row[spare]).toBe("");
  });

  /**
   * THE ONE THAT MATTERS. OPEN AMOUNT is printed at x420 and its amounts END at x496: matched by its
   * left x alone, the heading and its own figures sit in two different columns, and the amount is
   * read under DISCOUNT instead. This asserts they share a column.
   */
  it("money is matched by its right edge, not by the left x of its heading", () => {
    const open = header.indexOf("OPEN AMOUNT");
    const discount = header.indexOf("DISCOUNT");
    expect(cellsAt(table, open)).toContain("412.90");
    expect(cellsAt(table, open)).toContain("60.75-");
    // The one discount figure on the whole statement stays in the discount column.
    expect(cellsAt(table, discount)).toContain("1.24-");
    expect(cellsAt(table, discount)).not.toContain("60.75-");
  });

  it("a row missing its CODE keeps the empty cell, so nothing after it shifts a column left", () => {
    const bare = PAPERS.map((p) => ({ ...p, code: "" })).slice(0, 4);
    const t = tableFromPositionedItems(page(bare));
    const h = t[findHeaderRow(t)];
    const code = h.indexOf("CODE");
    const reference = h.indexOf("REFERENCE");
    const paper = t.find((r) => r[reference] === "7741-2203118");
    expect(paper).toBeDefined();
    expect(paper![code]).toBe("");
    expect(paper![h.indexOf("OPEN AMOUNT")]).toBe("412.90");
  });

  it("reads through the existing reader: nine papers, the credit negative, the aging footer not a paper", () => {
    const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.rows.length).toBe(PAPERS.length);
    const credit = read.list.rows.find((r) => r.reference === "7741-2209914");
    expect(credit?.openBalance).toBe(-60.75);
    expect(credit?.kind).toBe("credit_memo");
    expect(credit?.discountAmount).toBe(-1.24);
    // Not one of the footer's five figures became a paper.
    for (const amount of FOOTER_AMOUNTS) expect(read.list.rows.map((r) => String(r.openBalance))).not.toContain(amount.replace(/,/g, ""));
    expect(read.list.rows.map((r) => r.reference)).not.toContain("TOTAL DUE");
  });

  it("the aging footer's label row is said out loud, not silently thrown away", () => {
    const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.skipped.some((s) => s.why.includes("CURRENT / 1 - 30"))).toBe(true);
  });

  it("it reads as a supplier's list, so it goes in as a list and not as one receipt", () => {
    expect(tableReadsAsList(table)?.as).toBe("supplier");
    // THE ROWS COME BACK WITH THE ANSWER, so a door cannot ask about one table and read another.
    expect(tableReadsAsList(table)?.rows).toEqual(table);
  });
});

describe("a wrapped description belongs to the row above it", () => {
  it("joins that row's own cell, and does not become a row with no paper number", () => {
    const items = page(PAPERS.slice(0, 3));
    // A long job reference wrapped onto a second line, in the CUSTOMER PO# band, under the first paper.
    items.push(run(212, 674, "AND REAR SUBPANEL", 0));
    const table = tableFromPositionedItems(items);
    const header = table[findHeaderRow(table)];
    const po = header.indexOf("CUSTOMER PO#");
    const reference = header.indexOf("REFERENCE");
    const first = table.find((r) => r[reference] === "7741-2203118");
    expect(first![po]).toBe("3302 PINEBROOK AND REAR SUBPANEL");
    expect(table.filter((r) => r[po] === "AND REAR SUBPANEL")).toHaveLength(0);
  });

  it("an address line is not swallowed by whatever row happens to sit above it", () => {
    const table = tableFromPositionedItems(page(PAPERS.slice(0, 3)));
    expect(table.some((r) => r.join(" ").includes("4120 HARROW ROAD"))).toBe(true);
    expect(table.some((r) => r.join(" ").includes("NORTHGATE ELECTRIC SUPPLY 4120 HARROW ROAD"))).toBe(false);
  });

  /**
   * AND IT IS THE ROW ABOVE IT, NOT THE LAST ROW ANYWHERE ON THE PAGE (2026-10-02, the skeptic's pass).
   *
   * The rule had no vertical reach at all: any lone line of words, however far down the page, joined
   * whichever row was pushed last. A section title 80 points below the last paper became part of that
   * paper's NUMBER — "7741-2209002 PAYMENTS AND CREDITS" — and nothing was reported, because the amount
   * was untouched and the rows still added to the TOTAL DUE. The paper then matched no bill the app
   * holds, so the card proposed adding a duplicate and called the real one missing from the list.
   */
  it("a lone line 80 points below the last paper is its own row, and that paper's number is untouched", () => {
    const items = page(PAPERS.slice(0, 5), 0, { foot: false });
    items.push(run(127, 680 - 4 * 12 - 80, "PAYMENTS AND CREDITS", 0));
    const table = tableFromPositionedItems(items);
    const reference = table[findHeaderRow(table)].indexOf("REFERENCE");
    expect(cellsAt(table, reference)).toContain("7741-2209002");
    expect(table.some((r) => r[reference].includes("PAYMENTS AND CREDITS") && r[reference].includes("7741-"))).toBe(false);
    const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.rows.map((r) => r.reference)).toEqual(PAPERS.slice(0, 5).map((p) => p.reference));
    // Said out loud, as the line that did not read: never joined to a paper and never dropped quietly.
    expect(read.list.skipped.some((s) => s.why.includes("PAYMENTS AND CREDITS"))).toBe(true);
  });

  /**
   * A PAGE NUMBER AT THE FOOT OF EVERY PAGE, which is almost every statement there is, and no test had
   * one. At x130 it became part of the last paper's number on pages 1 and 2 with nothing reported; at
   * x420 it became part of the OPEN AMOUNT cell and both papers dropped out of the total; at x25 it
   * landed in the DATE cell, where a date silently becomes null.
   */
  it("a Page N of M footer never joins the last row of its page, wherever on the line it is printed", () => {
    for (const footX of [25, 130, 270, 420]) {
      const items = [...page(PAPERS.slice(0, 4), 0, { foot: false }), ...page(PAPERS.slice(4, 7), 1, { foot: false }), ...page(PAPERS.slice(7), 2)];
      items.push(run(footX, 30, "Page 1 of 3", 0), run(footX, 30, "Page 2 of 3", 1), run(footX, 30, "Page 3 of 3", 2));
      const table = tableFromPositionedItems(items);
      const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
      expect(read.ok, `x=${footX}`).toBe(true);
      if (!read.ok) continue;
      expect(read.list.rows.map((r) => r.reference), `x=${footX}`).toEqual(PAPERS.map((p) => p.reference));
      const total = read.list.rows.reduce((n, r) => n + r.openBalance, 0);
      expect(total.toFixed(2), `x=${footX}`).toBe(TOTAL_DUE.replace("$", "").replace(",", ""));
    }
  });
});

/**
 * THE AGING FOOTER'S FIGURES ARE NOT A PAPER, WHICHEVER WAY THE PAPER PRINTS THEM (2026-10-02).
 *
 * Only the right-aligned layout was pinned. With the amounts printed at their labels' own left x — a
 * layout the same paper allows — the CURRENT bucket lands in the REFERENCE band and became a paper
 * numbered "742.61", so the read report's total overshot the paper's own TOTAL DUE by that bucket, and
 * the sentence under it told him the parse had MISSED something. Applying the card would have added a
 * bill numbered 742.61 to that supplier.
 */
describe("an aging footer invents no paper", () => {
  /** The same page, with the footer's five figures left-aligned under their labels instead. */
  function leftFooter(papers: readonly Paper[]): string[][] {
    const items = page(papers, 0, { foot: false });
    const y = 680 - papers.length * 12 - 40;
    for (const [x, word] of FOOTER) items.push(run(x, y, word, 0));
    FOOTER.forEach(([x], i) => items.push(run(x, y - 12, FOOTER_AMOUNTS[i], 0)));
    return tableFromPositionedItems(items);
  }

  it("a left-aligned footer figure in the REFERENCE band is not a paper number", () => {
    const table = leftFooter(PAPERS.slice(0, 4));
    const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.rows.map((r) => r.reference)).toEqual(PAPERS.slice(0, 4).map((p) => p.reference));
    for (const amount of FOOTER_AMOUNTS) expect(read.list.rows.map((r) => r.reference)).not.toContain(amount);
    // Said out loud, so the total it is held against is the total of the papers and nothing else.
    expect(read.list.skipped.some((s) => s.why.includes("742.61"))).toBe(true);
    expect(read.list.rows.reduce((n, r) => n + r.openBalance, 0)).toBeCloseTo(412.9 + 88.15 + 1204.66 + 275.4, 2);
  });

  it("the whole nine-paper page still reads, right-aligned footer and all", () => {
    const table = tableFromPositionedItems(page(PAPERS));
    const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.rows).toHaveLength(PAPERS.length);
  });
});

/**
 * A STATEMENT WITH ONE OR TWO PAPERS ON IT IS AN ORDINARY MONTH (2026-10-02, the skeptic's pass).
 *
 * Three rows of a page have to agree on an edge before it counts as a column, and a two-paper page has
 * nothing that does: the money columns drew nothing, every money mark fell through as an orphan, the
 * orphans merged, and DISCOUNT, OPEN AMOUNT and ORIG AMOUNT arrived as one cell. tableReadsAsList then
 * said "not a list", so the PDF went down the single-paper path with nothing said, and Reconcile refused
 * it with "nothing on them reads as a statement" — which was false. Worse, the older text reader took
 * the LAST figure on the line as the open balance, so a paper with $100.00 still open on a $412.90
 * invoice showed as $412.90 open.
 */
describe("a short statement keeps its columns apart", () => {
  const SHORT: Paper[] = [
    { age: "47", date: "08/12/26", code: "IN", reference: "7741-2203118", po: "3302 PINEBROOK", open: "412.90", orig: "412.90" },
    // Part-paid: what is OPEN is $100.00 and what the invoice was is $412.90. Two different columns.
    { age: "47", date: "08/12/26", code: "IN", reference: "7741-2203204", po: "3302 PINEBROOK", open: "100.00", orig: "412.90" },
  ];

  for (const n of [1, 2]) {
    it(`${n} paper${n === 1 ? "" : "s"} and an aging footer: every heading in its own column, and it reads as a list`, () => {
      const table = tableFromPositionedItems(page(SHORT.slice(0, n)));
      const header = table[findHeaderRow(table)];
      const where = HEADINGS.map(([, word]) => header.indexOf(word));
      expect(where, "every heading in its own cell").not.toContain(-1);
      expect(new Set(where).size).toBe(HEADINGS.length);
      expect(tableReadsAsList(table)?.as).toBe("supplier");
      const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // THE AMOUNT UNDER THE RIGHT HEADING: $100.00 is open, not the $412.90 the invoice was for.
      expect(read.list.rows.map((r) => [r.reference, r.openBalance])).toEqual(SHORT.slice(0, n).map((p) => [p.reference, Number(p.open.replace(/,/g, ""))]));
    });
  }
});

/**
 * A LETTERHEAD TALLER THAN THE READERS' REACH (2026-10-02, the skeptic's pass). findHeaderRow and
 * findBankHeader each look at the first 15 rows — a download's shape, where the heading is row 0. On a
 * PDF every y-line of the remit-to block, the customer's address, the account box and the supplier's
 * message is a row of its own, and sixteen of them is an ordinary letterhead: the heading landed at row
 * 16, both readers said "no heading", and the statement went down the single-paper path with nothing
 * said about its table.
 */
describe("a statement under a tall letterhead", () => {
  function underLetterhead(lines: number): string[][] {
    const items: PositionedItem[] = [];
    for (let i = 0; i < lines; i++) items.push(run(25, 780 - i * 12, `REMIT TO BOX ${1000 + i} RIVERBEND CA`, 0));
    const top = 780 - lines * 12;
    for (const [x, word] of HEADINGS) items.push(run(x, top, word, 0));
    PAPERS.slice(0, 4).forEach((p, i) => {
      const y = top - 12 - i * 12;
      items.push(run(29, y, p.age, 0), run(51, y, p.date, 0), run(105, y, p.code, 0), run(127, y, p.reference, 0), run(212, y, p.po, 0));
      items.push(money(496, y, p.open, 0), money(577, y, p.orig, 0));
    });
    return tableFromPositionedItems(items);
  }

  for (const lines of [4, 15, 16, 24]) {
    it(`${lines} lines of letterhead above the heading row still reads as a supplier's list`, () => {
      const table = underLetterhead(lines);
      const got = tableReadsAsList(table);
      expect(got?.as).toBe("supplier");
      // The rows handed back start at the heading, so the readers downstream find it inside their reach.
      const read = readOpenListTable({ table: got!.rows, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.list.rows.map((r) => r.reference)).toEqual(PAPERS.slice(0, 4).map((p) => p.reference));
    });
  }

  it("a letterhead inside the readers' reach is left where it is, so a printed total above the table is still read", () => {
    const items: PositionedItem[] = [];
    items.push(run(25, 780, "NORTHGATE ELECTRIC SUPPLY", 0));
    items.push(run(380, 768, "AMOUNT DUE: $1,981.11", 0));
    for (const [x, word] of HEADINGS) items.push(run(x, 700, word, 0));
    PAPERS.slice(0, 4).forEach((p, i) => {
      const y = 680 - i * 12;
      items.push(run(29, y, p.age, 0), run(51, y, p.date, 0), run(105, y, p.code, 0), run(127, y, p.reference, 0), run(212, y, p.po, 0));
      items.push(money(496, y, p.open, 0), money(577, y, p.orig, 0));
    });
    const table = tableFromPositionedItems(items);
    const got = tableReadsAsList(table);
    expect(got?.as).toBe("supplier");
    expect(got!.rows.some((r) => r.join(" ").includes("AMOUNT DUE: $1,981.11"))).toBe(true);
    const read = readOpenListTable({ table: got!.rows, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.printedTotal).toBe(1981.11);
  });
});

describe("three pages of one statement", () => {
  const items = [
    ...page(PAPERS.slice(0, 4), 0, { foot: false }),
    ...page(PAPERS.slice(4, 7), 1, { foot: false }),
    ...page(PAPERS.slice(7), 2),
  ];
  const table = tableFromPositionedItems(items);

  it("carries one heading row and one address block, not three of each", () => {
    expect(table.filter((r) => r.includes("REFERENCE") && r.includes("OPEN AMOUNT"))).toHaveLength(1);
    expect(table.filter((r) => r.join(" ").includes("4120 HARROW ROAD"))).toHaveLength(1);
  });

  it("every paper off all three pages is there, in page order", () => {
    const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.rows.map((r) => r.reference)).toEqual(PAPERS.map((p) => p.reference));
  });
});

describe("a bank statement's pages: the heading says which way the money went", () => {
  /** Two money columns, as a bank prints them, and no minus sign anywhere on the paper. */
  const items: PositionedItem[] = [];
  items.push(run(25, 760, "RIVERBEND COMMUNITY BANK", 0));
  items.push(run(25, 748, "CHECKING 000199884412", 0));
  for (const [x, word] of [
    [30, "DATE"],
    [95, "DESCRIPTION"],
    [330, "WITHDRAWALS"],
    [430, "DEPOSITS"],
    [520, "BALANCE"],
  ] as [number, string][]) {
    items.push(run(x, 700, word, 0));
  }
  const LINES: [string, string, string | null, string | null, string][] = [
    ["09/02/26", "CARD PURCHASE HARROWGATE FUEL", "142.08", null, "8,201.44"],
    ["09/05/26", "DEPOSIT REMOTE", null, "3,400.00", "11,601.44"],
    ["09/09/26", "CHECK 1182", "900.00", null, "10,701.44"],
    ["09/15/26", "ACH NORTHGATE ELECTRIC SUPPLY", "1,204.66", null, "9,496.78"],
    ["09/22/26", "DEPOSIT REMOTE", null, "1,875.50", "11,372.28"],
  ];
  LINES.forEach(([day, text, out, inn, balance], i) => {
    const y = 680 - i * 12;
    items.push(run(30, y, day, 0), run(95, y, text, 0));
    if (out) items.push(money(385, y, out, 0));
    if (inn) items.push(money(480, y, inn, 0));
    items.push(money(575, y, balance, 0));
  });
  const table = tableFromPositionedItems(items);

  it("reads as a bank download through the reader that already exists", () => {
    expect(tableReadsAsList(table)?.as).toBe("bank");
  });

  it("a withdrawal is money out and a deposit is money in, from the heading and not from a sign", () => {
    const dl = readBankTable(table, "Statement.pdf", (t) => `h${t.length}`);
    expect(dl).not.toBeNull();
    expect(dl!.lines).toHaveLength(5);
    const by = new Map(dl!.lines.map((l) => [l.postedOn, l.cents]));
    expect(by.get("2026-09-02")).toBe(-14208);
    expect(by.get("2026-09-05")).toBe(340000);
    expect(by.get("2026-09-15")).toBe(-120466);
    expect(by.get("2026-09-22")).toBe(187550);
  });

  it("the account number on the page never reaches the stored line whole", () => {
    const dl = readBankTable(table, "Statement.pdf", (t) => `h${t.length}`);
    for (const l of dl!.lines) expect(l.description).not.toContain("000199884412");
  });

  /**
   * THE RUNNING BALANCE DOWN THE SIDE OF THE PAGE WALKS ITS OWN LINES (2026-10-02). A statement's pages
   * print one, and a text PDF has no printed totals the app can hold the lines to — so this is the only
   * check this path has, and it catches a line the table extractor dropped or doubled.
   */
  it("the balance column off the page walks line by line, and the report says how it was read", () => {
    const dl = readBankTable(table, "Statement.pdf", (t) => `h${t.length}`, { source: "page" })!;
    expect(dl.lines.map((l) => l.balanceAfterCents)).toEqual([820144, 1160144, 1070144, 949678, 1137228]);
    expect(dl.verified?.chain.ran).toBe(true);
    expect(dl.verified?.chain.links).toBe(4);
    expect(dl.verified?.chain.breaks).toEqual([]);
    expect(dl.readSaid).toContain("proves every line");
    expect(dl.readSaid).toContain("Read off the page itself.");
  });

  it("A LINE THE EXTRACTOR LOST off a page is named, which is the one thing a text PDF has no totals for", () => {
    const short = table.filter((r) => !r.join(" ").includes("CHECK 1182"));
    const dl = readBankTable(short, "Statement.pdf", (t) => `h${t.length}`, { source: "page" })!;
    expect(dl.lines).toHaveLength(4);
    expect(dl.verified?.pass).toBe(false);
    expect(dl.readSaid).toContain("$900.00");
    expect(dl.readSaid).toContain("Go and look at that line against the paper before you Apply.");
  });
});

/**
 * THE SAME PURCHASE TWICE IN ONE WEEK IS TWO PURCHASES (2026-10-02, the skeptic's pass).
 *
 * Page two of a statement reprints the heading row and the address block, so a row a later page repeats
 * cell for cell is dropped. That rule had no exception for a row that carried MONEY: a card statement
 * that charged the same fuel station the same amount on the same day — page 1's last line and page 2's
 * first — read one purchase short. The read report's row count is measured after the drop and nothing in
 * it could carry "a row was removed", so only a total disagreeing with his own paper could reveal it,
 * which the doc comment claimed was impossible.
 */
describe("a repeated line across pages is kept; repeated furniture is not", () => {
  const CARD: [string, string, string][][] = [
    [
      ["09/02/26", "CARD PURCHASE HARROWGATE FUEL", "-142.08"],
      ["09/03/26", "DEPOSIT REMOTE", "300.00"],
      ["09/05/26", "FUEL STOP 57444 RIVERBEND", "-42.17"],
    ],
    [
      ["09/05/26", "FUEL STOP 57444 RIVERBEND", "-42.17"],
      ["09/06/26", "WESTMERE HARDWARE", "-37.42"],
    ],
  ];
  const items: PositionedItem[] = [];
  CARD.forEach((lines, n) => {
    items.push(run(25, 760, "RIVERBEND COMMUNITY BANK", n));
    items.push(run(25, 748, "CARD 000199884412", n));
    for (const [x, word] of [[30, "DATE"], [95, "DESCRIPTION"], [480, "AMOUNT"]] as [number, string][]) items.push(run(x, 700, word, n));
    lines.forEach(([d, t, a], i) => {
      const y = 680 - i * 12;
      items.push(run(30, y, d, n), run(95, y, t, n), money(530, y, a, n));
    });
  });
  const table = tableFromPositionedItems(items);

  it("the heading row and the address block arrive once, not twice", () => {
    expect(table.filter((r) => r.includes("DATE") && r.includes("AMOUNT"))).toHaveLength(1);
    expect(table.filter((r) => r.join(" ").includes("RIVERBEND COMMUNITY BANK"))).toHaveLength(1);
  });

  it("both copies of the repeated purchase are read, and the total is what he spent", () => {
    const dl = readBankTable(table, "Card.pdf", (t) => `h${t.length}`);
    expect(dl).not.toBeNull();
    expect(dl!.lines).toHaveLength(5);
    expect(dl!.lines.filter((l) => l.description.includes("FUEL STOP"))).toHaveLength(2);
    expect(dl!.skipped).toEqual([]);
    expect(dl!.lines.reduce((n, l) => n + l.cents, 0)).toBe(300_00 - 142_08 - 42_17 - 42_17 - 37_42);
  });
});

describe("a scan, and a paper that is one paper", () => {
  it("no marks at all is no table, never an empty statement", () => {
    expect(tableFromPositionedItems([])).toEqual([]);
    expect(tableFromPositionedItems(null)).toEqual([]);
    // The sentence for it lives in pdf-text.ts (noTextSaid) and this is what it must not be: a table.
    expect(tableReadsAsList(tableFromPositionedItems([]))).toBeNull();
  });

  it("an invoice's own item table is not a list of open papers", () => {
    const items: PositionedItem[] = [];
    items.push(run(25, 760, "NORTHGATE ELECTRIC SUPPLY", 0));
    items.push(run(25, 748, "INVOICE 7741-2203118", 0));
    for (const [x, word] of [
      [30, "LINE"],
      [70, "QTY"],
      [120, "DESCRIPTION"],
      [380, "PRICE"],
      [470, "EXTENSION"],
    ] as [number, string][]) {
      items.push(run(x, 700, word, 0));
    }
    [
      ["1", "25", "12-2 ROMEX 250FT", "188.40", "188.40"],
      ["2", "4", "20A SINGLE POLE BREAKER", "22.10", "88.40"],
      ["3", "12", "4 SQUARE BOX", "3.05", "36.60"],
    ].forEach(([line, qty, desc, price, ext], i) => {
      const y = 680 - i * 12;
      items.push(run(30, y, line, 0), run(70, y, qty, 0), run(120, y, desc, 0), money(420, y, price, 0), money(520, y, ext, 0));
    });
    const table = tableFromPositionedItems(items);
    expect(table.length).toBeGreaterThan(3);
    expect(tableReadsAsList(table)).toBeNull();
  });

  /**
   * THE ONE THAT WOULD HAVE COST HIM AN INVOICE. "ITEM" is one of the words a paper number goes by
   * and "AMOUNT" is money, so an invoice that prints those two over its own lines reads as an open
   * list on the words alone. The quantity-and-price guard the paste door already uses says no.
   */
  it("an invoice whose item table says ITEM and AMOUNT is still one paper", () => {
    const items: PositionedItem[] = [];
    for (const [x, word] of [
      [30, "ITEM"],
      [110, "DESCRIPTION"],
      [330, "QTY"],
      [400, "PRICE"],
      [480, "AMOUNT"],
    ] as [number, string][]) {
      items.push(run(x, 700, word, 0));
    }
    [
      ["RMX122-250", "12-2 ROMEX 250FT", "2", "94.20", "188.40"],
      ["BR120", "20A SINGLE POLE BREAKER", "4", "5.52", "22.08"],
      ["4SQ-BOX", "4 SQUARE BOX", "12", "3.05", "36.60"],
      ["MC12-250", "12-2 MC CABLE 250FT", "1", "211.75", "211.75"],
    ].forEach(([item, desc, qty, price, amount], i) => {
      const y = 680 - i * 12;
      items.push(run(30, y, item, 0), run(110, y, desc, 0), run(340, y, qty, 0), money(440, y, price, 0), money(520, y, amount, 0));
    });
    const table = tableFromPositionedItems(items);
    const header = table[findHeaderRow(table)];
    // The words really are there, and it still is not a list.
    expect(header).toContain("ITEM");
    expect(header).toContain("AMOUNT");
    expect(tableReadsAsList(table)).toBeNull();
  });

  /**
   * REFUSING CLEARLY BEATS HANDING BACK A TABLE THAT WILL BE TRUNCATED. capTable keeps 40 columns, and
   * the rightmost column of a statement is its balance.
   */
  it("a page that scatters into more columns than anything downstream keeps reads as no table", () => {
    const items: PositionedItem[] = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 50; col++) items.push(run(5 + col * 11, 700 - row * 12, "x", 0));
    }
    expect(tableFromPositionedItems(items)).toEqual([]);
  });

  it("a job plan — words on a page and no table at all — is not a list", () => {
    const items = [
      run(60, 740, "PANEL SCHEDULE", 0),
      run(60, 720, "Feed the new subpanel off the 60 amp breaker in the main.", 0),
      run(60, 700, "Two 20 amp circuits to the rear bedroom, one to the porch.", 0),
    ];
    expect(tableReadsAsList(tableFromPositionedItems(items))).toBeNull();
  });
});

/**
 * ONE PAPER WITH A DATE ON EVERY LINE IS STILL ONE PAPER (2026-10-02, the skeptic's pass).
 *
 * A date, a description and an amount is the shape of a card statement AND the shape of every
 * subcontractor's invoice. The bank question was asked FIRST, and `looksLikeBankTable` says yes to any
 * such heading with no paper-number column — so a plumber's three dated labour lines came back as three
 * DEPOSITS of the owner's own money, and the invoice guard that was written to stop exactly that sat
 * below the return and could never run. For an office hand the same PDF was refused in the owner's name
 * and his vendor's invoice could not be filed at all.
 *
 * EVERY TABLE BELOW IS LAID OUT WITH A REAL LETTERHEAD ABOVE IT, because the heading row's distance
 * from the top is part of the failure (findHeaderRow looks at the first 15 rows).
 */
describe("a single paper with dated lines is not a statement", () => {
  /** One invoice page: a letterhead, a heading row, and its own lines. */
  function invoice(headings: [number, string][], lines: string[][]): string[][] {
    const items: PositionedItem[] = [];
    items.push(run(25, 770, "WESTMERE MECHANICAL CO", 0));
    items.push(run(25, 758, "118 CALDERWOOD LANE", 0));
    items.push(run(25, 746, "RIVERBEND CA 95605", 0));
    items.push(run(25, 734, "INVOICE 1042", 0));
    for (const [x, word] of headings) items.push(run(x, 700, word, 0));
    lines.forEach((cells, i) => {
      const y = 680 - i * 12;
      cells.forEach((v, c) => {
        if (!v) return;
        // The first two columns are words (left), the rest are figures (right-aligned).
        if (c < 2) items.push(run(headings[c][0] + 5, y, v, 0));
        else items.push(money(headings[c][0] + headings[c][1].length * CH + 20, y, v, 0));
      });
    });
    return tableFromPositionedItems(items);
  }

  const HOURLY: [number, string][] = [[30, "DATE"], [100, "DESCRIPTION"], [330, "HOURS"], [400, "RATE"], [480, "AMOUNT"]];
  const MATERIALS: [number, string][] = [[30, "DATE"], [100, "DESCRIPTION"], [330, "QTY"], [400, "PRICE"], [480, "AMOUNT"]];
  const PROPOSAL: [number, string][] = [[30, "ITEM"], [120, "DESCRIPTION"], [460, "AMOUNT"]];

  it("a dated hourly invoice is not a bank statement, so its hours never become deposits", () => {
    const table = invoice(HOURLY, [
      ["09/01/26", "Rough-in labor", "6.0", "95.00", "570.00"],
      ["09/02/26", "Trim labor", "4.5", "95.00", "427.50"],
      ["09/03/26", "Service call", "2.0", "95.00", "190.00"],
    ]);
    expect(table.some((r) => r.includes("HOURS") && r.includes("RATE"))).toBe(true);
    expect(tableReadsAsList(table)).toBeNull();
    // What it would have been: readBankTable turns those three lines into money IN.
    const dl = readBankTable(table, "Invoice.pdf", (t) => `h${t.length}`);
    expect(dl?.lines.map((l) => l.cents) ?? []).toEqual([57000, 42750, 19000]);
  });

  it("a dated materials invoice is not a bank statement either, though it has a QTY column", () => {
    const table = invoice(MATERIALS, [
      ["09/01/26", "12-2 ROMEX 250FT", "2", "94.20", "188.40"],
      ["09/02/26", "20A SINGLE POLE BREAKER", "4", "5.52", "22.08"],
      ["09/03/26", "4 SQUARE BOX", "12", "3.05", "36.60"],
    ]);
    expect(tableReadsAsList(table)).toBeNull();
  });

  it("a proposal's NAMED lines are not open papers: Interior 1 is not a paper number", () => {
    const table = invoice(PROPOSAL, [
      ["Interior 1", "Walls and ceilings, two coats", "4,800.00"],
      ["Exterior 2", "Siding and trim", "6,250.00"],
      ["Trim 3", "Doors and casings", "1,150.00"],
    ]);
    const header = table[findHeaderRow(table)];
    expect(header).toContain("ITEM");
    expect(header).toContain("AMOUNT");
    expect(tableReadsAsList(table)).toBeNull();
  });

  it("a proposal whose lines carry no number at all is not a list, and is not a dead end either", () => {
    const table = invoice(PROPOSAL, [
      ["Interior", "Walls and ceilings, two coats", "4,800.00"],
      ["Exterior", "Siding and trim", "6,250.00"],
      ["Trim", "Doors and casings", "1,150.00"],
    ]);
    expect(tableReadsAsList(table)).toBeNull();
    // It used to reach readOpenListTable, which refuses it outright — and the PDF was never filed.
    const read = readOpenListTable({ table, from: "file", name: "Proposal.pdf", listDate: "2026-09-25", listDateFrom: "file" });
    expect(read.ok).toBe(false);
  });

  /**
   * AN INVOICE'S LABEL BLOCK IS NOT A ONE-PAPER LIST. INVOICE NO. | INVOICE DATE | TERMS | AMOUNT DUE
   * over its own labour lines read as a supplier's list of one paper (1042, $1,602.00) with four rows
   * reported as "isn't a paper number" — and the invoice itself was never filed as a paper.
   */
  it("an invoice's label block over its own labour lines is not a one-paper list", () => {
    const items: PositionedItem[] = [];
    for (const [x, word] of [[30, "INVOICE NO."], [160, "INVOICE DATE"], [300, "TERMS"], [460, "AMOUNT DUE"]] as [number, string][]) items.push(run(x, 740, word, 0));
    items.push(run(30, 728, "1042", 0), run(160, 728, "09/05/26", 0), run(300, 728, "Net 30", 0), money(530, 728, "1,602.00", 0));
    for (const [x, word] of [[30, "DESCRIPTION"], [330, "HOURS"], [400, "RATE"], [490, "AMOUNT"]] as [number, string][]) items.push(run(x, 700, word, 0));
    [["Rough-in labor", "6.0", "95.00", "570.00"], ["Trim labor", "4.5", "95.00", "427.50"], ["Service call", "2.0", "95.00", "190.00"]].forEach(([t, h, r, a], i) => {
      const y = 680 - i * 12;
      items.push(run(30, y, t, 0), money(350, y, h, 0), money(430, y, r, 0), money(530, y, a, 0));
    });
    const table = tableFromPositionedItems(items);
    expect(tableReadsAsList(table)).toBeNull();
  });

  /**
   * AND A REAL CARD STATEMENT WITH NO BALANCE COLUMN STILL READS. The proof a statement carries and an
   * invoice does not is money that went OUT: an invoice's lines all go one way. Without this the fix
   * above would have turned away the one statement shape Erik actually has to bring in.
   */
  it("a card statement with DATE, DESCRIPTION and AMOUNT reads as a bank statement, by its minus signs", () => {
    const items: PositionedItem[] = [];
    items.push(run(25, 760, "RIVERBEND COMMUNITY BANK", 0));
    items.push(run(25, 748, "CARD 000199884412", 0));
    for (const [x, word] of [[30, "DATE"], [95, "DESCRIPTION"], [480, "AMOUNT"]] as [number, string][]) items.push(run(x, 700, word, 0));
    [["09/02/26", "CARD PURCHASE HARROWGATE FUEL", "-142.08"], ["09/03/26", "REFUND WESTMERE HARDWARE", "37.42"], ["09/05/26", "CARD PURCHASE RIVERBEND FUEL", "-42.17"]].forEach(([d, t, a], i) => {
      const y = 680 - i * 12;
      items.push(run(30, y, d, 0), run(95, y, t, 0), money(530, y, a, 0));
    });
    const table = tableFromPositionedItems(items);
    expect(tableReadsAsList(table)?.as).toBe("bank");
  });
});

describe("the read report says what landed, and never more", () => {
  const table = tableFromPositionedItems(page(PAPERS));
  const read = readOpenListTable({ table, from: "file", name: "Statement.pdf", listDate: "2026-09-25", listDateFrom: "file" });

  it("its numbers are the rows that actually landed", () => {
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const facts = listReadFacts(read.list);
    const said = pdfReadSaid({ pages: 1, rows: table.length }, facts, "2026-09-25");
    expect(facts.read).toBe(read.list.rows.length);
    expect(said).toContain(`${read.list.rows.length} papers`);
    expect(said).toContain("1 page");
    expect(said).toContain(`${table.length} rows on them`);
    // THE FIVE-SECOND PROOF: the rows add to the TOTAL DUE the paper itself prints.
    expect(said).toContain(TOTAL_DUE);
    expect(said).toContain("the TOTAL DUE your statement prints");
  });

  it("a row that did not read is counted and its reason said, never dropped quietly", () => {
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const facts = listReadFacts(read.list);
    expect(facts.skipped.length).toBeGreaterThan(0);
    const said = pdfReadSaid({ pages: 1, rows: table.length }, facts, "2026-09-25");
    expect(said).toContain(`${facts.skipped.length} row`);
    expect(said).toContain("didn't read");
    expect(said).toContain(`line ${facts.skipped[0].line}`);
  });

  it("nothing skipped says nothing skipped, and the sentence is only there for a PDF", () => {
    const clean = { one: "paper", many: "papers", read: 2, from: "2026-09-01", to: "2026-09-20", adds: "$500.00", against: "the TOTAL DUE your statement prints", skipped: [] };
    expect(pdfReadSaid({ pages: 2, rows: 9 }, clean, "2026-09-25")).not.toContain("didn't read");
    expect(pdfReadSaid(null, clean, "2026-09-25")).toBe("");
  });

  it("a bank statement's report says money out and money in separately", () => {
    const dl = { lines: [{ cents: -14208 }, { cents: 340000 }] as never, skipped: [], from: "2026-09-02", to: "2026-09-05" };
    const facts = downloadReadFacts(dl);
    const said = pdfReadSaid({ pages: 3, rows: 12 }, facts, "2026-09-25");
    expect(said).toContain("2 lines");
    expect(said).toContain("$142.08 out and $3,400.00 in");
    expect(said).toContain("the totals your statement prints");
  });
});

describe("the header words a real statement prints are words the reader already knows", () => {
  it("DATE, CODE, REFERENCE, CUSTOMER PO#, DISCOUNT and OPEN AMOUNT all map; AGE and ORIG AMOUNT ask", () => {
    const { columns } = readHeaderRow(HEADINGS.map(([, word]) => word));
    expect(columns.invoiceDate).toBe(1);
    expect(columns.type).toBe(2);
    expect(columns.reference).toBe(3);
    expect(columns.po).toBe(4);
    expect(columns.discountAmount).toBe(5);
    expect(columns.openBalance).toBe(6);
    // AGE and ORIG AMOUNT are nobody's known words, and the column picker is the designed answer.
    expect(columns.amount).toBeUndefined();
  });
});

/**
 * THE REAL SHAPE OF A SCANNED STATEMENT'S PAGES (2026-10-02, measured on his own September file).
 *
 * The transaction table on it is an IMAGE. The PDF still carries 125 text marks over three pages, and
 * every one of them is the back-of-statement legal notice — and a HEADER-SHAPED ROW sits inside that
 * notice. So the text lane really does find a bank heading on a scanned statement, and the one thing
 * standing between that and a bank card of nothing is `bankTableProof`: a heading alone is not a
 * statement. This pins that refusal, because the scanned-statement lane is built on top of it — a
 * confident empty answer is the worst outcome this path has, and it would arrive exactly here.
 */
describe("a scan whose only text is the legal notice does not read as a list", () => {
  /** The notice as it sits on the page: left-aligned small print, with a label row inside it. */
  function legalNotice(): string[][] {
    const items: PositionedItem[] = [];
    const small = [
      "In Case of Errors or Questions About Your Electronic Transfers",
      "Telephone us at the number on the front of this statement, or write to us at",
      "Riverbend Community Bank, PO Box 00000, Riverbend CA 95605, as soon as you can.",
      "Tell us your name and account number, and describe the error or the transfer you",
      "are unsure about, and explain as clearly as you can why you believe it is an error",
      "or why you need more information. Tell us the dollar amount of the suspected error.",
    ];
    small.forEach((text, i) => items.push(run(40, 700 - i * 12, text, 0)));
    // The label row the notice prints over its own worked example: a day, a type, words, an amount.
    for (const [x, word] of [[40, "DATE"], [150, "TYPE"], [240, "DESCRIPTION"], [470, "AMOUNT"]] as [number, string][]) {
      items.push(run(x, 610, word, 0));
    }
    items.push(run(40, 598, "09/02/26", 0), run(150, 598, "DEBIT", 0), run(240, 598, "EXAMPLE ONLY", 0), money(520, 598, "0.00", 0));
    return tableFromPositionedItems(items);
  }

  it("a bank heading IS found inside it, and the proof a statement carries refuses it anyway", async () => {
    const { bankTableProof, findBankHeader } = await import("./bank-download");
    const table = legalNotice();
    // The heading is really there — this is not a test of the heading finder being too clever.
    expect(findBankHeader(table)).not.toBeNull();
    // And it is not a statement: no running balance, no debit/credit pair, no money that went out.
    expect(bankTableProof(table)).toBe(false);
    expect(tableReadsAsList(table)).toBeNull();
  });
});
