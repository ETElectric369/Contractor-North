import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { parseCSV } from "@/lib/csv";
import { buildXlsx } from "@/lib/xlsx-write";
import { readXlsx } from "@/lib/xlsx-read";
import { closeCutoff, readOpenListTable, reconcileOpenList, tableStatementDate, type OpenListPaper } from "@/lib/supplier-open-list";

/**
 * ── A STATEMENT READS ITS OWN DATE (2026-10-03) ───────────────────────────────────────────────
 *
 * Erik dropped a real supplier statement and it proposed marking 23 bills paid. Of the 26 unpaid
 * bills on that account only 2 were dated on or before the day the statement was PRINTED; the other
 * 24 were dated after it, and applying it would have erased nine and a half thousand dollars of
 * money he genuinely owes.
 *
 * The rule (`closeCutoff`) was already right. The DATE was wrong: it came from the file's SAVE
 * timestamp — the day he downloaded it, two months after the paper was printed — so the cutoff moved
 * two months forward with it. These tests are the teeth: the printed date wins, and a statement that
 * prints none behaves exactly as it did before.
 *
 * Every figure, name and place below is invented (tests/no-real-names.test.ts is the tripwire); the
 * SHAPE is his: a heading block whose labels sit in one column with their values in the next cell
 * across, rows further down each carrying a date of their own.
 */

/** His layout: DATE / ACCOUNT / PAGE down one column, the values in the next cell across. */
const STATEMENT_BESIDE: string[][] = [
  ["HALVERSON ELECTRIC SUPPLY", "", ""],
  ["STATEMENT OF ACCOUNT", "", ""],
  ["DATE", "09/25/26", ""],
  ["ACCOUNT", "AC-55012", ""],
  ["PAGE", "1", ""],
  ["Reference", "Type", "Inv Date", "Amount", "Open Balance"],
  ["7701-220114", "Invoice", "09/08/26", "412.50", "412.50"],
  ["7701-220486", "Invoice", "09/19/26", "188.04", "188.04"],
];

/** The other way a heading block prints: labels across one row, their values across the next. */
const STATEMENT_UNDER: string[][] = [
  ["HALVERSON ELECTRIC SUPPLY", "", ""],
  ["DATE", "ACCOUNT", "PAGE"],
  ["09/25/26", "AC-55012", "1"],
  ["Reference", "Type", "Inv Date", "Amount", "Open Balance"],
  ["7701-220114", "Invoice", "09/08/26", "412.50", "412.50"],
  ["7701-220486", "Invoice", "09/19/26", "188.04", "188.04"],
];

/** An ordinary portal download: the column headings are row 0 and the paper names no date of its own. */
const PLAIN_DOWNLOAD = `Reference #,Type,Inv Date,Inv Amt,Open Balance
7701-220114,Invoice,09/08/2026,412.50,412.50
7701-220486,Invoice,09/19/2026,188.04,188.04
`;

/** The day the FILE was saved: two months after the paper was printed, because that is when he downloaded it. */
const FILE_SAVED = "2026-11-28";

const paper = (number: string, invoiceDate: string | null, open: number): OpenListPaper => ({
  id: `p-${number}`,
  invoiceNumber: number,
  kind: "invoice",
  invoiceDate,
  dueDate: null,
  total: open,
  openBalance: open,
  closed: false,
  discountAmount: null,
  discountBy: null,
  jobNameRaw: null,
  supplierAccountId: "acct-1",
});

