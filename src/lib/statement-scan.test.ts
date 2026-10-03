import { describe, expect, it } from "vitest";
import {
  SCAN_TABLE_HEADER,
  checkScanTotals,
  notABankScanSaid,
  readScannedBank,
  scanCheckSaid,
  scanKindFrom,
  scanRefusalSaid,
  scanTruncatedSaid,
} from "./statement-scan";
import { findHeaderRow, pdfReadSaid, readHeaderRow } from "./supplier-open-list";
import { downloadReadFacts, looksLikeBankTable, readBankTable, unreadBankTable } from "./bank-download";
import { createHash } from "node:crypto";

/**
 * THE ARITHMETIC JUDGES THE READ, NEVER THE OTHER WAY ROUND (2026-10-02).
 *
 * His bank's statement is a picture, so a model reads it — and a model read is a proposal. What makes
 * that safe to look at is the statement's own printed figures: a beginning balance, an ending balance
 * and the totals of what went in and out. These pin the gate to the cent, and they pin the two ways it
 * can be wrong: a figure misread, and a figure read the right way but the WRONG WAY ROUND.
 *
 * NO MODEL IS CALLED HERE AND NO PDF IS OPENED. Every statement below is a JSON answer of the shape
 * the reader is asked for, written by hand, with invented banks, merchants and figures in it.
 */

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** One statement the reader got exactly right: it balances, and both printed totals agree. */
const GOOD = {
  beginning_balance: 1284.55,
  ending_balance: 2505.56,
  deposits_total: 3437.42,
  withdrawals_total: 2216.41,
  account_last4: "4417",
  lines: [
    { date: "2026-09-02", description: "CARD PURCHASE HARROWGATE FUEL", money_out: 142.08, money_in: null },
    { date: "2026-09-03", description: "REFUND WESTMERE HARDWARE", money_out: null, money_in: 37.42 },
    { date: "2026-09-05", description: "CHECK 1042", money_out: 1250.0, money_in: null },
    { date: "2026-09-08", description: "DEPOSIT INVOICE PAYMENT", money_out: null, money_in: 3400.0 },
    { date: "2026-09-22", description: "ACH CARD PAYMENT WESTMERE CARD SERVICES", money_out: 812.33, money_in: null },
    { date: "2026-09-30", description: "MONTHLY SERVICE CHARGE", money_out: 12.0, money_in: null },
  ],
};

const read = (answer: unknown) => readScannedBank(answer);
const gate = (answer: unknown) => {
  const got = readScannedBank(answer);
  return { got, check: checkScanTotals(got.lines, got.controls) };
};

describe("the gate: a statement's own figures decide whether its lines are believed", () => {
  it("a read that reconciles to the cent passes, and says which checks agreed", () => {
    const { got, check } = gate(GOOD);
    expect(got.lines).toHaveLength(6);
    expect(check.pass).toBe(true);
    expect(check.failed).toEqual([]);
    expect(check.unchecked).toEqual([]);
    expect(check.agreed).toEqual(["the money going out", "the money coming in", "the balance from end to end"]);
    const said = scanCheckSaid(check);
    expect(said).toContain("agree to the cent");
    expect(said).not.toContain("NOTHING");
  });

  it("ONE LINE MISREAD BY A CENT fails, and the refusal names the amount so he can find the line", () => {
    const off = { ...GOOD, lines: GOOD.lines.map((l) => (l.money_out === 142.08 ? { ...l, money_out: 142.09 } : l)) };
    const { check } = gate(off);
    expect(check.pass).toBe(false);
    expect(check.failed.map((f) => f.which)).toEqual(["withdrawals", "balance"]);
    expect(check.failed[0].offByCents).toBe(1);
    const refusal = scanRefusalSaid("September.pdf", check);
    expect(refusal).toContain("nothing was added");
    expect(refusal).toContain("$0.01");
    expect(refusal).toContain("$2,216.42 out");
    expect(refusal).toContain("$2,216.41");
    // ONE NEXT ACTION, and it is the same button he is standing at.
    expect(refusal).toContain("Drop it again");
  });

  it("A WHOLE LINE MISSED is caught by the totals, by exactly the line's own amount", () => {
    const short = { ...GOOD, lines: GOOD.lines.filter((l) => l.money_out !== 1250.0) };
    const { check } = gate(short);
    expect(check.pass).toBe(false);
    expect(check.failed[0]).toMatchObject({ which: "withdrawals", offByCents: 125_000 });
    expect(scanRefusalSaid("September.pdf", check)).toContain("$1,250.00 short");
  });

  it("a figure the model invented — a total that matches nothing — fails rather than passing quietly", () => {
    const { check } = gate({ ...GOOD, withdrawals_total: 2200.0 });
    expect(check.pass).toBe(false);
    expect(check.failed[0].which).toBe("withdrawals");
    expect(check.failed[0].offByCents).toBe(1641);
  });
});

