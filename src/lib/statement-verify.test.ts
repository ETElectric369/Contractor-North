import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseCSV } from "./csv";
import { balanceChain, chainSaid, checkScanTotals, verifySaid, verifyStatement, type ChainLine, type ScanControls } from "./statement-verify";
import { looksLikeBankTable, readBankTable } from "./bank-download";
import { findHeaderRow, readHeaderRow, readOpenListTable } from "./supplier-open-list";
import { readOfx } from "./ofx-read";

/**
 * EVERY LINE PROVES THE ONE BEFORE IT (2026-10-02).
 *
 * Erik, after cn-v1050 put a totals check on the scanned-statement path only: "I imagine everything
 * will get verified with the reconcile anyway no matter what document is input correct, the way that
 * the PDF needs his own verification system — is there a second one for all of it as I'm imagining
 * there is?" There wasn't. This is it, and the check he described is the better of the two: it works on
 * every source, it catches two errors that CANCEL out of a totals check, and it names a LINE.
 *
 * EVERY FIGURE AND NAME BELOW IS INVENTED. No bank, supplier, customer or account on this page exists;
 * the amounts were made up and then walked by hand so the chains in them actually add up.
 */

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * ONE CORRECT MONTH, AS THE CHAIN SEES IT: oldest first, a balance after every line, and every balance
 * is the one above it plus that line's money. Opening balance $4,000.00.
 *
 *   Sep 2   -142.08  →  3857.92
 *   Sep 5   -1250.00 →  2607.92
 *   Sep 8   +3400.00 →  6007.92
 *   Sep 12  -812.33  →  5195.59
 *   Sep 19  +37.42   →  5233.01
 *   Sep 30  -12.00   →  5221.01
 */
const MONTH: ChainLine[] = [
  { row: 2, postedOn: "2026-09-02", cents: -14208, balanceAfterCents: 385792 },
  { row: 3, postedOn: "2026-09-05", cents: -125000, balanceAfterCents: 260792 },
  { row: 4, postedOn: "2026-09-08", cents: 340000, balanceAfterCents: 600792 },
  { row: 5, postedOn: "2026-09-12", cents: -81233, balanceAfterCents: 519559 },
  { row: 6, postedOn: "2026-09-19", cents: 3742, balanceAfterCents: 523301 },
  { row: 7, postedOn: "2026-09-30", cents: -1200, balanceAfterCents: 522101 },
];

/** The same month's own printed control figures, which a statement prints and a download does not. */
const CONTROLS: ScanControls = { beginning: 400000, ending: 522101, deposits: 343742, withdrawals: 221641, account: "deposit" };