describe("the date a statement calls its own", () => {
  it("finds the day BESIDE the word DATE in a heading block, and ignores every row's own date", () => {
    expect(tableStatementDate(STATEMENT_BESIDE, 5)).toBe("2026-09-25");
  });

  it("finds the day UNDER the word DATE, in the label's own column", () => {
    expect(tableStatementDate(STATEMENT_UNDER, 3)).toBe("2026-09-25");
  });

  it("never takes a date from a row below the headings: a download with no heading block prints no date", () => {
    expect(tableStatementDate(parseCSV(PLAIN_DOWNLOAD), 0)).toBeNull();
  });

  /**
   * ── THE LABEL IS RARELY THE FIRST CELL OF ITS ROW (review, 2026-10-03) ──────────────────────
   *
   * This read each heading row with its blanks dropped and JOINED, against a pattern anchored at the
   * start of the line, so any cell to the LEFT of the label hid it. On a PDF every mark on one y-line
   * is one row (pdf-table rowsOf), so the letterhead or the bill-to address sitting on the same line as
   * the DATE box is the ordinary case — and the date fell back to the file's save day, which is the
   * whole $9,410.92 harm. Every shape below returned null before the cells were scanned.
   */
  it("finds the day when the letterhead sits to the LEFT of the DATE box", () => {
    expect(tableStatementDate([["ET ELECTRIC 123 MAIN ST", "DATE", "09/25/26"], ["Reference", "Amount", "Open Balance"]], 1)).toBe("2026-09-25");
  });

  it("finds the day when two label/value pairs share one row", () => {
    expect(tableStatementDate([["Account No: 55012", "Statement Date: 09/25/26"], ["Reference", "Amount", "Open Balance"]], 1)).toBe("2026-09-25");
  });

  it("finds the day in a labels row whose values sit under it, with a cell to the left of the labels", () => {
    const rows = [
      ["4120 HARROW ROAD", "ACCOUNT", "DATE", "PAGE"],
      ["SPRINGVALE", "AC-55012", "09/25/26", "1"],
      ["Reference", "Amount", "Open Balance"],
    ];
    expect(tableStatementDate(rows, 2)).toBe("2026-09-25");
  });

  it("reads an 'as of' title cell, wherever the words sit in it", () => {
    expect(tableStatementDate([["Statement as of 09/25/26"], ["Reference", "Amount", "Open Balance"]], 1)).toBe("2026-09-25");
    expect(tableStatementDate([["Open Items As Of 09/25/26"], ["Reference", "Amount", "Open Balance"]], 1)).toBe("2026-09-25");
  });

  /** A paper that prints both gives the one it calls its OWN, never the other date box beside it. */
  it("prefers STATEMENT DATE over a bare DATE printed in the same block", () => {
    const rows = [
      ["DATE PRINTED", "11/02/26", "Statement Date", "09/25/26"],
      ["Reference", "Amount", "Open Balance"],
    ];
    expect(tableStatementDate(rows, 1)).toBe("2026-09-25");
  });

  /**
   * ── AN .xlsx DATE CELL IS A NUMBER (review, 2026-10-03) ────────────────────────────────────
   *
   * `readXlsx` reads no styles.xml, so a cell Excel holds as a real date comes up as its serial day
   * count ("46290"). The row date columns already pass `serialOk`; these heading reads did not, so an
   * .xlsx statement whose DATE cell is a genuine date behaved exactly as it did before this shipped.
   */
  it("reads an Excel date serial beside, and under, the word DATE", () => {
    expect(tableStatementDate([["DATE", "46290"], ["Reference", "Amount", "Open Balance"]], 1)).toBe("2026-09-25");
    expect(tableStatementDate([["DATE", "ACCOUNT", "PAGE"], ["46290", "1234567", "1"], ["Reference", "Amount", "Open Balance"]], 2)).toBe("2026-09-25");
  });
});

