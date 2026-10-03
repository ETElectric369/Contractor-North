import { describe, expect, it } from "vitest";
import { parseCSV } from "@/lib/csv";
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

  /** The text lane already found the day in the WHOLE text, which is more than a heading block sees. */
  it("leaves a list that already says 'printed' alone", () => {
    const read = readOpenListTable({ table: STATEMENT_BESIDE, from: "statement", name: "Statement.pdf", listDate: "2026-09-20", listDateFrom: "printed" });
    if (!read.ok) throw new Error("the statement did not read as a list");
    expect(read.list.listDate).toBe("2026-09-20");
  });
});