describe("the chain: a correct file passes, and says how much it checked", () => {
  it("every link adds up, and the sentence says so in plain words", () => {
    const c = balanceChain(MONTH);
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.links).toBe(5);
    expect(c.lines).toBe(6);
    expect(c.withBalance).toBe(6);
    expect(c.reversed).toBe(false);
    expect(c.card).toBe(false);
    expect(c.sameDay).toBe(0);
    const said = chainSaid(c);
    expect(said).toContain("proves every line");
    expect(said).toContain("5 links across 6 lines");
  });

  it("A LINE MISSING names the line it broke at, its day, and the amount", () => {
    // The Sep 5 check never read. Sep 8's printed balance is then $1,250.00 further down than the
    // walk from Sep 2 can reach.
    const short = MONTH.filter((l) => l.cents !== -125000);
    const c = balanceChain(short);
    expect(c.ran).toBe(true);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toEqual({ row: 4, day: "2026-09-08", offByCents: 125000 });
    const said = chainSaid(c);
    expect(said).toContain("line 4 (Sep 8)");
    expect(said).toContain("$1,250.00");
    expect(said).toContain("missing, in twice");
  });

  it("A LINE IN TWICE breaks the day it sits on, by the line's own amount", () => {
    const twice = [MONTH[0], MONTH[1], { ...MONTH[1], row: 99 }, ...MONTH.slice(2)];
    const c = balanceChain(twice);
    expect(c.breaks).toHaveLength(1);
    // Named by the FIRST line of the day it broke on: that is where a person starts looking.
    expect(c.breaks[0]).toMatchObject({ row: 3, day: "2026-09-05", offByCents: 125000 });
  });

  it("A WRONG AMOUNT is caught to the cent", () => {
    const off = MONTH.map((l) => (l.row === 5 ? { ...l, cents: -81243 } : l));
    const c = balanceChain(off);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 5, offByCents: 10 });
  });

  it("A FLIPPED SIGN is caught, by twice the line", () => {
    const flipped = MONTH.map((l) => (l.row === 6 ? { ...l, cents: -3742 } : l));
    const c = balanceChain(flipped);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 6, offByCents: 2 * 3742 });
  });

  it("the FIRST break is said in full and the rest are counted, never listed", () => {
    // Two lines read wrong, far apart. One sentence, one line to go and look at, and a count.
    const two = MONTH.map((l) => (l.row === 3 ? { ...l, cents: -125100 } : l.row === 6 ? { ...l, cents: 3842 } : l));
    const c = balanceChain(two);
    expect(c.breaks.map((b) => b.row)).toEqual([3, 6]);
    const said = chainSaid(c);
    expect(said).toContain("line 3 (Sep 5)");
    expect(said).toContain("One more link");
    expect(said).not.toContain("line 6 (");
  });

  it("MANY BREAKS keep only a few, and still count them all: this verdict is stored on the row", () => {
    // A column that walks for one link and then goes wrong on every line after. Only the first few
    // breaks are kept (a jsonb column is not a place for thousands of them) and the count is honest.
    const wrong: ChainLine[] = [
      { row: 2, postedOn: "2026-09-01", cents: -1000, balanceAfterCents: 99000 },
      { row: 3, postedOn: "2026-09-02", cents: -1000, balanceAfterCents: 98000 },
      ...Array.from({ length: 12 }, (_, n) => ({ row: 4 + n, postedOn: `2026-09-${String(4 + n).padStart(2, "0")}`, cents: -1000, balanceAfterCents: 50000 + n })),
    ];
    const c = balanceChain(wrong);
    expect(c.ran).toBe(true);
    expect(c.broke).toBe(12);
    expect(c.breaks).toHaveLength(5);
    expect(chainSaid(c)).toContain("11 more links");
  });
});

/**
 * THE TEST THAT PROVES THE LANE WAS WORTH DOING. A totals check passes when two errors cancel; a chain
 * cannot, because it holds every line against the one before it rather than against a grand total.
 */
describe("two errors that cancel: the totals agree and the chain still catches it", () => {
  // $10.00 taken off the Sep 5 check and put onto the Sep 12 card payment. Money out is unchanged, so
  // every printed total still agrees to the cent, and so does the balance from end to end.
  const cancelled: ChainLine[] = MONTH.map((l) => (l.row === 3 ? { ...l, cents: -124000 } : l.row === 5 ? { ...l, cents: -82233 } : l));

  it("the printed totals see nothing wrong at all", () => {
    const totals = checkScanTotals(cancelled, CONTROLS);
    expect(totals.pass).toBe(true);
    expect(totals.failed).toEqual([]);
    expect(totals.agreed).toEqual(["the money going out", "the money coming in", "the balance from end to end"]);
  });

  it("the chain breaks at both of them, and names the first", () => {
    const c = balanceChain(cancelled);
    expect(c.breaks.map((b) => [b.row, b.offByCents])).toEqual([
      [3, 1000],
      [5, 1000],
    ]);
    expect(chainSaid(c)).toContain("line 3 (Sep 5)");
  });

  it("and the one verification refuses the read on the strength of the chain alone", () => {
    const v = verifyStatement({ lines: cancelled, source: "picture", controls: CONTROLS });
    expect(v.pass).toBe(false);
    expect(v.failed[0].which).toBe("chain");
    expect(v.failed[0].said).toContain("line 3 (Sep 5)");
    // And the sentence does NOT say the printed figures cleared it, which they did.
    expect(verifySaid(v)).toContain("stops adding up");
  });
});

