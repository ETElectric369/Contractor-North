import { describe, expect, it } from "vitest";
import {
  SCAN_MAX_BYTES,
  SCAN_TABLE_HEADER,
  checkScanTotals,
  closeCutJson,
  notABankScanSaid,
  readScannedBank,
  scanCheckSaid,
  scanKindFrom,
  scanRefusalSaid,
  scanTooSlowSaid,
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
    // ONE NEXT ACTION, and it is the same button he is standing at — then the door that keeps the
    // paper if that action does not work, because the same refusal twice is otherwise a dead end.
    expect(refusal).toContain("Drop it again");
    expect(refusal).toContain("+ button");
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

/**
 * THE RUNNING BALANCE THE PAPER PRINTS BESIDE ITS LINES (2026-10-02). Erik: "is there a second one for
 * all of it as I'm imagining there is?" — and the chain IS the better of the two checks, because a
 * totals check passes when two errors cancel and a chain cannot.
 *
 * THE READER IS TOLD TO COPY IT AND NEVER TO WORK IT OUT (SCAN_LINES_SYSTEM), for the obvious reason: a
 * balance column the reader calculated from its own lines would agree with its own lines no matter what
 * it got wrong, which is the false assurance this whole lane exists to prevent.
 */
describe("a scanned statement's own running balance walks its lines", () => {
  /** GOOD's balances, walked by hand from its printed beginning balance of $1,284.55. The third one is
   *  NEGATIVE: the account was overdrawn that week, and the paper prints it as -70.11. */
  const WALKED = [1142.47, 1179.89, -70.11, 3329.89, 2517.56, 2505.56];
  const withBalances = (over: Record<number, number | null> = {}) => ({
    ...GOOD,
    lines: GOOD.lines.map((l, i) => ({ ...l, balance: i in over ? over[i] : WALKED[i] })),
  });

  it("it lands in the table's own Balance column, with its sign, and in cents on every line", () => {
    const got = readScannedBank(withBalances());
    expect(got.table[0]).toEqual(SCAN_TABLE_HEADER);
    expect(got.table[0][5]).toBe("Balance");
    expect(got.table[3][5]).toBe("-70.11");
    const dl = readBankTable(got.table, "September.pdf", hash, { source: "picture", controls: got.controls })!;
    expect(dl.lines.map((l) => l.balanceAfterCents)).toEqual([114247, 117989, -7011, 332989, 251756, 250556]);
    expect(dl.verified?.chain.ran).toBe(true);
    expect(dl.verified?.chain.links).toBe(5);
    expect(dl.verified?.chain.breaks).toEqual([]);
    expect(dl.verified?.pass).toBe(true);
    // ONE REPORT, BOTH CHECKS, and the clause that says how hard to look.
    expect(dl.readSaid).toContain("agree to the cent");
    expect(dl.readSaid).toContain("proves every line");
    expect(dl.readSaid).toContain("Read from a picture of the page.");
  });

  it("A LINE WITH NO BALANCE BESIDE IT is a blank cell, and the chain checks what it can", () => {
    const got = readScannedBank(withBalances({ 2: null }));
    expect(got.table[3][5]).toBe("");
    const dl = readBankTable(got.table, "September.pdf", hash, { source: "picture", controls: got.controls })!;
    expect(dl.lines[2].balanceAfterCents).toBeNull();
    expect(dl.verified?.chain.withBalance).toBe(5);
    expect(dl.verified?.chain.links).toBe(3);
    expect(dl.verified?.chain.breaks).toEqual([]);
  });

  /**
   * THE CASE THAT PROVES THIS WAS WORTH BUILDING. Two misreads that cancel: $100 off the check and $100
   * onto the card payment. Money out, money in and the balance from end to end all still agree to the
   * cent — cn-v1050's gate waves it straight through — and the chain names the line.
   */
  it("TWO MISREADS THAT CANCEL pass every printed total and are still refused", () => {
    const cancelled = {
      ...GOOD,
      lines: GOOD.lines.map((l, i) => ({
        ...l,
        balance: WALKED[i],
        ...(i === 2 ? { money_out: 1150.0 } : i === 4 ? { money_out: 912.33 } : {}),
      })),
    };
    const got = readScannedBank(cancelled);
    const dl = readBankTable(got.table, "September.pdf", hash, { source: "picture", controls: got.controls })!;
    // Every printed figure agrees, exactly as before this lane existed.
    expect(checkScanTotals(dl.lines, got.controls).pass).toBe(true);
    // And the chain does not.
    expect(dl.verified?.pass).toBe(false);
    expect(dl.verified?.failed[0].which).toBe("chain");
    const refusal = scanRefusalSaid("September.pdf", { failed: dl.verified!.failed });
    expect(refusal).toContain("nothing was added");
    expect(refusal).toContain("line 4 (Sep 5)");
    expect(refusal).toContain("$100.00");
    expect(refusal).toContain("+ button");
  });

  it("a reader that hands back NO balances behaves exactly as it did before: the totals alone judge it", () => {
    const got = readScannedBank(GOOD);
    expect(got.table.every((r) => r[5] === "Balance" || r[5] === "")).toBe(true);
    const dl = readBankTable(got.table, "September.pdf", hash, { source: "picture", controls: got.controls })!;
    expect(dl.verified?.pass).toBe(true);
    expect(dl.verified?.chain.ran).toBe(false);
    expect(dl.readSaid).toContain("agree to the cent");
    expect(dl.readSaid).toContain("prints no running balance beside its lines");
    // And it never claims the walk happened.
    expect(dl.readSaid).not.toContain("proves every line");
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

/**
 * ONE DAY READER, SO THE GATE AND THE CARD CANNOT HOLD DIFFERENT LINES.
 *
 * The gate read its lines with readDate and the card's rows land through readBankDate, which also takes
 * a year-first slash date, a month as a word, a time suffix and an Excel serial. So the gate counted
 * FEWER lines than the card carried, in the one direction that matters: a correct read was refused for
 * the missing amount, and an extra or duplicated row in one of those date forms rode onto a card whose
 * own sentence said the read agreed to the cent.
 */
describe("one day reader: the gate counts exactly the lines that land", () => {
  const ONE = { description: "CHECK 1042", money_out: 1250.0, money_in: null };
  /** What the gate actually judges: a day and signed cents. (`at` is only ever for naming a row.) */
  const judged = (ls: readonly { date: string; cents: number }[]) => ls.map((l) => ({ date: l.date, cents: l.cents }));
  /** The lines that LANDED, in the same shape: the gate reads the verdict the bank reader worked out
   *  from exactly these, so this is the set the card carries. */
  const landed = (ls: readonly { postedOn: string; cents: number }[]) => ls.map((l) => ({ date: l.postedOn, cents: l.cents }));
  for (const printed of ["2026-09-05", "2026/09/05", "09/05/2026", "05-SEP-2026", "5 Sep 2026", "5 September 2026", "9/5/2026 12:00 AM", "2026-09-05T00:00:00"]) {
    it(`"${printed}" counts once, on both sides`, () => {
      const got = readScannedBank({ ...GOOD, lines: [{ date: printed, ...ONE }] });
      const dl = readBankTable(got.table, "September.pdf", hash)!;
      expect(dl.lines).toHaveLength(1);
      expect(dl.lines[0].postedOn).toBe("2026-09-05");
      expect(got.lines).toHaveLength(1);
      // THE TEETH: the set the gate judges IS the set the reader produced, line for line and cent for
      // cent. A door that reads a date its own way again would break this, whichever door it is.
      expect(judged(landed(dl.lines))).toEqual(judged(got.lines));
    });
  }

  it("a correct read with one non-ISO date is NOT refused as short any more", () => {
    const mixed = { ...GOOD, lines: GOOD.lines.map((l, i) => (i === 1 ? { ...l, date: "2026/09/03" } : l)) };
    const got = readScannedBank(mixed);
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.lines).toHaveLength(6);
    expect(checkScanTotals(dl.lines, got.controls).pass).toBe(true);
  });

  it("an extra row in a non-ISO date form is caught, not waved through", () => {
    // The old gate never saw this line, so the card carried 7 lines while saying the read agreed.
    const doubled = { ...GOOD, lines: [...GOOD.lines, { date: "5 Sep 2026", description: "CHECK 1042", money_out: 1250.0, money_in: null }] };
    const got = readScannedBank(doubled);
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.lines).toHaveLength(7);
    const check = checkScanTotals(dl.lines, got.controls);
    expect(check.pass).toBe(false);
    expect(scanRefusalSaid("September.pdf", check)).toContain("$1,250.00 over");
  });

  /**
   * THE TEETH ON THE RULE. Not one example but the invariant itself: whatever a reader hands back, the
   * lines the gate is given and the lines the bank reader makes of the same table are the SAME set. A
   * door that reads a date, an amount or a blank its own way again breaks this, which is the only way
   * "the gate judges what lands" can stay true after today.
   */
  it("whatever comes back, the gate's lines ARE the bank reader's lines", () => {
    const forms = ["2026-09-02", "2026/09/02", "09/02/2026", "02-SEP-2026", "2 Sep 2026", "9/2/2026 12:00 AM", "09/31/26", "next Tuesday", "", "46266"];
    const odd = [
      { money_out: 10.0, money_in: null },
      { money_out: null, money_in: 10.0 },
      { money_out: 0, money_in: 0 }, // nothing moved: counted by neither
      { money_out: 5.0, money_in: 5.0 }, // both columns: guessed at by neither
      { money_out: null, money_in: null },
      { money_out: "1,234.56", money_in: null },
    ];
    const rows: unknown[] = [{}];
    for (const date of forms) for (const amounts of odd) rows.push({ date, description: "WESTMERE HARDWARE", ...amounts });
    const got = readScannedBank({ ...GOOD, lines: rows });
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(judged(landed(dl.lines))).toEqual(judged(got.lines));
    // And it is a real battery, not an empty one that passes for being empty.
    expect(got.lines.length).toBeGreaterThan(15);
    expect(got.returned).toBe(rows.length);
  });

  it("a date nothing reads is still a row the report names, and the two sides still agree", () => {
    const got = readScannedBank({ ...GOOD, lines: [{ date: "09/31/26", description: "CARD PURCHASE HARROWGATE FUEL", money_out: 142.08, money_in: null }, ...GOOD.lines.slice(1)] });
    const dl = readBankTable(got.table, "September.pdf", hash)!;
    expect(dl.skipped[0].why).toContain("didn't read as a day");
    expect(judged(landed(dl.lines))).toEqual(judged(got.lines));
  });
});

/**
 * A CARD'S BALANCE IS WHAT IS OWED, SO IT WALKS THE OTHER WAY.
 *
 * This lane is offered for cards in as many words (SCAN_KIND_SYSTEM: "a bank's or card company's
 * statement"), and the walk had the deposit-account identity only — so a perfectly read card month was
 * refused "$709.38 over" on a paper with no error on it, and "Drop it again" bought a fresh Opus read
 * to print the same sentence. $709.38 is 2 x (payments - purchases): the asset identity applied to a
 * liability. Nothing on the paper is out by that.
 */
describe("a credit-card statement: the balance walks the way a card's balance walks", () => {
  /** Previous 1,200.00 owed; one payment of 1,200.00 in; purchases of 845.31 out; new balance 845.31. */
  const CARD = {
    account_kind: "card",
    beginning_balance: 1200.0,
    ending_balance: 845.31,
    deposits_total: 1200.0,
    withdrawals_total: 845.31,
    account_last4: "9921",
    lines: [
      { date: "2026-09-04", description: "PAYMENT - THANK YOU", money_out: null, money_in: 1200.0 },
      { date: "2026-09-11", description: "HARROWGATE FUEL", money_out: 312.44, money_in: null },
      { date: "2026-09-19", description: "WESTMERE HARDWARE", money_out: 532.87, money_in: null },
    ],
  };

  it("a card month read perfectly PASSES, and the report says which way it was walked", () => {
    const { got, check } = gate(CARD);
    expect(got.controls.account).toBe("card");
    expect(got.lines).toHaveLength(3);
    expect(check.pass).toBe(true);
    expect(check.failed).toEqual([]);
    expect(scanCheckSaid(check)).toContain("a card's balance: what you owe");
  });

  it("a card the reader forgot to name is still read right, because its own totals pinned every line", () => {
    // No account_kind at all: the deposit walk fails, the card walk holds, and both printed totals
    // already agreed — so the only thing the other direction can mean is a balance that is owed.
    const { got, check } = gate({ ...CARD, account_kind: null });
    expect(got.controls.account).toBe(null);
    expect(check.pass).toBe(true);
    expect(scanCheckSaid(check)).toContain("a card's balance: what you owe");
  });

  it("a card with a line missed is still refused: the direction is not a way to pass", () => {
    const short = { ...CARD, lines: CARD.lines.filter((l) => l.money_out !== 532.87) };
    const { check } = gate(short);
    expect(check.pass).toBe(false);
    expect(check.failed.map((f) => f.which)).toEqual(["withdrawals", "balance"]);
    expect(scanRefusalSaid("Card.pdf", check)).toContain("$532.87 short");
  });

  it("the card refusal says it read it as a card, in a card's own words", () => {
    const { check } = gate({ ...CARD, ending_balance: 900.0 });
    expect(check.pass).toBe(false);
    const said = scanRefusalSaid("Card.pdf", check);
    expect(said).toContain("this reads as a card");
    expect(said).toContain("$845.31 charged");
    expect(said).toContain("$1,200.00 paid");
  });

  /**
   * AND THE OTHER DIRECTION IS NEVER TAKEN WHEN THE PAPER PRINTS NO TOTALS. A read with every sign
   * inverted satisfies the liability identity, so accepting either direction with nothing to pin the
   * sides would wave through exactly the failure the balance walk exists to catch.
   */
  it("every sign inverted, no printed totals: the balance walk still refuses it", () => {
    const flipped = {
      account_kind: null,
      beginning_balance: 1284.55,
      ending_balance: 2505.56,
      deposits_total: null,
      withdrawals_total: null,
      account_last4: "4417",
      lines: GOOD.lines.map((l) => ({ date: l.date, description: l.description, money_out: l.money_in, money_in: l.money_out })),
    };
    const { check } = gate(flipped);
    expect(check.pass).toBe(false);
    expect(check.failed.map((f) => f.which)).toEqual(["balance"]);
  });

  it("a checking statement is never read as a card just because the word appears on a line", () => {
    // Every GOOD line is a debit-card line on a checking statement; the walk stays a deposit's.
    const { got, check } = gate(GOOD);
    expect(got.controls.account).toBe(null);
    expect(check.agreed).toContain("the balance from end to end");
    expect(scanCheckSaid(check)).not.toContain("what you owe");
  });
});

/**
 * AN OVERDRAWN STATEMENT PRINTS A MINUS, AND THE SENTENCE HAS TO MATCH THE PAPER HE IS HOLDING.
 *
 * The balances were printed through a magnitude formatter, so "-$300.00 to start" read as "$300.00 to
 * start", "makes $200.00 ... ends at $190.00" read as OVER while the sentence said short, and none of
 * the three figures was on his statement. This sentence exists only so a person can go and find the
 * line.
 */
describe("signs on the page: a balance keeps its own", () => {
  const OVERDRAWN = {
    beginning_balance: -300.0,
    ending_balance: -200.0,
    deposits_total: 200.0,
    withdrawals_total: 100.0,
    account_last4: "4417",
    lines: [
      { date: "2026-09-04", description: "DEPOSIT INVOICE PAYMENT", money_out: null, money_in: 200.0 },
      { date: "2026-09-09", description: "MONTHLY SERVICE CHARGE", money_out: 100.0, money_in: null },
    ],
  };

  it("an overdrawn account that balances passes, as it always should have", () => {
    const { check } = gate(OVERDRAWN);
    expect(check.pass).toBe(true);
  });

  it("an overdrawn account that does not balance says the figures the paper prints", () => {
    const { check } = gate({ ...OVERDRAWN, ending_balance: -210.0 }); // the paper walks to -$200.00
    expect(check.pass).toBe(false);
    const said = check.failed[0].said;
    expect(said).toContain("-$300.00 to start");
    expect(said).toContain("makes -$200.00");
    expect(said).toContain("ends at -$210.00");
    expect(said).toContain("$10.00 over");
    // THE MAGNITUDES KEEP NO SIGN: what went in and what went out are quantities, not balances.
    expect(said).toContain("$200.00 in and $100.00 out");
  });

  it("a balance that crosses zero reads right in both directions", () => {
    const { check } = gate({ ...OVERDRAWN, beginning_balance: 50.0, ending_balance: -140.0, deposits_total: null, withdrawals_total: 100.0, lines: [{ date: "2026-09-09", description: "MONTHLY SERVICE CHARGE", money_out: 100.0, money_in: null }] });
    expect(check.pass).toBe(false);
    expect(check.failed[0].said).toContain("$50.00 to start");
    expect(check.failed[0].said).toContain("makes -$50.00");
    expect(check.failed[0].said).toContain("ends at -$140.00");
  });
});

/**
 * A CUT-OFF ANSWER IS CLOSED IN CODE. It cannot go to the JSON repair model: a 16,000-token answer has
 * to be re-emitted whole and no repair budget holds it, so the repair stopped at its own cap and threw
 * "too large to repair" before one line had been kept — which made the continuation this lane is built
 * around unreachable, and printed "it got 0 and the statement goes on" for every long statement.
 */
describe("closing a cut-off answer, with no model and nothing invented", () => {
  const whole = (lines: number) => ({
    account_kind: "deposit",
    beginning_balance: 1284.55,
    ending_balance: 2505.56,
    deposits_total: 3437.42,
    withdrawals_total: 2216.41,
    account_last4: "4417",
    lines: Array.from({ length: lines }, (_, i) => ({ date: "2026-09-02", description: `CARD PURCHASE ${i}`, money_out: 1.0, money_in: null })),
  });

  it("cuts back to the last whole line and keeps every one before it", () => {
    const text = JSON.stringify(whole(40));
    // Cut in the middle of the 31st line's description: a real max_tokens stop, byte for byte.
    const at = text.indexOf("CARD PURCHASE 30") + 8;
    const closed = closeCutJson(text.slice(0, at));
    expect(closed).not.toBeNull();
    const got = readScannedBank(JSON.parse(closed!));
    expect(got.lines).toHaveLength(30);
    // THE CONTROL FIGURES COME FIRST IN THE ASKED-FOR SHAPE, so a cut can never disarm the gate.
    expect(got.controls).toMatchObject({ beginning: 128455, ending: 250556, deposits: 343742, withdrawals: 221641 });
    expect(got.last4).toBe("4417");
  });

  it("an answer that was not cut at all comes back whole, and prose after it is dropped", () => {
    const text = JSON.stringify(whole(3));
    expect(JSON.parse(closeCutJson(text)!)).toEqual(JSON.parse(text));
    expect(JSON.parse(closeCutJson(`Here you go:\n${text}\n\nI hope {that} helps.`)!)).toEqual(JSON.parse(text));
  });

  it("a brace or a bracket inside a description is never mistaken for the shape", () => {
    const text = JSON.stringify({
      ...whole(0),
      lines: [
        { date: "2026-09-02", description: 'WESTMERE {HARDWARE} [#12] 6" PIPE', money_out: 12.0, money_in: null },
        { date: "2026-09-03", description: "NEXT ONE", money_out: 3.0, money_in: null },
      ],
    });
    const closed = closeCutJson(text.slice(0, text.indexOf("NEXT ONE") + 4));
    const got = readScannedBank(JSON.parse(closed!));
    expect(got.lines).toHaveLength(1);
    expect(got.lines[0].description).toBe('WESTMERE {HARDWARE} [#12] 6" PIPE');
  });

  it("a cut so early that nothing closed says so rather than guessing", () => {
    expect(closeCutJson('{"beginning_balance": 1284.55, "lines": [{"date": "2026-')).toBeNull();
    expect(closeCutJson("I am looking at the pages")).toBeNull();
    expect(closeCutJson("")).toBeNull();
  });

  it("the cap on what may be sent is the transport's, not the reader's", () => {
    // 3 MB of file is 4 MB of base64, under the ~4.5 MB a server function accepts. 8 MB was 10.7.
    expect(SCAN_MAX_BYTES).toBe(3 * 1024 * 1024);
    expect(Math.ceil((SCAN_MAX_BYTES * 4) / 3)).toBeLessThan(4.5 * 1000 * 1000);
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
    expect(said).toContain("it got 250 lines");
  });

  /**
   * AND IT NEVER NAMES THE ONE ACTION THE GATE IS BUILT TO REFUSE. It used to say "Save it as two
   * shorter PDFs (the first pages, then the rest) and drop each one" — but a statement's printed
   * beginning balance, ending balance and totals describe the WHOLE month, so the first half arrives
   * with half the lines and all of the totals and is refused "$20,500.00 short". Dropping it again
   * gives a byte-identical refusal. That is a dead end wearing a sentence.
   */
  it("the way out of a too-long statement is one that works, not the split the gate refuses", () => {
    const said = scanTruncatedSaid("September.pdf", 250);
    expect(said).not.toContain("two shorter PDFs");
    expect(said).not.toMatch(/split|the first pages/i);
    // A file from the bank has no length limit at all, and the + button keeps the paper regardless.
    expect(said).toContain("CSV or OFX");
    expect(said).toContain("+ button");
  });

  it("a count it does not have is left out rather than printed as zero", () => {
    // "it got 0 and the statement goes on" was shown for EVERY long statement while the continuation
    // was unreachable. A count of nothing is not a fact worth saying.
    const none = scanTruncatedSaid("September.pdf", 0);
    expect(none).not.toContain("0");
    expect(none).toContain("more lines on it than the reader can hand back in one go.");
    expect(scanTruncatedSaid("September.pdf", 1)).toContain("it got 1 line and");
  });

  it("a read the clock ended says so, and names one action then the fallback", () => {
    const said = scanTooSlowSaid("September.pdf");
    expect(said).toContain("time one read gets ran out");
    expect(said).toContain("nothing was added");
    expect(said).toContain("Drop it again");
    expect(said).toContain("+ button");
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