describe("the printed date beats the file's save timestamp", () => {
  it("a statement printed in September, downloaded in November, is dated September", () => {
    const read = readOpenListTable({ table: STATEMENT_BESIDE, from: "file", name: "Statement.pdf", listDate: FILE_SAVED, listDateFrom: "file" });
    if (!read.ok) throw new Error("the statement did not read as a list");
    expect(read.list.listDate).toBe("2026-09-25");
    expect(read.list.listDateFrom).toBe("printed");
  });

  /**
   * THE WHOLE POINT, IN MONEY. Two bills on the account are older than the statement and are not on
   * it, so they are paid. Twenty-four arrived after it was printed; the supplier cannot have known
   * about them, so their absence proves nothing. With the file's date the cutoff reached all of them.
   */
  it("the cutoff follows the printed date, so bills dated after it are left open, not marked paid", () => {
    const read = readOpenListTable({ table: STATEMENT_BESIDE, from: "file", name: "Statement.pdf", listDate: FILE_SAVED, listDateFrom: "file" });
    if (!read.ok) throw new Error("the statement did not read as a list");
    // The newest paper the statement carries (09/19) or a week before its printed date, whichever is
    // later, never past the printed date itself: a September cutoff, not a late-November one.
    expect(closeCutoff(read.list)).toBe("2026-09-19");

    const older = [paper("7701-219002", "2026-09-02", 61.4), paper("7701-219330", "2026-09-05", 74.18)];
    const newer = Array.from({ length: 24 }, (_, i) => paper(`7701-23${String(i).padStart(4, "0")}`, "2026-10-14", 392.12));
    const plan = reconcileOpenList(read.list, [...older, ...newer], "acct-1");
    expect(plan.close.map((c) => c.number).sort()).toEqual(older.map((p) => p.invoiceNumber).sort());
    expect(plan.keepNewer).toHaveLength(24);
    expect(plan.totals.closed).toBe(135.58);
    // $9,410.88 of money he owes stays owed. Under the file's date every one of these was closed.
    expect(plan.keepNewer.reduce((t, k) => t + k.open, 0)).toBeCloseTo(9410.88, 2);
  });

  /**
   * A DATE LATER THAN THE DAY WE ALREADY HAVE IS A MISREAD, NOT A STATEMENT FROM THE FUTURE. A file
   * cannot be saved before the paper inside it was printed, so a later "printed" date could only
   * WIDEN the cutoff — the exact harm this closes — and it is refused.
   */
  it("refuses a printed date later than the day the file was saved", () => {
    const fromTheFuture = STATEMENT_BESIDE.map((r) => (r[0] === "DATE" ? ["DATE", "12/31/26", ""] : r));
    const read = readOpenListTable({ table: fromTheFuture, from: "file", name: "Statement.pdf", listDate: "2026-10-01", listDateFrom: "file" });
    if (!read.ok) throw new Error("the statement did not read as a list");
    expect(read.list.listDate).toBe("2026-10-01");
    expect(read.list.listDateFrom).toBe("file");
  });
});

/**
 * ── A REAL .xlsx, BUILT AND READ BY THIS REPO'S OWN TWO HALVES ─────────────────────────────────
 *
 * Not a hand-typed table of strings: the workbook is written with `buildXlsx` (its DATE cell a genuine
 * Excel date) and read back with `readXlsx`, which is what the browser does at the drop. The reader
 * loads no styles.xml, so the cell arrives as "46290" — and that is the shape the heading reads were
 * blind to, with the file's November save day left standing on a statement printed in September.
 */
describe("an .xlsx statement whose DATE cell is a real Excel date", () => {
  const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));
  const inflate = (b: Uint8Array, maxBytes: number) => new Uint8Array(inflateRawSync(b, { maxOutputLength: maxBytes + 1 }));
  const cells = (c: (string | number | { date: string })[]) => ({ cells: c });

  const workbook = () =>
    buildXlsx(
      [
        {
          name: "Statement",
          rows: [
            cells(["HALVERSON ELECTRIC SUPPLY"]),
            cells(["DATE", { date: "2026-09-25" }]),
            cells(["ACCOUNT", "AC-55012"]),
            cells(["Reference", "Type", "Inv Date", "Amount", "Open Balance"]),
            cells(["7701-220114", "Invoice", "09/08/26", 412.5, 412.5]),
            cells(["7701-220486", "Invoice", "09/19/26", 188.04, 188.04]),
          ],
        },
      ],
      { deflate },
    );

  it("hands the date cell up as its serial, and the statement still dates itself September", async () => {
    const read = await readXlsx(workbook(), inflate, "Statement.xlsx");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The reader really does hand up a number: this is the fact the heading reads have to cope with.
    expect(read.rows[1]).toEqual(["DATE", "46290"]);
    const list = readOpenListTable({ table: read.rows, from: "file", name: "Statement.xlsx", listDate: FILE_SAVED, listDateFrom: "file" });
    if (!list.ok) throw new Error("the workbook did not read as a list");
    expect(list.list.listDate).toBe("2026-09-25");
    expect(list.list.listDateFrom).toBe("printed");
    expect(closeCutoff(list.list)).toBe("2026-09-19");
  });
});