describe("order: a file listed newest-first is not a broken file", () => {
  it("the same month in reverse passes, and the report says which way round it is", () => {
    const c = balanceChain([...MONTH].reverse());
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.reversed).toBe(true);
    expect(chainSaid(c)).toContain("newest first");
  });

  it("A GENUINELY BROKEN FILE IS NOT REPAIRED BY TRYING BOTH WAYS ROUND", () => {
    // The one thing a two-way walk must never do: pass a file with a line missing because the other
    // direction happened to complain less. A shape has to explain EVERY link to be believed.
    const broken = MONTH.filter((l) => l.cents !== -125000);
    for (const lines of [broken, [...broken].reverse()]) {
      const c = balanceChain(lines);
      expect(c.ran).toBe(true);
      expect(c.breaks).toHaveLength(1);
      expect(c.breaks[0].offByCents).toBe(125000);
    }
  });

  it("A MONTH ALL ON ONE DAY still has its links walked: date order never decides the order", () => {
    const oneDay: ChainLine[] = [
      { row: 2, postedOn: "2026-09-04", cents: -2000, balanceAfterCents: 98000 },
      { row: 3, postedOn: "2026-09-04", cents: -1500, balanceAfterCents: 96500 },
      { row: 4, postedOn: "2026-09-04", cents: 5000, balanceAfterCents: 101500 },
    ];
    const c = balanceChain(oneDay);
    expect(c.ran).toBe(true);
    expect(c.links).toBe(2);
    expect(c.breaks).toEqual([]);
    expect(c.sameDay).toBe(0);
  });
});

describe("a card's balance is what you owe, so the walk runs the other way", () => {
  // A card export, oldest first: a purchase RAISES what is owed and the payment lowers it.
  const CARD: ChainLine[] = [
    { row: 2, postedOn: "2026-09-03", cents: -6210, balanceAfterCents: 46210 },
    { row: 3, postedOn: "2026-09-09", cents: -14500, balanceAfterCents: 60710 },
    { row: 4, postedOn: "2026-09-18", cents: 50000, balanceAfterCents: 10710 },
    { row: 5, postedOn: "2026-09-27", cents: -3300, balanceAfterCents: 14010 },
  ];

  it("it passes, and the sentence says which balance this is", () => {
    const c = balanceChain(CARD);
    expect(c.ran).toBe(true);
    expect(c.card).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(chainSaid(c)).toContain("what you owe");
  });

  it("and a line missing off a card is still caught", () => {
    const c = balanceChain(CARD.filter((l) => l.row !== 3));
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ row: 4, offByCents: 14500 });
  });
});

/**
 * SAME-DAY LINES, AND WHY A CHECK THAT CRIES WOLF IS WORSE THAN NONE. Several transactions on one day
 * may be printed in an order they did not post in, so the running balance beside them looks out of
 * step on a file with no error in it at all. The day's NET is what the balance column proves, so a day
 * whose lines don't walk one by one is held to its own net instead — and said as that.
 */
