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
    expect(tableReadsAsList(table)).toBe("supplier");
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
    expect(tableReadsAsList(table)).toBe("bank");
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