describe("signs: a withdrawal is negative, a deposit positive, and a flipped one never reaches the books", () => {
  it("money out is negative cents and money in positive, whatever order the columns came in", () => {
    const { got } = gate(GOOD);
    expect(got.lines.map((l) => l.cents)).toEqual([-14208, 3742, -125000, 340000, -81233, -1200]);
  });

  it("ONE LINE'S SIGN THE WRONG WAY ROUND fails all three checks — it is never a card", () => {
    const flipped = {
      ...GOOD,
      lines: GOOD.lines.map((l) => (l.money_out === 142.08 ? { date: l.date, description: l.description, money_out: null, money_in: 142.08 } : l)),
    };
    const { got, check } = gate(flipped);
    // The read itself is perfectly well-formed: six lines, every one of them readable.
    expect(got.lines).toHaveLength(6);
    expect(check.pass).toBe(false);
    expect(check.failed.map((f) => f.which)).toEqual(["withdrawals", "deposits", "balance"]);
    // Twice the line, because it moved from one side to the other.
    expect(check.failed[2].offByCents).toBe(2 * 14208);
    const refusal = scanRefusalSaid("September.pdf", check);
    expect(refusal).toContain("$142.08");
    expect(refusal).toContain("2 other checks disagree too");
  });

  it("a line that came back with nothing on it at all is still counted and named", () => {
    const { got } = gate({ ...GOOD, lines: [{}, ...GOOD.lines] });
    expect(got.returned).toBe(7);
    expect(got.lines).toHaveLength(6);
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.lines).toHaveLength(6);
    // AN EMPTY ROW IS THE ONE ROW A FILE READER PASSES OVER IN SILENCE, so it carries words instead.
    expect(dl.skipped).toHaveLength(1);
    expect(dl.skipped[0].line).toBe(2);
    // And the totals still agree, because an empty line is no money: the read is not refused for it.
    expect(checkScanTotals(got.lines, got.controls).pass).toBe(true);
  });

  it("a line printed in BOTH columns, or in neither, is never guessed at", () => {
    const { got } = gate({
      ...GOOD,
      lines: [
        { date: "2026-09-02", description: "BOTH COLUMNS", money_out: 20.0, money_in: 20.0 },
        { date: "2026-09-03", description: "NO AMOUNT AT ALL", money_out: null, money_in: null },
      ],
    });
    expect(got.lines).toEqual([]);
    // BUT BOTH ARE STILL ROWS, so the one read report counts them and says why.
    expect(got.returned).toBe(2);
    expect(got.table).toHaveLength(3);
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.lines).toEqual([]);
    expect(dl.skipped.map((s) => s.why)).toEqual(["No amount on it.", "No amount on it."]);
  });
});

describe("a paper that prints nothing to check against says so, and is still not a dead end", () => {
  it("no beginning balance: the two totals still agree, and the report NAMES what went unchecked", () => {
    const { check } = gate({ ...GOOD, beginning_balance: null });
    expect(check.pass).toBe(true);
    expect(check.agreed).toEqual(["the money going out", "the money coming in"]);
    expect(check.unchecked).toEqual(["the balance from end to end (it prints no beginning balance)"]);
    const said = scanCheckSaid(check);
    expect(said).toContain("could not check the balance from end to end");
    expect(said).toContain("no beginning balance");
    expect(said).toContain("against the paper before you Apply");
  });

  it("NO PRINTED TOTALS AT ALL still reaches the card, and the card says nothing checked it", () => {
    const { got, check } = gate({ ...GOOD, beginning_balance: null, ending_balance: null, deposits_total: null, withdrawals_total: null });
    expect(got.lines).toHaveLength(6);
    expect(check.pass).toBe(true);
    expect(check.agreed).toEqual([]);
    expect(check.failed).toEqual([]);
    const said = scanCheckSaid(check);
    expect(said).toContain("prints no totals to hold the read against");
    expect(said).toContain("NOTHING here checked it");
    expect(said).toContain("every line is the reader's word");
  });

  it("the check goes into the ONE read report, in place of asking him to do it again", () => {
    const { got, check } = gate(GOOD);
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    const said = pdfReadSaid({ pages: 3, rows: got.returned, checked: scanCheckSaid(check) }, downloadReadFacts(dl), "2026-09-30");
    expect(said).toContain("3 pages, 6 rows on them, 6 lines");
    expect(said).toContain("$2,216.41 out and $3,437.42 in");
    expect(said).toContain("agree to the cent");
    // The text lane's sentence is the one thing it must NOT say: that check has already run.
    expect(said).not.toContain("Check that against");
  });

  it("without a check, the report is exactly what it was before: hold it against your own paper", () => {
    const { got } = gate(GOOD);
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(pdfReadSaid({ pages: 3, rows: 6 }, downloadReadFacts(dl), "2026-09-30")).toContain("Check that against the totals your statement prints");
  });
});