describe("same-day lines printed out of posting order raise no false alarm", () => {
  // Sep 12 posted -200.00 then -50.00 (balances 1800.00 then 1750.00) and is PRINTED the other way up.
  const SAME_DAY: ChainLine[] = [
    { row: 2, postedOn: "2026-09-11", cents: -10000, balanceAfterCents: 200000 },
    { row: 3, postedOn: "2026-09-12", cents: -5000, balanceAfterCents: 175000 },
    { row: 4, postedOn: "2026-09-12", cents: -20000, balanceAfterCents: 180000 },
    { row: 5, postedOn: "2026-09-15", cents: 30000, balanceAfterCents: 205000 },
  ];

  it("no break, and the report says one day was settled as a day", () => {
    const c = balanceChain(SAME_DAY);
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.sameDay).toBe(1);
    expect(chainSaid(c)).toContain("settled as a day");
  });

  it("but a line MISSING out of that same day is still caught, because the day's net is wrong", () => {
    const c = balanceChain(SAME_DAY.filter((l) => l.row !== 4));
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]).toMatchObject({ day: "2026-09-12", offByCents: 20000 });
  });

  /**
   * THE CORNER THAT HAS TO SAY NOTHING. A file that OPENS on a multi-line day printed out of posting
   * order has no balance before that day to hold its net against, and which of the day's printed
   * balances is its close is exactly what is unknown. So that day goes unchecked and the walk starts
   * again at the next one — rather than reporting a figure worked out from a missing one, which is the
   * "something wrong" this check exists to say nothing instead of.
   */
  it("A FILE THAT OPENS ON AN OUT-OF-ORDER DAY checks the rest and claims nothing about that day", () => {
    const opens = SAME_DAY.slice(1); // the Sep 12 pair first, then Sep 15
    const c = balanceChain(opens);
    expect(c.ran).toBe(true);
    expect(c.breaks).toEqual([]);
    expect(c.lines).toBe(3);
    // Only the Sep 12 → Sep 15 link could be walked, from the balance the file prints on Sep 12's last
    // line — and the coverage figure says so rather than implying the whole file was proved.
    expect(c.links).toBe(1);
    expect(chainSaid(c)).toContain("1 link across 3 lines");
  });
});

describe("nothing to check against is said out loud, never claimed either way", () => {
  it("NO BALANCE COLUMN AT ALL: it could not run, and nothing says it did", () => {
    const none = MONTH.map((l) => ({ ...l, balanceAfterCents: null }));
    const c = balanceChain(none);
    expect(c.ran).toBe(false);
    expect(c.links).toBe(0);
    expect(c.why).toContain("prints no running balance");
    const said = chainSaid(c);
    expect(said).toContain("prints no running balance beside its lines");
    expect(said).not.toContain("proves every line");
    const v = verifyStatement({ lines: none, source: "rows" });
    expect(v.pass).toBe(true); // a check that could not run never fails a read
    expect(verifySaid(v)).toContain("the file's own rows");
  });

  it("A PARTIAL COLUMN checks the links it can and says how many out of how many lines", () => {
    // Two lines carry no balance (a pending line, a line the bank left out of its column). The walk
    // stops at each of them and starts again at the next line that has one.
    const partial = MONTH.map((l) => (l.row === 4 || l.row === 7 ? { ...l, balanceAfterCents: null } : l));
    const c = balanceChain(partial);
    expect(c.ran).toBe(true);
    expect(c.withBalance).toBe(4);
    expect(c.links).toBe(2);
    expect(c.lines).toBe(6);
    expect(c.breaks).toEqual([]);
    expect(chainSaid(c)).toContain("2 links across 6 lines");
  });

  it("ONE LINE WITH A BALANCE is no chain at all", () => {
    const one = MONTH.map((l, i) => (i === 0 ? l : { ...l, balanceAfterCents: null }));
    expect(balanceChain(one).why).toContain("only one of its lines carries a running balance");
  });

  it("A 'Balance' COLUMN THAT ISN'T A RUNNING BALANCE says nothing rather than something wrong", () => {
    // What a supplier's own open list prints beside its papers: each row's own balance, not the
    // account's. Nothing walks, so the chain keeps quiet instead of reporting five breaks.
    const openItems: ChainLine[] = [
      { row: 2, postedOn: "2026-08-14", cents: -41055, balanceAfterCents: 41055 },
      { row: 3, postedOn: "2026-08-29", cents: -12200, balanceAfterCents: 12200 },
      { row: 4, postedOn: "2026-09-08", cents: -90410, balanceAfterCents: 90410 },
      { row: 5, postedOn: "2026-09-19", cents: -7733, balanceAfterCents: 7733 },
    ];
    const c = balanceChain(openItems);
    expect(c.ran).toBe(false);
    expect(c.why).toContain("isn't a running account balance");
    expect(chainSaid(c)).not.toContain("stops adding up");
  });
});