describe("a list whose printed date cannot be found behaves exactly as it does today", () => {
  it("keeps the file's date and says so, and its cutoff is unchanged", () => {
    const read = readOpenListTable({ table: parseCSV(PLAIN_DOWNLOAD), from: "file", name: "Open.csv", listDate: "2026-09-26", listDateFrom: "file" });
    if (!read.ok) throw new Error("the download did not read as a list");
    expect(read.list.listDate).toBe("2026-09-26");
    expect(read.list.listDateFrom).toBe("file");
    // The newest paper on it (09/19) against a week before the list's date (09/19): unchanged.
    expect(closeCutoff(read.list)).toBe("2026-09-19");
  });

  it("keeps a 'today' date when the file carried no timestamp at all", () => {
    const read = readOpenListTable({ table: parseCSV(PLAIN_DOWNLOAD), from: "paste", name: "Pasted list", listDate: "2026-09-26", listDateFrom: "today" });
    if (!read.ok) throw new Error("the download did not read as a list");
    expect(read.list.listDateFrom).toBe("today");
  });

  /**
   * AND WITH NO DAY TO HOLD IT AGAINST, NOTHING IS TAKEN. A date read off a paper could be any year at
   * all; a cutoff is only ever as safe as the day it is counted back from, so with no bound the list
   * behaves as it did before this shipped. Every door in the app passes one (the file's save day, or the
   * company's own today), so this is the belt, not the trousers.
   */
  it("takes no printed date when the caller gave no day to hold it against", () => {
    const read = readOpenListTable({ table: STATEMENT_BESIDE, from: "file", name: "Statement.pdf", listDate: null, listDateFrom: "today" });
    if (!read.ok) throw new Error("the statement did not read as a list");
    expect(read.list.listDate).toBeNull();
    expect(read.list.listDateFrom).toBe("today");
  });

  /** The text lane already found the day in the WHOLE text, which is more than a heading block sees. */
  it("leaves a list that already says 'printed' alone", () => {
    const read = readOpenListTable({ table: STATEMENT_BESIDE, from: "statement", name: "Statement.pdf", listDate: "2026-09-20", listDateFrom: "printed" });
    if (!read.ok) throw new Error("the statement did not read as a list");
    expect(read.list.listDate).toBe("2026-09-20");
  });
});


/**
 * ── A LIST ALREADY STORED WITH A "file" DATE DOES NOT RE-DATE ITSELF UNDER A PERSON ────────────
 *
 * The card is drawn from the STORED list (open-list-core `viewOf` → `reconcileOpenList`), never by
 * re-reading the file, so a list that was dropped before this shipped keeps the date it was stored
 * with and the sentence that says where that date came from. It would be worse than a stale date for
 * the figures on a card to move while he is looking at it: he reads the headline, goes to make a cup of
 * tea, and Apply does something else.
 *
 * The ONE path that re-reads a stored table is the column picker (`pickOpenListColumns` /
 * `rememberedFor`), which has no list yet — nothing has been applied from it, and it gets a better
 * date, which is the point.
 */
describe("a list stored before this shipped", () => {
  it("is read from the stored row, so its date and its sentence are whatever was stored", () => {
    const core = readFileSync(join(process.cwd(), "src/app/(app)/bills/open-list-core.ts"), "utf8");
    // viewOf takes the stored list as it is; nothing in it re-reads a table to re-date one.
    expect(core).toContain("const list = stored.list;");
    expect(core).toContain("const dateSaid = listDateSaid(list, ctx.today);");
    // The only re-read is the one a person asks for, by picking columns on a list that has none.
    const reread = core.split("readOpenListTable(").length - 1;
    expect(reread, "readOpenListTable is called once in open-list-core: rememberedFor").toBe(1);
  });
});