describe("the rows are the rows a CSV would have made: one reader, one card", () => {
  const { got } = gate(GOOD);

  it("they read as a BANK download and never as a supplier's open list", () => {
    expect(got.table[0]).toEqual(SCAN_TABLE_HEADER);
    const at = findHeaderRow(got.table);
    const supplierRef = at >= 0 && readHeaderRow(got.table[at] ?? []).columns.reference !== undefined;
    expect(supplierRef).toBe(false);
    // The two questions addOpenList asks of any table, in its order.
    expect(looksLikeBankTable(got.table, supplierRef)).toBe(true);
    expect(unreadBankTable(got.table, at, supplierRef)).toBe(false);
  });

  it("every line comes through the existing bank reader with its day, its words and its sign", () => {
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.lines).toHaveLength(6);
    expect(dl.skipped).toEqual([]);
    expect(dl.from).toBe("2026-09-02");
    expect(dl.to).toBe("2026-09-30");
    expect(dl.last4).toBe("4417");
    expect(dl.lines[0]).toMatchObject({ postedOn: "2026-09-02", cents: -14208 });
    expect(dl.lines[3]).toMatchObject({ postedOn: "2026-09-08", cents: 340000 });
  });

  it("a date the reader mangled is a row the report names, never a line that quietly vanishes", () => {
    const { got: bad } = gate({ ...GOOD, lines: [{ date: "09/31/26", description: "CARD PURCHASE HARROWGATE FUEL", money_out: 142.08, money_in: null }, ...GOOD.lines.slice(1)] });
    expect(bad.returned).toBe(6);
    expect(bad.lines).toHaveLength(5);
    const dl = readBankTable(bad.table, "September.pdf", hash)!;
    expect(dl.lines).toHaveLength(5);
    expect(dl.skipped).toHaveLength(1);
    expect(dl.skipped[0].why).toContain("didn't read as a day");
    // And the gate then fails, because the lines no longer add to what the paper prints.
    expect(checkScanTotals(bad.lines, bad.controls).pass).toBe(false);
  });
});

describe("privacy: a long number never reaches the books, whatever the reader hands back", () => {
  it("a description carrying an account number is cut to its last four before it is stored", () => {
    const { got } = gate({
      ...GOOD,
      lines: [{ date: "2026-09-12", description: "ONLINE TRANSFER TO SAVINGS 000123456789", money_out: 500.0, money_in: null }],
    });
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.lines[0].description).toBe("ONLINE TRANSFER TO SAVINGS ••6789");
    // 0363's CHECK: no run of 6 or more digits, ever. It is never the thing that finds out.
    expect(dl.lines[0].description).not.toMatch(/\d(?:[ -]?\d){5}/);
  });

  it("a full account number handed back where four digits were asked for is cut to four", () => {
    const { got } = gate({ ...GOOD, account_last4: "4417 8891 0023 1180" });
    expect(got.last4).toBe("1180");
    expect(got.table[1][4]).toBe("1180");
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.last4).toBe("1180");
  });
});

describe("a cut-off answer is said out loud, and what a paper is comes from looking at it", () => {
  it("truncation is never a short list that looks complete", () => {
    const said = scanTruncatedSaid("September.pdf", 250);
    expect(said).toContain("Nothing was added");
    expect(said).toContain("looks complete and isn't");
    expect(said).toContain("two shorter PDFs");
  });

  it("the cheap look's answer is taken plainly, and anything else is 'other'", () => {
    expect(scanKindFrom({ paper: "bank_statement", what: "a checking account statement" })).toEqual({ kind: "bank_statement", what: "a checking account statement" });
    expect(scanKindFrom({ paper: "supplier_statement", what: "a supply house statement" }).kind).toBe("supplier_statement");
    expect(scanKindFrom({ paper: "one_paper", what: "a hardware store receipt" }).kind).toBe("one_paper");
    // A guess is not an answer: a word nobody listed, a missing field and a non-object all read "other".
    expect(scanKindFrom({ paper: "probably a statement?" }).kind).toBe("other");
    expect(scanKindFrom({}).kind).toBe("other");
    expect(scanKindFrom(null).kind).toBe("other");
    // The model's words go on screen: one short phrase, never an essay.
    expect(scanKindFrom({ paper: "other", what: `a letter\n\n${"x".repeat(200)}` }).what.length).toBe(60);
  });

  it("a scan that isn't a bank statement names ONE door, and it is the one that reads a paper", () => {
    const receipt = notABankScanSaid("Ticket.pdf", "one_paper", "a hardware store receipt");
    expect(receipt).toContain("reads as a hardware store receipt");
    expect(receipt).toContain("+ button");
    const supplier = notABankScanSaid("Statement.pdf", "supplier_statement", "a supply house statement");
    expect(supplier).toContain("a supplier's statement rather than a bank's");
    expect(supplier).toContain("+ button");
    // Even with no words back, it still names the door.
    expect(notABankScanSaid("Plan.pdf", "other", "")).toContain("+ button");
  });
});