/**
 * THE THREE OUTCOMES, AND THE CLAUSE THAT SAYS HOW HARD TO LOOK (Erik, on the tiers of reliability).
 * It is one short clause, after the fact, with nothing to decide — never a menu.
 */
describe("the one read report", () => {
  it("checked and agrees", () => {
    const said = verifySaid(verifyStatement({ lines: MONTH, source: "rows", controls: CONTROLS }));
    expect(said).toContain("agree to the cent");
    expect(said).toContain("proves every line");
    expect(said).toContain("Read from the file's own rows.");
  });

  it("checked and names where it broke", () => {
    const v = verifyStatement({ lines: MONTH.filter((l) => l.cents !== -125000), source: "page" });
    expect(verifySaid(v)).toContain("stops adding up at line 4 (Sep 8), by $1,250.00");
    expect(verifySaid(v)).toContain("Read off the page itself.");
  });

  it("nothing to check it against, said out loud, with one next action", () => {
    const blind = MONTH.map((l) => ({ ...l, balanceAfterCents: null }));
    const nothing: ScanControls = { beginning: null, ending: null, deposits: null, withdrawals: null, account: null };
    const said = verifySaid(verifyStatement({ lines: blind, source: "picture", controls: nothing }));
    // cn-v1050's own sentence, word for word, because it still applies here.
    expect(said).toContain("prints no totals to hold the read against");
    expect(said).toContain("NOTHING here checked it");
    expect(said).toContain("Read from a picture of the page.");
  });

  it("a paper with no totals whose CHAIN held is never told that nothing checked it", () => {
    const nothing: ScanControls = { beginning: null, ending: null, deposits: null, withdrawals: null, account: null };
    const said = verifySaid(verifyStatement({ lines: MONTH, source: "picture", controls: nothing }));
    expect(said).toContain("prints no totals to hold the read against");
    expect(said).not.toContain("NOTHING here checked it");
    expect(said).toContain("proves every line");
  });
});

// ── EVERY DOOR, AND THE TEETH THAT KEEP IT THAT WAY ────────────────────────────────────────────

/** A bank's CSV with a running balance down the side, oldest first. Opening balance $4,000.00. */
const WALKS_CSV = `Date,Description,Amount,Balance
09/02/2026,CARD PURCHASE HARROWGATE FUEL,-142.08,3857.92
09/05/2026,CHECK 1042,-1250.00,2607.92
09/08/2026,DEPOSIT,3400.00,6007.92
09/12/2026,ACH WESTMERE CARD SERVICES,-812.33,5195.59
09/19/2026,REFUND WESTMERE HARDWARE,37.42,5233.01
09/30/2026,MONTHLY SERVICE CHARGE,-12.00,5221.01
`;

describe("the reader carries the balance, and verifies what it read before it hands it back", () => {
  it("a CSV's running balance lands on every line, in cents", () => {
    const dl = readBankTable(parseCSV(WALKS_CSV), "Checking.csv", hash)!;
    expect(dl.lines.map((l) => l.balanceAfterCents)).toEqual([385792, 260792, 600792, 519559, 523301, 522101]);
    expect(dl.verified?.chain.ran).toBe(true);
    expect(dl.verified?.chain.breaks).toEqual([]);
    expect(dl.readSaid).toContain("proves every line");
    expect(dl.readSaid).toContain("Read from the file's own rows.");
  });

  it("A BREAK ON A STRUCTURED FILE WARNS, it does not refuse: the rows are still the bank's own", () => {
    const missing = WALKS_CSV.split("\n").filter((l) => !l.includes("CHECK 1042")).join("\n");
    const dl = readBankTable(parseCSV(missing), "Checking.csv", hash)!;
    // The download exists, with all of its lines on it — the card is where a person confirms them.
    expect(dl.lines).toHaveLength(5);
    expect(dl.verified?.pass).toBe(false);
    // Line 3 of THIS file: the row number is where it is in the file in front of him, not where it
    // would have been had the missing line been there.
    expect(dl.readSaid).toContain("stops adding up at line 3 (Sep 8), by $1,250.00");
  });

  it("no balance column: the download still lands and the report says nothing walked it", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/02/2026,HARROWGATE FUEL,-142.08\n09/05/2026,CHECK 1042,-1250.00\n`), "x.csv", hash)!;
    expect(dl.lines.every((l) => l.balanceAfterCents === null)).toBe(true);
    expect(dl.verified?.chain.ran).toBe(false);
    expect(dl.readSaid).toContain("prints no running balance");
  });

  it("AN OFX CARRIES NO PER-LINE BALANCE, and the report says so rather than implying a check", () => {
    // OFX's own shape: a <STMTTRN> has a date, an amount, a payee and an id, and no balance at all.
    // (A <LEDGERBAL> is the account's closing figure, not one per line.)
    const ofx = readOfx(
      `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>XXXXX4417</BANKACCTFROM><BANKTRANLIST>` +
        `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902120000<TRNAMT>-142.08<FITID>T1<NAME>HARROWGATE FUEL</STMTTRN>` +
        `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260908120000<TRNAMT>3400.00<FITID>T2<NAME>DEPOSIT</STMTTRN>` +
        `</BANKTRANLIST><LEDGERBAL><BALAMT>5221.01</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
      "Checking.qfx",
    );
    expect(ofx.ok).toBe(true);
    expect(ofx.ok && ofx.rows[0]).not.toContain("Balance");
    const dl = readBankTable((ofx as { rows: string[][] }).rows, "Checking.qfx", hash)!;
    expect(dl.lines).toHaveLength(2);
    expect(dl.lines.every((l) => l.balanceAfterCents === null)).toBe(true);
    expect(dl.readSaid).toContain("prints no running balance beside its lines");
    expect(dl.readSaid).toContain("Read from the file's own rows.");
  });

  it("A SUPPLIER'S OPEN LIST WITH A Balance COLUMN NEVER GETS A BANK CHAIN RUN ON IT", () => {
    // Its "Balance" is what is open on each paper, not an account's running balance. It is not a bank
    // table at all (bank-download.ts keeps "balance" out of the words only a bank prints), so it goes
    // to the supplier reader and no chain is ever walked over it.
    const list = `Invoice,Invoice Date,Due Date,Amount,Balance\nINV-4011,08/14/2026,09/13/2026,410.55,410.55\nINV-4066,08/29/2026,09/28/2026,122.00,122.00\nINV-4120,09/08/2026,10/08/2026,904.10,904.10\n`;
    const table = parseCSV(list);
    const at = findHeaderRow(table);
    const hasRef = at >= 0 && readHeaderRow(table[at] ?? []).columns.reference !== undefined;
    expect(hasRef).toBe(true);
    expect(looksLikeBankTable(table, hasRef)).toBe(false);
    expect(readBankTable(table, "Statement.csv", hash)).toBeNull();
    // And it reads as the supplier's list it is.
    const read = readOpenListTable({ table, from: "file", name: "Statement.csv", listDate: "2026-09-26", listDateFrom: "file" });
    expect(read.ok).toBe(true);
  });

  it("a person's Swap re-verifies: the sentence beside Apply always describes the lines under it", async () => {
    const { swapDownloadSigns } = await import("./bank-download");
    const dl = readBankTable(parseCSV(WALKS_CSV), "Checking.csv", hash)!;
    const swapped = swapDownloadSigns(dl, hash);
    // The file didn't change, so its printed balance didn't either — the walk simply comes out as a
    // balance that is what you OWE, and still proves every line.
    expect(swapped.lines.map((l) => l.balanceAfterCents)).toEqual(dl.lines.map((l) => l.balanceAfterCents));
    expect(swapped.verified?.chain.ran).toBe(true);
    expect(swapped.verified?.chain.card).toBe(true);
    expect(swapped.readSaid).toContain("what you owe");
    expect(swapped.readSaid).not.toBe(dl.readSaid);
  });
});

/**
 * THE TEETH. A rule fixed at one door while another keeps the old behaviour is the bug this repo keeps
 * shipping, so these two hold the whole app to it: there is ONE place a bank download becomes a stored
 * card, and every door that reads one SAYS how it read it. A new door that forgets fails here.
 */
describe("the teeth: no door makes a bank download without asking the one verification", () => {
  const sourceFiles = async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(process.cwd(), "src");
    const out: { file: string; text: string }[] = [];
    const walkDir = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walkDir(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push({ file: path.relative(root, full), text: readFileSync(full, "utf8") });
      }
    };
    walkDir(root);
    return out;
  };

  /** The arguments of the call that starts at `open`, split at the commas between them. */
  const argsAt = (text: string, open: number): string[] => {
    let depth = 0;
    const args: string[] = [];
    let start = open + 1;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          args.push(text.slice(start, i));
          break;
        }
      } else if (ch === "," && depth === 1) {
        args.push(text.slice(start, i));
        start = i + 1;
      }
    }
    return args.map((a) => a.trim()).filter(Boolean);
  };

  it("every call that reads a bank download says how the file was read", async () => {
    const files = await sourceFiles();
    // A real sweep, not an empty one that passes for being empty.
    expect(files.length).toBeGreaterThan(300);
    const silent: string[] = [];
    let seen = 0;
    for (const { file, text } of files) {
      for (const m of [...text.matchAll(/\breadBankTable\s*\(/g), ...text.matchAll(/\breadBankDownload\s*\(/g)]) {
        // The declarations themselves are not calls.
        if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
        seen++;
        const args = argsAt(text, m.index + m[0].length - 1);
        const needs = m[0].startsWith("readBankTable") ? 4 : 3;
        if (args.length < needs) silent.push(`${file} → ${m[0]}…) with ${args.length} arguments`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(silent).toEqual([]);
  });

  it("a bank download becomes a stored card in exactly ONE place, and that place asks the verification", async () => {
    const files = await sourceFiles();
    const makers = files.filter(({ text }) => /\bcreateBankPaper\s*\(/.test(text) && !/export async function createBankPaper/.test(text)).map((f) => f.file);
    expect(makers).toEqual(["app/(app)/bills/open-list-add-core.ts"]);
    const maker = files.find((f) => f.file === makers[0])!.text;
    // It gets its download from the one reader, which verifies before it hands anything back, and it
    // composes no sentence of its own: `readSaid` is read off the download, never written onto it.
    expect(maker).toMatch(/readBankDownload\(bankTable, name, bankRead\)/);
    expect(maker).toContain("download.readSaid");
    expect(maker).not.toMatch(/readSaid:/);
  });

  it("and the reader always hands back a verdict and a sentence, whatever it was given", async () => {
    const shapes = [
      WALKS_CSV,
      `Date,Description,Amount\n09/02/2026,HARROWGATE FUEL,-142.08\n`,
      `Post Date,Description,Debit,Credit\n09/02/2026,HARROWGATE FUEL,142.08,\n09/08/2026,DEPOSIT,,3400.00\n`,
      `Date,Description,Amount,Type\n09/02/2026,HARROWGATE FUEL,142.08,Debit\n09/08/2026,DEPOSIT,3400.00,Credit\n`,
    ];
    for (const csv of shapes) {
      const dl = readBankTable(parseCSV(csv), "x.csv", hash)!;
      expect(dl.verified).toBeTruthy();
      expect(String(dl.readSaid ?? "").length).toBeGreaterThan(20);
      expect(dl.readSaid).toContain("Read from the file's own rows.");
    }
  });
});
