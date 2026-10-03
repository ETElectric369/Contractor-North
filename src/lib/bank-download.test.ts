import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCSV } from "@/lib/csv";
// The cost guard's own sentence: the bank card's refusal must BE it, never a second wording.
import { RETURN_ON_JOB_WHY } from "@/lib/job-cost-guard";
import {
  balanceCentsOf,
  bankHeadline,
  bankViewOf,
  billPlacement,
  channelViewOf,
  branchFromNumbers,
  choiceFits,
  choiceId,
  choiceLabel,
  cleanDescription,
  everyChoice,
  findBankHeader,
  flowLabelOf,
  guessFor,
  isBareCheck,
  jobRefusalFor,
  learnableAnswer,
  lookalikePayment,
  lineKeyOf,
  lineNamesAccount,
  looksLikeBankTable,
  merchantKeyOf,
  namesOf,
  parseChoiceId,
  planBankDownload,
  ruleHintFor,
  noLinesSaid,
  sayGroupMoney,
  readBankDate,
  readBankMoney,
  readBankTable,
  redactDigits,
  ruleFor,
  ruleChoice,
  depositKindOf,
  storedAnswer,
  storedChoice,
  storedChoiceName,
  swapDownloadSigns,
  last4FromName,
  withAccountLast4,
  validPicks,
  type BankBooks,
  type BankDownload,
  type BooksPayment,
  type BooksRule,
} from "./bank-download";
import { NOT_SAID } from "./bank-money-in";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findHeaderRow, readHeaderRow } from "./supplier-open-list";
import { readOfx } from "./ofx-read";

/**
 * THE BANK DOWNLOAD, SORTED IN PLAIN CODE (2026-09-27). Every statement here is MADE UP: invented
 * merchants (SHELL 123 ANYTOWN), invented account numbers (XXXXX1234), invented people. Nothing in
 * this file comes from any company's real bank file.
 */

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// A checking download in the shape a community bank's "Download to Excel" gives: account, post
// date, check, description, debit, credit, status, balance. Aug 26 - Sep 25, 2026.
//
// ITS RUNNING BALANCE WALKS, because a real one does (2026-10-02). These figures were invented before
// anything looked at them and did not add up line to line; the chain says so of any such column, and a
// fixture that lies about the shape of a bank download is a trap for whoever reads it next. The file
// lists its lines NEWEST FIRST, which is how most banks hand a month over, so the walk runs up the
// page: every balance is the one above it less that line's money. The pending line's balance is blank,
// which is what a bank prints for money it has not posted.
const CHECKING_CSV = `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance
XXXXX1234,09/25/2026,,MONTHLY SERVICE FEE,12.00,,Posted,8872.47
XXXXX1234,09/24/2026,,DENTAL CARE LLC,150.00,,Posted,8884.47
XXXXX1234,09/23/2026,,1111-HOME HARDWARE #55 ANYTOWN,45.10,,Posted,9034.47
XXXXX1234,09/22/2026,,CONTRACTOR SUPPLY CO PMT CS-12345,1000.00,,Posted,9079.57
XXXXX1234,09/20/2026,,VENMO CASHOUT,,300.00,Posted,10079.57
XXXXX1234,09/18/2026,,STRIPE TRANSFER ST-AB12,,485.40,Posted,9779.57
XXXXX1234,09/16/2026,,1111-SHELL 123 ANYTOWN ST,100.00,,Posted,9294.17
XXXXX1234,09/15/2026,,ATM WITHDRAWAL 000123 MAIN ST,200.00,,Posted,9394.17
XXXXX1234,09/12/2026,,1111-ACME INSURANCE CO,31.90,,Posted,9594.17
XXXXX1234,09/10/2026,,ONLINE TRANSFER TO CHK XXXXXX9876 REF #IB0123456789,2000.00,,Posted,9626.07
XXXXX1234,09/09/2026,,1111-SHELL 456 OTHERTOWN,100.00,,Posted,11626.07
XXXXX1234,09/05/2026,1043,CHECK,640.00,,Posted,11726.07
XXXXX1234,09/04/2026,,DEPOSIT,,1275.00,Posted,12366.07
XXXXX1234,09/02/2026,,1111-SHELL 123 ANYTOWN ST,88.45,,Posted,11091.07
XXXXX1234,09/26/2026,,1111-COFFEE CART,4.50,,Pending,
Total,,,,4367.45,2060.40,,
`;

const ORG_BOOKS = (over: Partial<BankBooks> = {}): BankBooks => ({
  already: new Map(),
  payments: [],
  payPayments: [],
  supplierPayments: [],
  bills: [],
  pettyCash: [],
  accounts: [{ id: "acct-cs", name: "Contractor Supply", number: "CS-12345", branch: null, onAccount: true, aliases: ["CONTRACTOR SUPPLY CO"] }],
  invoices: [],
  crew: [{ id: "crew-pat", name: "Pat Crew" }],
  // Two of the company's jobs, each said the way a picker says one (jobSaidLabel): place, number, who.
  jobs: [
    { id: "job-kitchen", label: "41 Larkspur · J-054 — Marla Finch" },
    { id: "job-shop", label: "12 Thistle Wood · J-055 — Tess Zane" },
  ],
  rules: [],
  crewPaid: [],
  ...over,
});

function download(csv = CHECKING_CSV, name = "Checking.csv"): BankDownload {
  const dl = readBankTable(parseCSV(csv), name, hash);
  if (!dl) throw new Error("fixture did not read as a bank download");
  return dl;
}

const lineBy = (dl: BankDownload, words: string, day?: string) => {
  const l = dl.lines.find((x) => x.description.includes(words) && (!day || x.postedOn === day));
  if (!l) throw new Error(`no line ${words}`);
  return l;
};

describe("reading a bank's download", () => {
  it("finds the header by the words banks print, and reads debit/credit into signed cents", () => {
    const table = parseCSV(CHECKING_CSV);
    expect(findBankHeader(table)).toEqual({ row: 0, columns: { account: 0, date: 1, check: 2, description: 3, debit: 4, credit: 5, status: 6, balance: 7 } });
    const dl = download();
    expect(dl.last4).toBe("1234");
    expect(dl.from).toBe("2026-09-02");
    expect(dl.to).toBe("2026-09-25");
    expect(dl.lines).toHaveLength(14);
    expect(lineBy(dl, "DEPOSIT").cents).toBe(127500);
    expect(lineBy(dl, "DENTAL").cents).toBe(-15000);
    expect(lineBy(dl, "CHECK").check).toBe("1043");
    // A pending line and the total under the table are said by line, never read as money.
    expect(dl.skipped.map((s) => s.line)).toEqual([16, 17]);
    expect(dl.skipped[0].why).toMatch(/Pending/);
    expect(dl.skipped[1].why).toMatch(/No date/);
  });

  it("reads a signed Amount column (a big bank's CSV) and a card export with Transaction and Posted dates", () => {
    const chase = readBankTable(
      parseCSV(`Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,09/03/2026,FUEL STOP 9 ANYTOWN,-55.12,DEBIT_CARD,1200.00,
CREDIT,09/04/2026,REMOTE DEPOSIT,800.00,DEPOSIT,2000.00,
CHECK,09/05/2026,CHECK 2001,-300.00,CHECK_PAID,1700.00,2001
`),
      "chase.csv",
      hash,
    )!;
    expect(chase.lines.map((l) => [l.postedOn, l.cents, l.check])).toEqual([
      ["2026-09-03", -5512, null],
      ["2026-09-04", 80000, null],
      ["2026-09-05", -30000, "2001"],
    ]);
    const card = readBankTable(
      parseCSV(`Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-09-01,2026-09-02,5678,GAS AND GO 12,Gas/Automotive,40.00,
2026-09-03,2026-09-04,5678,PAYMENT THANK YOU,Payment/Credit,,500.00
`),
      "card.csv",
      hash,
    )!;
    // The POSTED day is the bank's day.
    expect(card.lines.map((l) => [l.postedOn, l.cents, l.last4])).toEqual([
      ["2026-09-02", -4000, "5678"],
      ["2026-09-04", 50000, "5678"],
    ]);
  });

  it("reads a bank's own money words: CR is money in, DR money out, a leading + is money in", () => {
    expect(readBankMoney("1500.00 CR")).toBe(1500);
    expect(readBankMoney("45.00 DR")).toBe(-45);
    expect(readBankMoney("+45.00")).toBe(45);
    expect(readBankMoney("+$1,500.00")).toBe(1500);
    expect(readBankMoney("(82.10)")).toBe(-82.1);
    expect(readBankMoney("")).toBeNull();
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/01/2026,CUSTOMER DEPOSIT,1500.00 CR\n09/02/2026,SHOP RENT,650.00 DR\n09/03/2026,REFUND,+200.00\n`), "x.csv", hash)!;
    expect(dl.lines.map((l) => l.cents)).toEqual([150000, -65000, 20000]);
    expect(dl.skipped).toEqual([]);
  });

  /**
   * AND IT READS THEM WITH NO SPACE IN FRONT, which is how plenty of banks print them. There is no word
   * boundary between a digit and a letter, so "100.00CR" matched nothing here and fell through to
   * `readMoney` — the SUPPLIER's reader, where CR is a credit memo — and came back NEGATIVE, which is the
   * exact meaning `balanceCentsOf` routes balance cells through this function to avoid. "400.00DR" has no
   * readMoney rule at all and came back null, a hole in the column. A checking account in credit was then
   * walked as a card and the report said "its balance is what you owe" on a deposit account.
   */
  it("reads CR and DR printed TIGHT against the figure, in an amount cell and a balance cell alike", () => {
    expect(readBankMoney("100.00CR")).toBe(100);
    expect(readBankMoney("400.00DR")).toBe(-400);
    expect(readBankMoney("1,284.55CR")).toBe(1284.55);
    expect(readBankMoney("300.00Dr.")).toBe(-300);
    expect(balanceCentsOf("1,284.55CR")).toBe(128455);
    expect(balanceCentsOf("300.00DR")).toBe(-30000);
    // A correct deposit account printing its balances this way walks as a DEPOSIT account, and the card
    // never tells him a balance he holds is a balance he owes.
    const dl = readBankTable(
      parseCSV(`Post Date,Description,Debit,Credit,Balance\n09/01/2026,CUSTOMER DEPOSIT,,500.00,1000.00CR\n09/02/2026,SHOP RENT,650.00,,350.00CR\n09/03/2026,CARD PURCHASE HARROWGATE FUEL,80.50,,269.50CR\n`),
      "x.csv",
      hash,
    )!;
    expect(dl.lines.map((l) => l.balanceAfterCents)).toEqual([100000, 35000, 26950]);
    expect(dl.verified?.chain.card).toBe(false);
    expect(dl.verified?.chain.breaks).toEqual([]);
    expect(dl.readSaid).not.toContain("what you owe");
  });

  it("reads the days banks print: a time after it, the year first with slashes, the month as a word", () => {
    for (const raw of ["9/3/2026 12:00:00 AM", "9/3/2026 0:00", "2026/09/03", "03-SEP-2026", "3 Sep 2026", "03-Sep-26", "2026-09-03T00:00:00Z", "09/03/2026"]) {
      expect(readBankDate(raw)).toBe("2026-09-03");
    }
    expect(readBankDate("Total")).toBeNull();
  });

  it("a file whose days don't read says so, not that its lines are totals", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n3rd of Sep 2026,SHOP RENT,-650.00\nTotal,,-650.00\n`), "odd.csv", hash)!;
    expect(dl.lines).toHaveLength(0);
    expect(dl.skipped[0].why).toBe('Its date "3rd of Sep 2026" didn\'t read as a day.');
    expect(dl.skipped[1].why).toMatch(/No date on it/);
    const all = readBankTable(parseCSV(`Date,Description,Amount\n3rd of Sep 2026,SHOP RENT,-650.00\n`), "odd.csv", hash)!;
    expect(noLinesSaid(all, "odd.csv")).toMatch(/^odd\.csv: none of its dates read/);
  });

  it("with no account column, the file's name may say which account it is; a person may too", () => {
    const fee = `Posting Date,Description,Amount\n09/30/2026,MONTHLY SERVICE FEE,-15.00\n`;
    expect(last4FromName("Chase1111_Activity_20260930.csv")).toBe("1111");
    expect(last4FromName("Checking1.csv")).toBeNull();
    expect(last4FromName("2026-09-30_transactions.csv")).toBeNull();
    expect(last4FromName("export_1727654400.csv")).toBeNull();
    const a = readBankTable(parseCSV(fee), "Chase1111_Activity.csv", hash)!;
    const b = readBankTable(parseCSV(fee), "Chase2222_Activity.csv", hash)!;
    expect([a.last4, b.last4]).toEqual(["1111", "2222"]);
    expect(a.lines[0].key).not.toBe(b.lines[0].key);
    const bare = readBankTable(parseCSV(fee), "stmt.csv", hash)!;
    expect(bare.last4).toBeNull();
    const told = withAccountLast4(bare, "2222", hash);
    expect(told.last4).toBe("2222");
    expect(told.lines[0].last4).toBe("2222");
    expect(told.lines[0].key).toBe(b.lines[0].key);
  });

  it("a card's download that prints charges as positive is read the other way round", () => {
    const card = readBankTable(
      parseCSV(`Date,Description,Amount
09/01/2026,SHELL OIL 57444 ANYTOWN,62.10
09/02/2026,HOME HARDWARE 55,45.00
09/03/2026,COFFEE CART,4.50
09/05/2026,AUTOPAY PAYMENT - THANK YOU,-500.00
`),
      "card.csv",
      hash,
    )!;
    expect(card.swapped).toBe(true);
    expect(card.lines.map((l) => l.cents)).toEqual([-6210, -4500, -450, 50000]);
    // The payment is money in on the card's download, and it is not income.
    expect(guessFor(card.lines[3], ORG_BOOKS())).toEqual({ choice: "not_income" });
    // A card member column says so on its own.
    const amex = readBankTable(parseCSV(`Date,Description,Card Member,Amount\n09/01/2026,SHELL OIL,PAT CREW,62.10\n09/02/2026,HOME HARDWARE,PAT CREW,45.00\n`), "amex.csv", hash)!;
    expect(amex.lines.map((l) => l.cents)).toEqual([-6210, -4500]);
    // A checking export with a running balance is read as printed, even when its few debits are payments.
    const checking = readBankTable(
      parseCSV(`Date,Description,Amount,Balance\n09/01/2026,CUSTOMER DEPOSIT,900.00,900.00\n09/02/2026,DEPOSIT,500.00,1400.00\n09/03/2026,ONLINE PAYMENT THANK YOU,-100.00,1300.00\n`),
      "chk.csv",
      hash,
    )!;
    expect(checking.swapped).toBeUndefined();
    expect(checking.lines.map((l) => l.cents)).toEqual([90000, 50000, -10000]);
    // A Chase-style card export (charges negative, the payment positive) is read as printed.
    const chase = readBankTable(parseCSV(`Transaction Date,Description,Amount\n09/01/2026,SHELL OIL,-62.10\n09/05/2026,Payment Thank You-Mobile,500.00\n`), "chase.csv", hash)!;
    expect(chase.lines.map((l) => l.cents)).toEqual([-6210, 50000]);
    expect(guessFor(chase.lines[1], ORG_BOOKS())).toEqual({ choice: "not_income" });
  });

  it("a person's Swap flips every line and makes its key again", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/01/2026,SHELL OIL,62.10\n09/01/2026,SHELL OIL,62.10\n`), "x.csv", hash)!;
    expect(dl.swapped).toBeUndefined();
    const flipped = swapDownloadSigns(dl, hash);
    expect(flipped.swapped).toBe(true);
    expect(flipped.lines.map((l) => l.cents)).toEqual([-6210, -6210]);
    expect(new Set(flipped.lines.map((l) => l.key)).size).toBe(2);
    expect(flipped.lines[0].key).not.toBe(dl.lines[0].key);
    // Swapped twice is the file as it was.
    expect(swapDownloadSigns(flipped, hash).lines.map((l) => l.key)).toEqual(dl.lines.map((l) => l.key));
  });

  /**
   * AND A SWAP NEVER LEAVES A SENTENCE IT CANNOT VOUCH FOR (fixed 2026-10-02). THE SENTENCE BESIDE APPLY
   * ALWAYS DESCRIBES THE LINES UNDER IT — and that has to hold for the only cards that ever carried a
   * sentence before the verification existed.
   *
   * cn-v1050 stored `readSaid` on every SCANNED download and had no `verified` field at all, so a card in
   * the tray today may carry "…the money going out, the money coming in and the balance from end to end
   * agree to the cent" with nothing to rework it from. `reverified` returned {} for exactly that case, the
   * spread carried the stored sentence straight through, and one tap on Swap left that assurance sitting
   * above lines whose every sign had just been turned over.
   */
  it("A SWAP ON A DOWNLOAD STORED BEFORE THE VERIFICATION goes silent instead of keeping its old sentence", () => {
    const born = readBankTable(parseCSV(`Date,Description,Amount\n09/02/2026,CARD PURCHASE HARROWGATE FUEL,-142.08\n09/05/2026,CHECK 1042,-1250.00\n`), "September.pdf", hash)!;
    // The shape cn-v1050 stored: scanCheckSaid's pass sentence, and no verdict beside it.
    const legacy = { ...born, readSaid: "Held against the statement's own printed figures: the money going out, the money coming in and the balance from end to end agree to the cent." };
    delete (legacy as { verified?: unknown }).verified;
    const flipped = swapDownloadSigns(legacy, hash);
    expect(flipped.lines.map((l) => l.cents)).toEqual([14208, 125000]);
    expect(flipped.verified).toBeUndefined();
    expect(flipped.readSaid).toBeUndefined();
    // And the card prints nothing where that sentence was, rather than printing the stale one.
    expect(bankViewOf(flipped, planBankDownload(flipped, ORG_BOOKS()), ORG_BOOKS()).readSaid).toBeNull();
    // A download this app made today still gets a NEW sentence, not silence.
    expect(swapDownloadSigns(born, hash).readSaid).toContain("Read from the file's own rows.");
  });

  it("an unsigned Amount with a Debit/Credit type column reads the type", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount,Type\n09/01/2026,SHOP RENT,650.00,Debit\n09/02/2026,CUSTOMER DEPOSIT,900.00,Credit\n`), "x.csv", hash)!;
    expect(dl.lines.map((l) => l.cents)).toEqual([-65000, 90000]);
    // Underscored and OFX-style type words; money in is asked first; a word nobody knows is skipped.
    const more = readBankTable(
      parseCSV(`Date,Description,Amount,Type
09/01/2026,UTILITY CO,650.00,ACH_DEBIT
09/02/2026,SHELL OIL,45.00,DEBIT_CARD
09/03/2026,MAIN ST,100.00,ATM
09/04/2026,TO SAVINGS,100.00,Transfer
09/05/2026,FROM SAVINGS,100.00,Transfer In
09/06/2026,CUSTOMER,250.00,ACH_CREDIT
09/07/2026,MYSTERY,75.00,Memo
`),
      "x.csv",
      hash,
    )!;
    expect(more.lines.map((l) => l.cents)).toEqual([-65000, -4500, -10000, -10000, 10000, 25000]);
    expect(more.skipped).toEqual([{ line: 8, why: 'Can\'t tell if this is money in or out: its type "Memo" isn\'t one the app knows.' }]);
  });

  it("reads an OFX/QFX file through the same reader (its FITID is the line's key)", () => {
    const ofx = readOfx(
      `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>000099991234<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902120000[-7:MST]<TRNAMT>-88.45<FITID>2026090201<NAME>SHELL 123 ANYTOWN</STMTTRN>
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260905<TRNAMT>-640.00<FITID>2026090502<CHECKNUM>1043<NAME>CHECK</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
      "Checking.qfx",
    );
    expect(ofx.ok).toBe(true);
    if (!ofx.ok) return;
    const dl = readBankTable(ofx.rows, "Checking.qfx", hash)!;
    expect(dl.last4).toBe("1234");
    expect(dl.lines.map((l) => [l.postedOn, l.cents, l.check])).toEqual([
      ["2026-09-02", -8845, null],
      ["2026-09-05", -64000, "1043"],
    ]);
    expect(dl.lines.every((l) => l.key.startsWith("fitid:"))).toBe(true);
  });

  it("reads a download with no headings, and a credit union's headings under a preamble", () => {
    const bare = parseCSV(`"09/25/2026","-42.00","*","","ACME UTILITY WEB ONLINE 092426 12345678901234 ACME CO"
"09/24/2026","500.00","*","","ONLINE TRANSFER FROM ACME SAVINGS 000123456789"
"09/23/2026","-12.50","*","1044","CHECK 1044"
`);
    expect(findBankHeader(bare)).toEqual({ row: -1, columns: { date: 0, amount: 1, description: 4 } });
    expect(looksLikeBankTable(bare, false)).toBe(true);
    const dl = readBankTable(bare, "Checking1.csv", hash)!;
    expect(dl.lines.map((l) => [l.row, l.postedOn, l.cents])).toEqual([
      [1, "2026-09-25", -4200],
      [2, "2026-09-24", 50000],
      [3, "2026-09-23", -1250],
    ]);
    for (const l of dl.lines) expect(l.description).not.toMatch(/\d{6,}/);
    // A supplier's list with no headings has a column of paper numbers: it stays the supplier's.
    const list = parseCSV(`"INV-100234","09/01/2026","Invoice for materials at the shop","450.00"\n"CM-100240","09/03/2026","Credit memo for a return","-50.00"\n`);
    expect(findBankHeader(list)).toBeNull();
    const cu = parseCSV(`Account Number: 000123456789
Statement Period,09/01/2026 - 09/30/2026
Trans Date,Transaction,Withdrawal Amt,Deposit Amt,Bal
09/03/2026,SHELL OIL 57444 ANYTOWN,62.10,,938.00
09/04/2026,CUSTOMER DEPOSIT,,500.00,1438.00
`);
    const at = findHeaderRow(cu);
    expect(looksLikeBankTable(cu, at >= 0 && readHeaderRow(cu[at]).columns.reference !== undefined)).toBe(true);
    expect(readBankTable(cu, "cu.csv", hash)!.lines.map((l) => l.cents)).toEqual([-6210, 50000]);
  });

  it("is told apart from a supplier's open list", () => {
    const bank = parseCSV(CHECKING_CSV);
    const at = findHeaderRow(bank);
    const ref = at >= 0 && readHeaderRow(bank[at]).columns.reference !== undefined;
    expect(looksLikeBankTable(bank, ref)).toBe(true);
    const supplier = parseCSV(`Reference #,Type,PO Number,Inv Date,Inv Amt,Open Balance\nINV-100,Invoice,JOB A,09/01/2026,10.00,10.00\n`);
    expect(looksLikeBankTable(supplier, true)).toBe(false);
    // A supplier's statement with a date, a description, an amount and a running balance, beside
    // its paper numbers, is still the supplier's.
    const statement = parseCSV(`Date,Reference,Description,Amount,Balance\n09/01/2026,INV-100,Invoice,10.00,10.00\n`);
    const sAt = findHeaderRow(statement);
    expect(looksLikeBankTable(statement, sAt >= 0 && readHeaderRow(statement[sAt]).columns.reference !== undefined)).toBe(false);
    const isBank = (csv: string) => {
      const t = parseCSV(csv);
      const a = findHeaderRow(t);
      return looksLikeBankTable(t, a >= 0 && readHeaderRow(t[a]).columns.reference !== undefined);
    };
    // A supplier's open-item list printing Debit and Credit: its open balance says whose it is.
    expect(isBank(`Date,Invoice #,Description,Debit,Credit,Open Balance\n09/01/2026,INV-1001,Materials,450.00,,450.00\n09/05/2026,INV-1002,Materials,200.00,,200.00\n`)).toBe(false);
    // With no open balance, its column of paper numbers says so.
    expect(isBank(`Invoice #,Date,Description,Debit,Credit\n INV-1001,09/01/2026,Materials,450.00,\nPMT-77,09/10/2026,Payment,,300.00\n`)).toBe(false);
    // A bank's own Transaction column holds words, with Debit, Credit and a running Balance.
    expect(isBank(`Date,Transaction,Description,Debit,Credit,Balance\n09/01/2026,DEBIT CARD,SHELL OIL,62.10,,938.00\n09/02/2026,DEPOSIT,CUSTOMER,,500.00,1438.00\n`)).toBe(true);
    // A word only a bank prints still says so over a paper-number column.
    expect(isBank(`Posted Date,Reference,Description,Debit,Credit\n09/01/2026,100234,SHELL OIL,62.10,\n`)).toBe(true);
  });
});

describe("privacy: what is kept of a line", () => {
  it("cuts every run of 6+ digits to its last 4, even printed in groups", () => {
    expect(redactDigits("ACH DEBIT 123456789012")).toBe("ACH DEBIT ••9012");
    expect(redactDigits("CARD 4111-1111-1111-1234 SHELL")).toBe("CARD ••1234 SHELL");
    expect(redactDigits("CALL 775 555 1234")).toBe("CALL ••1234");
    // Short numbers stay: a store number, a check, a card's last 4.
    expect(redactDigits("1111-SHELL 54321 ANYTOWN")).toBe("1111-SHELL 54321 ANYTOWN");
    expect(cleanDescription("ONLINE   TRANSFER TO CHK XXXXXX9876 REF #IB0123456789")).toBe("ONLINE TRANSFER TO CHK XXXXXX9876 REF #IB••6789");
    const dl = download();
    for (const l of dl.lines) expect(l.description).not.toMatch(/\d{6,}/);
    expect(JSON.stringify(dl)).not.toContain("0123456789");
  });

  it("a long number after CHK is an account, never a check number", () => {
    const dl = readBankTable(
      parseCSV(`Date,Description,Amount\n09/01/2026,Online Banking transfer to CHK 123456789 Confirmation# 1234567890,-500.00\n09/02/2026,CHECK #1044,-80.00\n`),
      "x.csv",
      hash,
    )!;
    expect(dl.lines[0].check).toBeNull();
    expect(dl.lines[0].description).toBe("Online Banking transfer to CHK ••6789 Confirmation# ••7890");
    expect(JSON.stringify(dl)).not.toContain("123456789");
    // A real check number printed in the words still reads.
    expect(dl.lines[1].check).toBe("1044");
  });
});

describe("the merchant key", () => {
  it("is the first word, two when the first names nobody, with card prefixes, store numbers and noise gone", () => {
    expect(merchantKeyOf("1111-SHELL 123 ANYTOWN ST")).toBe("shell");
    expect(merchantKeyOf("1111-SHELL 456 OTHERTOWN")).toBe("shell");
    expect(merchantKeyOf("POS DEBIT 09/14 THE HOME HARDWARE #55")).toBe("the home");
    expect(merchantKeyOf("O'REILLY AUTO 44 ANYTOWN")).toBe("o reilly");
    expect(merchantKeyOf("SQ *COFFEE CART")).toBe("sq coffee");
    // A transfer is keyed by the other account, so a move to savings and the owner's draw differ.
    expect(merchantKeyOf("ONLINE TRANSFER TO CHK XXXXXX9876 REF #IB••6789")).toBe("transfer 9876");
    expect(merchantKeyOf("ONLINE TRANSFER TO SAV XXXXXX5555 ON 09/10")).toBe("transfer 5555");
  });

  it("is the payee, never the way the money went: ACH, bill pay, Zelle, Venmo, Cash App, a wire", () => {
    expect(merchantKeyOf("ORIG CO NAME:ACME INSURANCE ORIG ID:1234 DESC DATE:0901 CO ENTRY DESCR:PREMIUM")).toBe("acme");
    expect(merchantKeyOf("ORIG CO NAME:STATE TAX BOARD ORIG ID:9876 DESC DATE:0915 CO ENTRY DESCR:TAX PYMT")).toBe("state");
    expect(merchantKeyOf("Online Payment ••5678 To Verizon Wireless")).toBe("verizon");
    expect(merchantKeyOf("Online Payment ••5678 To PG&E Web")).toBe("pg&e");
    expect(merchantKeyOf("BILL PAY ACME WATER CO")).toBe("acme");
    expect(merchantKeyOf("Zelle payment to Pat Crew")).toBe("pat");
    expect(merchantKeyOf("ZELLE PAYMENT TO JOE SUB LLC")).toBe("joe");
    expect(merchantKeyOf("ZELLE FROM JANE CUSTOMER")).toBe("jane");
    expect(merchantKeyOf("VENMO *JOHN SMITH")).toBe("john");
    expect(merchantKeyOf("CASH APP*JANE DOE")).toBe("jane");
    expect(merchantKeyOf("WIRE TRANSFER TO ACME SUPPLY")).toBe("acme");
    expect(merchantKeyOf("REMOTE ONLINE DEPOSIT # 1")).toBe("deposit");
    // Nothing but the bank's words is still a key.
    expect(merchantKeyOf("ONLINE TRANSFER")).toBe("transfer");
  });

  it("a bare check is its own row and never a rule's", () => {
    expect(isBareCheck({ check: "1043", merchantKey: "check" })).toBe(true);
    expect(isBareCheck({ check: null, merchantKey: "shell" })).toBe(false);
  });
});

describe("the same line never twice", () => {
  it("keys a line by the account, day, cents, words and which repeat it is; FITID when the file has one", () => {
    const twice = readBankTable(
      parseCSV(`Date,Description,Amount\n09/01/2026,COFFEE CART,-4.50\n09/01/2026,COFFEE CART,-4.50\n`),
      "x.csv",
      hash,
    )!;
    expect(twice.lines).toHaveLength(2);
    expect(twice.lines[0].key).not.toBe(twice.lines[1].key);
    // An overlapping download (the next month's) carries the same keys for the same lines.
    const a = download();
    const b = download(CHECKING_CSV.replace("MONTHLY SERVICE FEE,12.00", "MONTHLY SERVICE FEE,12.00"), "Next.csv");
    expect(b.lines.map((l) => l.key).sort()).toEqual(a.lines.map((l) => l.key).sort());
  });

  /**
   * THE BALANCE IS NOT PART OF THE KEY, and nothing pinned that until now. `balanceAfterCents` arrived with
   * the running-balance walk; the same line in two downloads is the SAME LINE whether or not one of them
   * printed a balance beside it. Put it in the hash and the September CSV (with a Balance column) and the
   * October QFX (without one) stop recognising their overlapping week — and worse, `rekeyLines`, which a
   * Swap and an account answer both call, hands back keys no fresh read of the file would ever produce,
   * because it is given no balance to hash. The exact-key lookup then misses every line it should match and
   * only the twin heuristic is left standing between the owner and the same cost counted twice.
   */
  it("the SAME lines keyed with and without a Balance column are the same keys", () => {
    const rows = `09/02/2026,CARD PURCHASE HARROWGATE FUEL,-142.08\n09/05/2026,CHECK 1042,-1250.00\n09/08/2026,DEPOSIT INVOICE PAYMENT,3400.00\n`;
    const withBalance = readBankTable(parseCSV(`Date,Description,Amount,Balance\n${rows.replace("-142.08", "-142.08,3857.92").replace("-1250.00", "-1250.00,2607.92").replace("3400.00", "3400.00,6007.92")}`), "Sept.csv", hash)!;
    const without = readBankTable(parseCSV(`Date,Description,Amount\n${rows}`), "Sept.csv", hash)!;
    expect(withBalance.lines.map((l) => l.balanceAfterCents)).toEqual([385792, 260792, 600792]);
    expect(without.lines.every((l) => l.balanceAfterCents === null)).toBe(true);
    expect(withBalance.lines.map((l) => l.key)).toEqual(without.lines.map((l) => l.key));
    // And `lineKeyOf` itself is never handed one, so no later door can start hashing it.
    expect(lineKeyOf(hash, { last4: null, fitid: null, postedOn: "2026-09-02", cents: -14208, description: "CARD PURCHASE HARROWGATE FUEL" }, 0)).toBe(withBalance.lines[0].key);
    // Which is why a Swap there and back, on a file that DOES print a balance, lands on its own keys again.
    expect(swapDownloadSigns(swapDownloadSigns(withBalance, hash), hash).lines.map((l) => l.key)).toEqual(withBalance.lines.map((l) => l.key));
  });

  it("the same line in a download of another format is counted once", () => {
    // A CSV counted first (keys from the line), then a QFX of overlapping weeks (keys from FITIDs).
    const csv = readBankTable(parseCSV(`Account,Date,Description,Amount\nXXXX1234,09/16/2026,1111-SHELL OIL 57444 ANYTOWN CA,-100.00\nXXXX1234,09/17/2026,1111-SHELL OIL 57444 ANYTOWN CA,-100.00\n`), "a.csv", hash)!;
    const qfx = readBankTable(
      [["Account", "Date", "Description", "Amount", "Check", "Id"], ["000099991234", "2026-09-16", "SHELL OIL 57444 ANYTOWN CA", "-100.00", "", "F1"], ["000099991234", "2026-09-18", "SHELL OIL 57444", "-100.00", "", "F2"], ["000099991234", "2026-09-18", "ACME DINER", "-100.00", "", "F3"], ["000099991234", "2026-09-20", "SHELL OIL 57444", "-100.00", "", "F4"]],
      "b.qfx",
      hash,
    )!;
    const stored = csv.lines.map((l) => ({ key: l.key, postedOn: l.postedOn, cents: l.cents, last4: l.last4, description: l.description, check: l.check }));
    const plan = planBankDownload(qfx, ORG_BOOKS({ stored }));
    // Two of them are the CSV's two fills (each stored line stands for one); a diner of the same
    // money isn't a SHELL, and a fill 3 days on is a new one.
    expect(qfx.lines.map((l) => plan.dispositions.get(l.key)!.how)).toEqual(["already", "already", "need", "need"]);
    expect(plan.counts.already).toBe(2);
    // Another account's line is never a twin.
    const other = planBankDownload({ ...qfx, lines: qfx.lines.map((l) => ({ ...l, last4: "5555" })) }, ORG_BOOKS({ stored }));
    expect(other.counts.already).toBe(0);
  });

  it("a line already in North is counted, never shown", () => {
    const dl = download();
    const fee = lineBy(dl, "SERVICE FEE");
    const plan = planBankDownload(dl, ORG_BOOKS({ already: new Map([[fee.key, { choice: "cost", bucket: "Fees", amountCents: -1200 }]]) }));
    expect(plan.dispositions.get(fee.key)).toEqual({ how: "already" });
    expect(plan.counts.already).toBe(1);
    expect(plan.groups.some((g) => g.keys.includes(fee.key))).toBe(false);
  });
});

describe("matching what is already on the books (exact cents, each row once)", () => {
  it("a deposit is the payment recorded up to 7 days before it posts", () => {
    const dl = download();
    const books = ORG_BOOKS({
      payments: [
        { id: "pay-far", invoiceId: "inv-9", invoiceNumber: "INV-9", cents: 127500, day: "2026-08-20", method: "check", feeCents: null, stripe: false },
        { id: "pay-1", invoiceId: "inv-1", invoiceNumber: "INV-1001", cents: 127500, day: "2026-09-03", method: "check", feeCents: null, stripe: false },
      ],
    });
    const plan = planBankDownload(dl, books);
    expect(plan.dispositions.get(lineBy(dl, "DEPOSIT").key)).toEqual({ how: "match", table: "payments", ids: ["pay-1"], said: "Payment on INV-1001" });
  });

  it("a check deposited weeks after it was recorded is that payment; a deposit never takes a Venmo payment", () => {
    const dl = readBankTable(
      parseCSV(`Date,Description,Amount
09/12/2026,MOBILE DEPOSIT,450.00
09/14/2026,VENMO CASHOUT,450.00
09/15/2026,MOBILE DEPOSIT,900.00
`),
      "x.csv",
      hash,
    )!;
    const books = ORG_BOOKS({
      payments: [
        { id: "venmo1", invoiceId: "i1", invoiceNumber: "INV-1", cents: 45000, day: "2026-09-10", method: "venmo", feeCents: null, stripe: false },
        { id: "check1", invoiceId: "i2", invoiceNumber: "INV-2", cents: 90000, day: "2026-08-24", method: "check", feeCents: null, stripe: false },
      ],
    });
    const plan = planBankDownload(dl, books);
    const [mobile450, venmo450, mobile900] = dl.lines;
    // The Venmo payout takes the Venmo payment, though the mobile deposit of the same amount came first.
    expect(plan.dispositions.get(venmo450.key)).toMatchObject({ how: "match", ids: ["venmo1"] });
    expect(plan.dispositions.get(mobile450.key)).toMatchObject({ how: "need" });
    // A check recorded 22 days before it was deposited.
    expect(plan.dispositions.get(mobile900.key)).toMatchObject({ how: "match", ids: ["check1"], said: "Payment on INV-2" });
    expect(depositKindOf("REGULAR DEPOSIT")).toBe("paper");
    expect(depositKindOf("STRIPE TRANSFER ST-AB12")).toBe("card");
    expect(depositKindOf("ACME CORP")).toBeNull();
  });

  it("a deposit that looks like a payment already in North says so, and guesses Already Counted, never Other Income first", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/12/2026,DEPOSIT,1275.00\n09/13/2026,ACME CORP,300.00\n`), "x.csv", hash)!;
    // Recorded 11 days before, by a way the words don't say ("other"): not a sure match.
    const books = ORG_BOOKS({ payments: [{ id: "p-other", invoiceId: "i1", invoiceNumber: "INV-1001", cents: 127500, day: "2026-09-01", method: "other", feeCents: null, stripe: false }] });
    const plan = planBankDownload(dl, books);
    const dep = plan.groups.find((g) => g.label === "DEPOSIT")!;
    expect(dep.guess).toBe("not_income");
    expect(dep.hint).toBe("Maybe the payment on INV-1001 of Sep 1, already in North.");
    expect(dep.buttons).toEqual(["not_income", "other_income"]);
    // No guess at all: Already Counted still comes before Other Income.
    const acme = plan.groups.find((g) => g.label === "ACME CORP")!;
    expect(acme.guess).toBeNull();
    expect(acme.buttons).toEqual(["not_income", "other_income"]);
  });

  // Review of release/v1026: INV-100 has $5,000 open and a $5,000 payment already recorded on it (a
  // 50% deposit). The deposit of that money guessed "On INV-100", and the tap wrote a second payment:
  // Received counted twice, the invoice called paid.
  it("a deposit already recorded as a payment guesses Already Counted before an invoice of the same balance, which stays a tap away", () => {
    const inv = { id: "inv-100", number: "INV-100", balanceCents: 500000 };
    const pay = (over: Partial<BooksPayment> = {}): BooksPayment => ({ id: "p-100", invoiceId: "inv-100", invoiceNumber: "INV-100", cents: 500000, day: "2026-09-11", method: "check", feeCents: null, stripe: false, ...over });
    const deposit = (description: string) => readBankTable(parseCSV(`Date,Description,Amount\n09/12/2026,${description},5000.00\n`), "x.csv", hash)!;
    const cases: [BankDownload, BooksPayment, string][] = [
      [deposit("ONLINE TRANSFER FROM SMITH J REF 123"), pay(), "Sep 11"], // a check; the bank says transfer
      [deposit("MOBILE DEPOSIT"), pay({ day: "2026-09-16" }), "Sep 16"], // written down 4 days after the bank posted it
      [deposit("ZELLE FROM JOHN SMITH"), pay({ method: "transfer" }), "Sep 11"], // Zelle, recorded as a transfer
    ];
    for (const [dl, p, day] of cases) {
      const plan = planBankDownload(dl, ORG_BOOKS({ invoices: [inv], payments: [p] }));
      expect(plan.dispositions.get(dl.lines[0].key)).toMatchObject({ how: "need" });
      const g = plan.groups[0];
      expect([dl.lines[0].description, g.guess]).toEqual([dl.lines[0].description, "not_income"]);
      expect(g.buttons).toEqual(["not_income", "invoice:inv-100", "other_income"]);
      expect(g.hint).toBe(`Maybe the payment on INV-100 of ${day}, already in North.`);
      expect(lookalikePayment(dl.lines[0], { payments: [p] }, undefined, "inv-100")?.id).toBe("p-100");
      expect(lookalikePayment(dl.lines[0], { payments: [p] }, undefined, "inv-other")).toBeNull();
    }
    // Nothing of that money in North: the invoice is the guess, as before.
    const plain = planBankDownload(deposit("MOBILE DEPOSIT"), ORG_BOOKS({ invoices: [inv] }));
    expect(plain.groups[0].guess).toBe("invoice:inv-100");
    expect(plain.groups[0].buttons).toEqual(["invoice:inv-100", "other_income", "not_income"]);
    // A payment recorded more than 10 days after the bank posted it is no lookalike.
    const late = planBankDownload(deposit("MOBILE DEPOSIT"), ORG_BOOKS({ invoices: [inv], payments: [pay({ day: "2026-09-23" })] }));
    expect(late.groups[0].guess).toBe("invoice:inv-100");
  });

  it("a card payout is exactly one group of payments less their fees; a Venmo sweep one group of Venmo payments", () => {
    const dl = download();
    const books = ORG_BOOKS({
      payments: [
        { id: "card-1", invoiceId: "i1", invoiceNumber: "INV-1", cents: 25000, day: "2026-09-16", method: "card", feeCents: 755, stripe: true },
        { id: "card-2", invoiceId: "i2", invoiceNumber: "INV-2", cents: 25000, day: "2026-09-16", method: "card", feeCents: 705, stripe: true },
        { id: "card-3", invoiceId: "i3", invoiceNumber: "INV-3", cents: 9000, day: "2026-09-16", method: "card", feeCents: null, stripe: true },
        { id: "v-1", invoiceId: "i4", invoiceNumber: "INV-4", cents: 10000, day: "2026-09-18", method: "venmo", feeCents: null, stripe: false },
        { id: "v-2", invoiceId: "i5", invoiceNumber: "INV-5", cents: 20000, day: "2026-09-19", method: "venmo", feeCents: null, stripe: false },
      ],
    });
    const plan = planBankDownload(dl, books);
    const payout = plan.dispositions.get(lineBy(dl, "STRIPE").key);
    expect(payout).toMatchObject({ how: "match", table: "payments" });
    expect(payout && payout.how === "match" && [...payout.ids].sort()).toEqual(["card-1", "card-2"]);
    const sweep = plan.dispositions.get(lineBy(dl, "VENMO").key);
    expect(sweep && sweep.how === "match" && [...sweep.ids].sort()).toEqual(["v-1", "v-2"]);
  });

  it("two groups that both add up are no match: the person says", () => {
    const dl = download();
    const books = ORG_BOOKS({
      payments: [
        { id: "v-1", invoiceId: "i1", invoiceNumber: "INV-1", cents: 10000, day: "2026-09-18", method: "venmo", feeCents: null, stripe: false },
        { id: "v-2", invoiceId: "i2", invoiceNumber: "INV-2", cents: 20000, day: "2026-09-18", method: "venmo", feeCents: null, stripe: false },
        { id: "v-3", invoiceId: "i3", invoiceNumber: "INV-3", cents: 15000, day: "2026-09-18", method: "venmo", feeCents: null, stripe: false },
        { id: "v-4", invoiceId: "i4", invoiceNumber: "INV-4", cents: 15000, day: "2026-09-18", method: "venmo", feeCents: null, stripe: false },
      ],
    });
    expect(planBankDownload(dl, books).dispositions.get(lineBy(dl, "VENMO").key)).toMatchObject({ how: "need" });
  });

  it("a check matches crew pay by its number; a supplier payment by the account the line names; a bill by amount within 3 days", () => {
    const dl = download();
    const books = ORG_BOOKS({
      payPayments: [{ id: "pp-1", profileId: "crew-pat", cents: 64000, day: "2026-09-01", reference: "#1043" }],
      supplierPayments: [{ id: "sp-1", accountId: "acct-cs", cents: 100000, day: "2026-09-21", reference: null }],
      bills: [
        { id: "bill-far", cents: 4510, day: "2026-09-10", supplier: "Home Hardware", jobId: null, category: "Tools & Supplies", onAccount: false },
        { id: "bill-1", cents: 4510, day: "2026-09-22", supplier: "Home Hardware", jobId: "job-1", category: "Receipt", onAccount: false },
        { id: "bill-acct", cents: 10000, day: "2026-09-09", supplier: "Contractor Supply", jobId: "job-1", category: "Bill", onAccount: true },
      ],
    });
    const plan = planBankDownload(dl, books);
    expect(plan.dispositions.get(lineBy(dl, "CHECK").key)).toMatchObject({ how: "match", table: "pay_payments", ids: ["pp-1"] });
    expect(plan.dispositions.get(lineBy(dl, "CONTRACTOR SUPPLY").key)).toMatchObject({ how: "match", table: "supplier_payments", ids: ["sp-1"] });
    expect(plan.dispositions.get(lineBy(dl, "HOME HARDWARE").key)).toMatchObject({ how: "match", table: "bills", ids: ["bill-1"] });
    // A bill an account pays is paid through the account, never by a card line: the $100 SHELL
    // line on 9/9 is not that bill.
    expect(plan.dispositions.get(lineBy(dl, "SHELL 456").key)).toMatchObject({ how: "need" });
  });

  it("crew pay recorded after the bank posted it, or a check cashed weeks later, is that payment", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Check,Amount\n09/12/2026,CHECK,1044,-800.00\n09/20/2026,CHECK,1051,-450.00\n`), "x.csv", hash)!;
    const plan = planBankDownload(
      dl,
      ORG_BOOKS({
        payPayments: [
          { id: "pp-late", profileId: "crew-pat", cents: 80000, day: "2026-09-15", reference: null },
          { id: "pp-old", profileId: "crew-pat", cents: 45000, day: "2026-07-30", reference: null },
        ],
      }),
    );
    expect(plan.dispositions.get(dl.lines[0].key)).toMatchObject({ how: "match", table: "pay_payments", ids: ["pp-late"] });
    expect(plan.dispositions.get(dl.lines[1].key)).toMatchObject({ how: "match", table: "pay_payments", ids: ["pp-old"] });
  });

  it("a transfer between the company's own accounts is never crew pay of the same amount", () => {
    const dl = readBankTable(
      parseCSV(`Date,Description,Amount\n09/10/2026,ONLINE TRANSFER TO CHK XXXXXX9876,-1000.00\n09/12/2026,Zelle payment to Pat Crew,-1000.00\n`),
      "x.csv",
      hash,
    )!;
    const plan = planBankDownload(dl, ORG_BOOKS({ payPayments: [{ id: "pp1", profileId: "crew-pat", cents: 100000, day: "2026-09-08", reference: null }] }));
    expect(plan.dispositions.get(dl.lines[0].key)).toMatchObject({ how: "need" });
    expect(plan.dispositions.get(dl.lines[1].key)).toMatchObject({ how: "match", table: "pay_payments", ids: ["pp1"] });
    expect(plan.groups[0].guess).toBe("draw");
  });

  it("a bill is matched by the line that names its supplier, never by a transfer or another merchant's line", () => {
    const dl = readBankTable(
      parseCSV(`Date,Description,Amount
09/10/2026,Transfer to DDA *****5555,-500.00
09/12/2026,1111-ACMEHARDW S A ANYTOWN,-500.00
09/11/2026,1111-LOWES #1234 ANYTOWN,-80.00
09/11/2026,1111-ACME DINER,-80.00
09/12/2026,CHECK 1050,-210.00
`),
      "x.csv",
      hash,
    )!;
    const books = ORG_BOOKS({
      bills: [
        { id: "b-acme", cents: 50000, day: "2026-09-09", supplier: "Acmehardware Supply", jobId: "job-1", category: "Receipt", onAccount: false },
        { id: "b-lowes", cents: 8000, day: "2026-09-11", supplier: "Lowe's", jobId: null, category: "Tools & Supplies", onAccount: false },
        { id: "b-check", cents: 21000, day: "2026-09-11", supplier: "Anytown Lumber", jobId: "job-2", category: "Bill", onAccount: false },
      ],
    });
    const plan = planBankDownload(dl, books);
    const by = (w: string) => plan.dispositions.get(dl.lines.find((l) => l.description.includes(w))!.key);
    expect(by("Transfer")).toMatchObject({ how: "need" });
    expect(by("ACMEHARDW")).toMatchObject({ how: "match", table: "bills", ids: ["b-acme"] });
    expect(by("LOWES")).toMatchObject({ how: "match", ids: ["b-lowes"] });
    expect(by("ACME DINER")).toMatchObject({ how: "need" });
    // A check names nobody: the amount is all there is, and it is that bill.
    expect(by("CHECK 1050")).toMatchObject({ how: "match", ids: ["b-check"] });
  });

  it("a refund coming in matches the return already on the books, and may be put back on its bucket", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/12/2026,HOME HARDWARE REFUND,45.10\n09/13/2026,ACME TOOLS RETURN,30.00\n`), "x.csv", hash)!;
    const books = ORG_BOOKS({ bills: [{ id: "b-ret", cents: -4510, day: "2026-09-11", supplier: "Home Hardware", jobId: "job-1", category: "Receipt", onAccount: false }] });
    const plan = planBankDownload(dl, books);
    expect(plan.dispositions.get(dl.lines[0].key)).toMatchObject({ how: "match", table: "bills", ids: ["b-ret"], said: "Return from Home Hardware already on the books" });
    const acme = plan.groups.find((g) => g.label.includes("ACME TOOLS"))!;
    expect(validPicks({ [acme.id]: "cost:Tools & Supplies" }, plan, books).ok.size).toBe(1);
    const view = bankViewOf(dl, plan, books);
    expect(view.otherIn.map((b) => b.label)).toContain("Refund: Tools & Supplies");
  });

  it("a fill-up already on the books is matched and keeps the bucket it was filed in: a match marks, never re-files", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/12/2026,1111-CORNER STORE ANYTOWN,-131.20\n09/14/2026,1111-SHELL OIL ANYTOWN,-60.00\n`), "x.csv", hash)!;
    const bill = (id: string, cents: number, supplier: string, category: string) => ({ id, cents, day: "2026-09-12", supplier, jobId: null, category, onAccount: false });
    const books = ORG_BOOKS({
      // A pump receipt filed as Fuel, and one a person filed as Auto (a stop for oil, say).
      bills: [bill("b-store", 13120, "Corner Store", "Fuel"), { ...bill("b-shell", 6000, "Shell Oil", "Auto"), day: "2026-09-14" }],
      rules: [{ id: "r-store", direction: "out", key: "corner", choice: "cost", bucket: "Fuel", supplierAccountId: null, profileId: null, minCents: 12000, maxCents: 14000 }],
    });
    const plan = planBankDownload(dl, books);
    expect(plan.dispositions.get(dl.lines[0].key)).toEqual({ how: "match", table: "bills", ids: ["b-store"], said: "Corner Store already on the books" });
    expect(plan.dispositions.get(dl.lines[1].key)).toEqual({ how: "match", table: "bills", ids: ["b-shell"], said: "Shell Oil already on the books" });
    // Where the money went reads each bill's own bucket: the Fuel one is Fuel, the Auto one a business cost.
    const flow = bankViewOf(dl, plan, books).flow;
    expect(flow.find((s) => s.key === "fuel")!.cents).toBe(13120);
    expect(flow.find((s) => s.key === "business")!.cents).toBe(6000);
  });

  it("one bill is matched once, even when two lines could take it", () => {
    const dl = download();
    const books = ORG_BOOKS({ bills: [{ id: "b-shell", cents: 10000, day: "2026-09-12", supplier: "Shell", jobId: null, category: "Fuel", onAccount: false }] });
    const plan = planBankDownload(dl, books);
    const matched = [...plan.dispositions.values()].filter((d) => d.how === "match");
    expect(matched).toHaveLength(1);
  });

  it("an ATM withdrawal is a petty cash top-up already written down", () => {
    const dl = download();
    const plan = planBankDownload(dl, ORG_BOOKS({ pettyCash: [{ id: "pc-1", cents: 20000, day: "2026-09-15", kind: "replenish" }] }));
    expect(plan.dispositions.get(lineBy(dl, "ATM").key)).toMatchObject({ how: "match", table: "petty_cash", ids: ["pc-1"] });
  });
});

/**
 * CASH TAKEN OUT (NOT A COST) (Erik, 2026-09-27; W1-34). A bank's ATM line is cash that left the
 * bank: no cost yet (its receipts, filed as costs paid with cash, are), never the owner's draw, and no
 * cash box to top up. It was Petty Cash (ATM), which wrote a top-up; now it writes nothing, is guessed
 * for an ATM, and has its own segment in Where The Money Went. A top-up someone already wrote still
 * matches, so it counts once.
 */
describe("Cash Taken Out (Not A Cost)", () => {
  const names = { accounts: new Map(), crew: new Map(), invoices: new Map(), jobs: new Map() };

  it("is the ATM's guess and its button, in Title Case, and Petty Cash (ATM) is no answer any more", () => {
    const dl = download();
    const plan = planBankDownload(dl, ORG_BOOKS());
    const atm = plan.groups.find((g) => g.label.includes("ATM"))!;
    expect(atm.guess).toBe("cash_out");
    expect(atm.buttons).toContain("cash_out");
    expect(choiceLabel({ choice: "cash_out" }, names)).toBe("Cash Taken Out (Not A Cost)");
    const outs = everyChoice("out", ORG_BOOKS(), true).map((c) => choiceLabel(c, names));
    expect(outs).toContain("Cash Taken Out (Not A Cost)");
    expect(outs).not.toContain("Petty Cash (ATM)");
  });

  it("is stored under the word 0363's CHECK allows, and read back as itself (a pick saved before reads the same)", () => {
    expect(storedChoice({ choice: "cash_out" })).toBe("petty_cash");
    expect(storedChoice({ choice: "not_cost" })).toBe("not_cost");
    expect(storedChoiceName("petty_cash")).toBe("cash_out");
    expect(storedChoiceName("draw")).toBe("draw");
    expect(parseChoiceId("petty_cash")).toEqual({ choice: "cash_out" });
    expect(parseChoiceId("cash_out")).toEqual({ choice: "cash_out" });
  });

  it("has its own segment in Where The Money Went, for a line applied now and one applied as a top-up before", () => {
    expect(flowLabelOf("cash_out", null)).toEqual({ key: "cash_out", label: "Cash Taken Out" });
    expect(flowLabelOf("petty_cash", null)).toEqual({ key: "cash_out", label: "Cash Taken Out" });
    expect(flowLabelOf("not_cost", null)).toEqual({ key: "not_cost", label: "Transfers" });
    // A rule a person made when it was still Petty Cash (ATM) now answers Cash Taken Out.
    const rule: BooksRule = { id: "r-atm", direction: "out", key: "atm withdrawal", choice: storedChoiceName("petty_cash") as BooksRule["choice"], bucket: null, supplierAccountId: null, profileId: null };
    expect(ruleChoice(rule, ORG_BOOKS())).toEqual({ choice: "cash_out" });
  });
});

describe("the company's own rules", () => {
  const rule = (over: Partial<BooksRule>): BooksRule => ({ id: "r", direction: "out", key: "shell", choice: "cost", bucket: "Fuel", supplierAccountId: null, profileId: null, ...over });

  it("a rule the company made places every line of that merchant, and the longest key wins", () => {
    const dl = download();
    const books = ORG_BOOKS({
      rules: [
        rule({ id: "r-shell", key: "shell" }),
        rule({ id: "r-draw", key: "transfer 9876", choice: "draw", bucket: null }),
        rule({ id: "r-home", key: "home", choice: "personal", bucket: null }),
        rule({ id: "r-home-hw", key: "home hardware", choice: "cost", bucket: "Tools & Supplies" }),
      ],
    });
    const plan = planBankDownload(dl, books);
    for (const l of dl.lines.filter((x) => x.merchantKey === "shell")) expect(plan.dispositions.get(l.key)).toMatchObject({ how: "rule", ruleId: "r-shell" });
    // OWNER'S DRAW: the transfer to the owner is the bank line only, placed by the rule.
    expect(plan.dispositions.get(lineBy(dl, "ONLINE TRANSFER").key)).toMatchObject({ how: "rule", choice: { choice: "draw" } });
    expect(plan.dispositions.get(lineBy(dl, "HOME HARDWARE").key)).toMatchObject({ how: "rule", ruleId: "r-home-hw" });
    expect(plan.counts.ruled).toBe(5);
  });

  it("a rule never places a line going the other way, a bare check, or a bare deposit", () => {
    const dl = download();
    const books = ORG_BOOKS({
      rules: [
        rule({ id: "r-in", direction: "in", key: "shell", choice: "other_income", bucket: null }),
        rule({ id: "r-check", key: "check", choice: "personal", bucket: null }),
        rule({ id: "r-dep", direction: "in", key: "deposit", choice: "other_income", bucket: null }),
      ],
    });
    const plan = planBankDownload(dl, books);
    expect(plan.counts.ruled).toBe(0);
    expect(ruleFor(lineBy(dl, "CHECK"), books.rules)).toBeNull();
    expect(ruleFor(lineBy(dl, "DEPOSIT"), books.rules)).toBeNull();
  });

  it("money in is never placed as Other Income by a rule, and a deposit or payout is always its own row", () => {
    const dl = readBankTable(
      parseCSV(`Date,Description,Amount
09/02/2026,REGULAR DEPOSIT,900.00
09/09/2026,REGULAR DEPOSIT,1250.00
09/10/2026,VENMO CASHOUT,300.00
09/11/2026,ZELLE FROM JANE CUSTOMER,450.00
09/12/2026,ACME RENTALS REFUND,80.00
`),
      "x.csv",
      hash,
    )!;
    const books = ORG_BOOKS({
      invoices: [{ id: "inv-1", number: "INV-1", balanceCents: 125000 }],
      rules: [
        rule({ id: "r-reg", direction: "in", key: "regular", choice: "other_income", bucket: null }),
        rule({ id: "r-acme", direction: "in", key: "acme", choice: "other_income", bucket: null }),
        rule({ id: "r-jane", direction: "in", key: "jane", choice: "not_income", bucket: null }),
      ],
    });
    const plan = planBankDownload(dl, books);
    // No rule placed any of them: Other Income is never a rule's; Zelle is a payout, asked each time.
    expect(plan.counts.ruled).toBe(0);
    const row = (words: string) => plan.groups.find((g) => g.label.includes(words) && g.keys.length)!;
    // Each deposit is its own row, so the one that is INV-1's balance offers INV-1.
    const deposits = plan.groups.filter((g) => g.label === "REGULAR DEPOSIT");
    expect(deposits).toHaveLength(2);
    expect(deposits.every((g) => g.single && !g.learnable)).toBe(true);
    expect(deposits.find((g) => g.cents === 125000)!.guess).toBe("invoice:inv-1");
    expect(row("VENMO").learnable).toBe(false);
    expect(row("ZELLE").learnable).toBe(false);
  });

  it("a store with two answers: a fill-up is Fuel, a coffee is Personal (no Meals bucket), and an amount between them is ASKED", () => {
    // Filed two ways before: fill-ups of $120-$140 as Fuel, an $11.75 coffee as Personal. A coffee is
    // no business-cost bucket (there is no Meals), so the person said Personal, or could say Other.
    const dl = readBankTable(
      parseCSV(`Date,Description,Amount
09/12/2026,1111-CORNER STORE ANYTOWN,-131.20
09/13/2026,1111-CORNER STORE ANYTOWN,-11.75
09/14/2026,1111-CORNER STORE ANYTOWN,-45.00
`),
      "x.csv",
      hash,
    )!;
    const books = ORG_BOOKS({
      rules: [
        rule({ id: "r-fuel", key: "corner", choice: "cost", bucket: "Fuel", minCents: 12000, maxCents: 14000 }),
        rule({ id: "r-coffee", key: "corner", choice: "personal", bucket: null, minCents: 1175, maxCents: 1175 }),
      ],
    });
    const plan = planBankDownload(dl, books);
    const at = (cents: number) => plan.dispositions.get(dl.lines.find((l) => l.cents === cents)!.key);
    expect(at(-13120)).toEqual({ how: "rule", ruleId: "r-fuel", choice: { choice: "cost", bucket: "Fuel" } });
    expect(at(-1175)).toEqual({ how: "rule", ruleId: "r-coffee", choice: { choice: "personal" } });
    // $45 is in neither band (Fuel reaches down to $60, the coffee up to $23.50): asked, never forced.
    expect(at(-4500)).toMatchObject({ how: "need" });
    const row = plan.groups.find((g) => g.keys.includes(dl.lines.find((l) => l.cents === -4500)!.key))!;
    // Its guess is the nearest answer, marked Guess and never picked; the other answer is a tap away.
    expect(ruleHintFor(dl.lines.find((l) => l.cents === -4500)!, books.rules)!.id).toBe("r-fuel");
    expect(row.guess).toBe("cost:Fuel");
    expect(row.buttons).toEqual(["cost:Fuel", "cost:Auto", "personal"]);
    expect(plan.counts).toMatchObject({ ruled: 2, needLines: 1 });
  });

  it("a rule for a supplier or a person no longer here is not used", () => {
    const dl = download();
    const plan = planBankDownload(dl, ORG_BOOKS({ rules: [rule({ id: "r-gone", key: "dental", choice: "crew", bucket: null, profileId: "someone-gone" })] }));
    expect(plan.dispositions.get(lineBy(dl, "DENTAL").key)).toMatchObject({ how: "need" });
  });
});

describe("what needs a person: one row per merchant, the guess first and never picked", () => {
  it("groups a merchant's lines into one row and guesses from generic words", () => {
    const dl = download();
    const plan = planBankDownload(dl, ORG_BOOKS());
    const shell = plan.groups.find((g) => g.merchantKey === "shell")!;
    expect(shell.keys).toHaveLength(3);
    expect(shell.cents).toBe(-28845);
    expect(shell.guess).toBe("cost:Fuel");
    expect(shell.buttons).toEqual(["cost:Fuel", "cost:Auto", "personal"]);
    expect(plan.groups.find((g) => g.label.includes("ACME INSURANCE"))!.guess).toBe("cost:Insurance & Licenses");
    expect(plan.groups.find((g) => g.label.includes("SERVICE FEE"))!.guess).toBe("cost:Fees");
    // An ATM is Cash Taken Out (Not A Cost), W1-34: never a petty-cash top-up any more.
    expect(plan.groups.find((g) => g.label.includes("ATM"))!.guess).toBe("cash_out");
    expect(plan.groups.find((g) => g.label.includes("ONLINE TRANSFER"))!.guess).toBe("draw");
    // Nothing the words know: no guess, and the row still asks.
    expect(plan.groups.find((g) => g.label.includes("DENTAL"))!.guess).toBeNull();
  });

  it("a bare Withdrawal is never an ATM, and Point Of Sale never a merchant", () => {
    const line = (description: string, cents = -6210) => ({ row: 2, postedOn: "2026-09-10", cents, description, check: null, last4: null, merchantKey: merchantKeyOf(description), key: "k", balanceAfterCents: null });
    const books = ORG_BOOKS();
    expect(guessFor(line("POINT OF SALE WITHDRAWAL SHELL OIL 57444 ANYTOWN CA"), books)).toEqual({ choice: "cost", bucket: "Fuel" });
    expect(guessFor(line("Withdrawal POS #123456 SHELL OIL"), books)).toEqual({ choice: "cost", bucket: "Fuel" });
    expect(guessFor(line("ONLINE TRANSFER WITHDRAWAL TO XXXXXX9876"), books)).toEqual({ choice: "draw" });
    expect(guessFor(line("Withdrawal ACH ACME INSURANCE"), books)).toEqual({ choice: "cost", bucket: "Insurance & Licenses" });
    expect(guessFor(line("ATM WITHDRAWAL 000123 MAIN ST"), books)).toEqual({ choice: "cash_out" });
    // A truck stop is a fill-up, never Auto for its "truck"; a truck's repair or a fuel brand's car
    // wash is still Auto.
    for (const d of ["FLYING J TRUCK STOP 0612", "PILOT TRUCK STOP 00123", "PILOT_00123 ANYTOWN", "ANYTOWN TRUCK STOPS INC", "TA TRAVEL CENTER 0123", "ANYTOWN TRAVEL PLAZA"])
      expect([d, guessFor(line(d), books)]).toEqual([d, { choice: "cost", bucket: "Fuel" }]);
    for (const d of ["ANYTOWN TRUCK REPAIR", "TRUCK PARTS DEPOT 12", "CHEVRON CAR WASH 4410", "JIFFY LUBE #1234"])
      expect([d, guessFor(line(d), books)]).toEqual([d, { choice: "cost", bucket: "Auto" }]);
    expect(merchantKeyOf("POINT OF SALE WITHDRAWAL SHELL OIL 57444 ANYTOWN CA")).toBe("shell");
    expect(merchantKeyOf("POINT OF SALE WITHDRAWAL HOME DEPOT 4410")).toBe("home");
    expect(merchantKeyOf("VISA DDA PUR 123456 SHELL OIL")).toBe("shell");
  });

  it("a deposit guesses the one open invoice with that balance; a check guesses the crew", () => {
    const dl = download();
    const books = ORG_BOOKS({ invoices: [{ id: "inv-1", number: "INV-1001", balanceCents: 127500 }, { id: "inv-2", number: "INV-1002", balanceCents: 40000 }] });
    const plan = planBankDownload(dl, books);
    const dep = plan.groups.find((g) => g.label === "DEPOSIT")!;
    expect(dep.guess).toBe("invoice:inv-1");
    expect(dep.buttons).toEqual(["invoice:inv-1", "other_income", "not_income"]);
    const check = plan.groups.find((g) => g.check === "1043")!;
    expect(check.guess).toBe("crew:crew-pat");
    expect(guessFor(lineBy(dl, "SHELL 456"), books)).toEqual({ choice: "cost", bucket: "Fuel" });
  });

  it("names a supplier account by its number or spelling", () => {
    const acct = ORG_BOOKS().accounts[0];
    expect(lineNamesAccount("CONTRACTOR SUPPLY CO PMT", acct)).toBe(true);
    expect(lineNamesAccount("PAYMENT CS-12345", acct)).toBe(true);
    expect(lineNamesAccount("SHELL 123", acct)).toBe(false);
  });

  it("a counter payment printed with the branch and nothing else names the account; a short spelling as a word", () => {
    // An account with no branch on it: its papers' numbers say it (4 of 5 start 4410-).
    const branch = branchFromNumbers(["4410-1100001", "4410-1100002", "4410-1100003", "4410-1100004", "TR-9"]);
    expect(branch).toBe("4410");
    expect(branchFromNumbers(["4410-1100001"])).toBeNull();
    const acct = { id: "acct-ws", name: "Western Wire Supply", number: "TR-77", branch, onAccount: true, aliases: ["WWS"] };
    expect(lineNamesAccount("1111-(PC) 4410 T  ANYTOWN CA", acct)).toBe(true);
    expect(lineNamesAccount("1111-SHELL 44101 ANYTOWN", acct)).toBe(false);
    expect(lineNamesAccount("1111-WWS ANYTOWN BRANCH", acct)).toBe(true);
    expect(lineNamesAccount("1111-NEWWSTORE ANYTOWN", acct)).toBe(false);
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/10/2026,1111-(PC) 4410 T  ANYTOWN CA,-1500.00\n`), "x.csv", hash)!;
    const plan = planBankDownload(dl, ORG_BOOKS({ accounts: [acct], supplierPayments: [{ id: "sp-card", accountId: "acct-ws", cents: 150000, day: "2026-09-10", reference: null }] }));
    expect(plan.dispositions.get(dl.lines[0].key)).toMatchObject({ how: "match", table: "supplier_payments", ids: ["sp-card"] });
  });
});

describe("the card and the person's answers", () => {
  it("says a row's money as a total, and N× only when every line is that amount", () => {
    expect(sayGroupMoney({ keys: ["a", "b", "c"], cents: -28845, direction: "out", each: null })).toBe("3 charges · $288.45");
    expect(sayGroupMoney({ keys: ["a", "b", "c"], cents: -1350, direction: "out", each: -450 })).toBe("3× $4.50");
    expect(sayGroupMoney({ keys: ["a", "b"], cents: 90000, direction: "in", each: null })).toBe("2 deposits · $900.00");
    expect(sayGroupMoney({ keys: ["a"], cents: -1200, direction: "out", each: -1200 })).toBe("$12.00");
  });

  it("says the one line: account, dates, sorted, already in North, need you", () => {
    const dl = download();
    const fee = lineBy(dl, "SERVICE FEE");
    const books = ORG_BOOKS({
      already: new Map([[fee.key, { choice: "cost", bucket: "Fees", amountCents: -1200 }]]),
      payments: [{ id: "pay-1", invoiceId: "inv-1", invoiceNumber: "INV-1001", cents: 127500, day: "2026-09-03", method: "check", feeCents: null, stripe: false }],
      rules: [{ id: "r", direction: "out", key: "shell", choice: "cost", bucket: "Fuel", supplierAccountId: null, profileId: null }],
    });
    const plan = planBankDownload(dl, books);
    expect(bankHeadline(dl, plan.counts, "2026-09-27")).toBe("Bank ••1234 · Sep 2–Sep 25 · 4 sorted · 1 already in North · 9 need you");
    const view = bankViewOf(dl, plan, books, { today: "2026-09-27" });
    expect(view.rows.map((r) => r.title)).toContain("Check 1043");
    expect(view.flow.find((s) => s.key === "fuel")!.cents).toBe(28845);
    // Every other business cost is one Overhead segment, in the profit and loss's own word.
    expect(view.flow.every((s) => !s.key.startsWith("bucket:"))).toBe(true);
    expect(flowLabelOf("cost", "Auto")).toEqual({ key: "business", label: "Overhead" });
    expect(flowLabelOf("cost", "Gas & Truck")).toEqual({ key: "business", label: "Overhead" });
    expect(flowLabelOf("cost", "diesel")).toEqual({ key: "fuel", label: "Fuel" });
    expect(view.outCents).toBe(436745);
    expect(view.inCents).toBe(206040);
    expect(view.sorted.find((s) => s.label.startsWith("Fuel"))).toEqual({ label: "Fuel (Your Rule)", n: 3, cents: -28845 });
  });

  it("the fingerprint moves when the books do, and stays put when nothing changed", () => {
    const dl = download();
    const a = planBankDownload(dl, ORG_BOOKS());
    const b = planBankDownload(dl, ORG_BOOKS());
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = planBankDownload(dl, ORG_BOOKS({ bills: [{ id: "b", cents: 15000, day: "2026-09-24", supplier: "Dental", jobId: null, category: "Other", onAccount: false }] }));
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it("takes an answer only for a row on the card, that fits its direction, and names what it refuses", () => {
    const dl = download();
    const books = ORG_BOOKS({ invoices: [{ id: "inv-1", number: "INV-1001", balanceCents: 127500 }] });
    const plan = planBankDownload(dl, books);
    const shell = plan.groups.find((g) => g.merchantKey === "shell")!;
    const dep = plan.groups.find((g) => g.label === "DEPOSIT")!;
    const out = validPicks(
      { [shell.id]: "cost:Fuel", [dep.id]: "invoice:inv-1", "out:nobody": "personal" },
      plan,
      books,
    );
    expect(out.refused).toEqual(["an answer for a row that is no longer on the card"]);
    expect(out.ok.size).toBe(2);
    expect(out.refused).toHaveLength(1);
    const wrong = validPicks({ [shell.id]: "other_income", [dep.id]: "personal" }, plan, books);
    expect(wrong.ok.size).toBe(0);
    expect(wrong.refused).toHaveLength(2);
    const stranger = validPicks({ [shell.id]: "crew:not-our-person" }, plan, books);
    expect(stranger.refused[0]).toMatch(/isn't on your crew/);
  });

  it("a deposit's Other… list offers only the invoices open for its money, each said in full", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/12/2026,DEPOSIT,1275.00\n`), "x.csv", hash)!;
    const books = ORG_BOOKS({
      invoices: [
        { id: "inv-2", number: "INV-2", balanceCents: 5000, customer: "Small Job Co" },
        { id: "inv-3", number: "INV-3", balanceCents: 200000, customer: "Pat Customer" },
      ],
    });
    const view = bankViewOf(dl, planBankDownload(dl, books), books);
    const others = view.rows[0].others!;
    expect(others[0]).toEqual({ id: "invoice:inv-3", label: "On INV-3 · Pat Customer · $2,000.00 open" });
    expect(others.some((o) => o.id === "invoice:inv-2")).toBe(false);
    expect(others.map((o) => o.id)).toContain("other_income");
  });

  it("two deposits on one invoice are held to its balance together", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/10/2026,DEPOSIT,500.00\n09/12/2026,DEPOSIT,500.00\n`), "x.csv", hash)!;
    const books = ORG_BOOKS({ invoices: [{ id: "inv-9", number: "INV-9", balanceCents: 50000 }] });
    const plan = planBankDownload(dl, books);
    expect(plan.groups.map((g) => g.guess)).toEqual(["invoice:inv-9", "invoice:inv-9"]);
    const both = validPicks(Object.fromEntries(plan.groups.map((g) => [g.id, "invoice:inv-9"])), plan, books);
    expect(both.ok.size).toBe(0);
    expect(both.refused).toEqual(["2 deposits ($1,000.00) are more than the $500.00 open on INV-9"]);
    expect(validPicks({ [plan.groups[0].id]: "invoice:inv-9" }, plan, books).ok.size).toBe(1);
  });

  it("choice ids read back exactly; a bucket is the whole answer, Fuel and Auto included", () => {
    for (const id of ["cost:Fuel", "cost:Auto", "cost:Fees", "draw", "personal", "cash_out", "not_cost", "other_income", "not_income", "crew:abcdef12", "supplier:abcdef12", "invoice:abcdef12"]) {
      expect(choiceId(parseChoiceId(id)!)).toBe(id);
    }
    expect(parseChoiceId("cost:Fuel")).toEqual({ choice: "cost", bucket: "Fuel" });
    expect(choiceLabel(parseChoiceId("cost:Fuel")!, { accounts: new Map(), crew: new Map(), invoices: new Map(), jobs: new Map() })).toBe("Fuel");
    expect(choiceLabel(parseChoiceId("cost:Auto")!, { accounts: new Map(), crew: new Map(), invoices: new Map(), jobs: new Map() })).toBe("Auto");
    // The retired kind-inside-a-bucket answers are no answer: the row asks again.
    expect(parseChoiceId("cost:Gas & Truck:fuel")).toBeNull();
    expect(parseChoiceId("cost:Gas & Truck")).toBeNull();
    expect(parseChoiceId("cost:Fuel:fuel")).toBeNull();
    expect(parseChoiceId("cost:Seventh Bucket")).toBeNull();
    expect(parseChoiceId("drawx")).toBeNull();
  });

  it("every out answer offers each bucket once, Fuel and Auto first, and a refund may go back on any bucket", () => {
    const outs = everyChoice("out", ORG_BOOKS(), true).filter((c) => c.choice === "cost").map(choiceId);
    expect(outs).toEqual(["cost:Fuel", "cost:Auto", "cost:Tools & Supplies", "cost:Phone & Office", "cost:Insurance & Licenses", "cost:Fees", "cost:Rent", "cost:Other"]);
    const ins = everyChoice("in", ORG_BOOKS(), true).filter((c) => c.choice === "cost").map(choiceId);
    expect(ins).toEqual(outs);
  });
});

/**
 * A BANK LINE CAN NAME THE JOB IT WAS FOR (0375, Erik 2026-10-02).
 *
 * The defect it fixes: eleven answers and not one of them was a job, so the wire bought at the counter
 * for one kitchen became OVERHEAD, the job never saw the cost, and Gross Profit read high by exactly
 * that much. The twelfth answer, and its edges:
 *   · ONE LINE ONLY. A question row is one row per MERCHANT, and a job is per LINE — three trips to
 *     the supply house in a week can be three different jobs.
 *   · NEVER A RULE. A rule is per merchant, so "the supply house is always this job" is never true.
 *   · ONLY THIS COMPANY'S JOBS, each said as the place, the number AND who.
 *   · MONEY OUT ONLY. A bank line carries no lines, and a negative bill on a job with no lines is a
 *     supplier return the importer credits to the customer IN FULL, at markup, for parts nothing says
 *     they were ever charged for (lib/job-cost-guard, audit v994's DB4). A credit comes in as the
 *     supply house's paper, filed on the job with the returned parts on it.
 */
describe("a bank line on a job", () => {
  const names = () => namesOf(ORG_BOOKS());
  /** One trip to a supply house, or one credit back from it: a download of one line is a row of one. */
  const BOUGHT = `Date,Description,Amount\n09/12/2026,ANYTOWN ELECTRIC SUPPLY #4,-340.55\n`;
  const CREDITED = `Date,Description,Amount\n09/19/2026,ANYTOWN ELECTRIC SUPPLY #4 CREDIT,22.80\n`;
  const THREE_TRIPS = `Date,Description,Amount\n09/02/2026,ANYTOWN ELECTRIC SUPPLY #4,-100.00\n09/09/2026,ANYTOWN ELECTRIC SUPPLY #4,-120.00\n09/16/2026,ANYTOWN ELECTRIC SUPPLY #4,-110.00\n`;
  const sortOf = (csv: string, books = ORG_BOOKS()) => {
    const dl = readBankTable(parseCSV(csv), "Card1234.csv", hash)!;
    const plan = planBankDownload(dl, books);
    return { dl, plan, books, group: plan.groups[0], view: bankViewOf(dl, plan, books) };
  };

  it("reads back exactly, and says the job as the place, the number AND who", () => {
    expect(choiceId({ choice: "job", jobId: "job-kitchen" })).toBe("job:job-kitchen");
    expect(parseChoiceId("job:job-kitchen")).toEqual({ choice: "job", jobId: "job-kitchen" });
    expect(choiceId(parseChoiceId("job:abcdef12")!)).toBe("job:abcdef12");
    // Anything that isn't an id is no answer at all: the row asks again.
    expect(parseChoiceId("job")).toBeNull();
    expect(parseChoiceId("job:")).toBeNull();
    expect(parseChoiceId("job:not a uuid")).toBeNull();
    // THE LABEL IS A LAW (Erik: "i cant tell by job numbers alone").
    const said = choiceLabel({ choice: "job", jobId: "job-kitchen" }, names());
    expect(said).toBe("On 41 Larkspur · J-054 — Marla Finch");
    expect(said).not.toBe("On J-054");
    // A job the books no longer carry still reads as something, never "undefined".
    expect(choiceLabel({ choice: "job", jobId: "gone" }, names())).toBe("On Job");
  });

  /**
   * MONEY OUT IS A COST ON THE JOB; MONEY IN IS NOT OFFERED A JOB AT ALL, and the reason is the cost
   * guard's, not this module's. A $22.80 credit from the supply house put on J-054 would write
   * bills{job_id, amount: -22.80} with no lines under it, and the next materials import would credit
   * the customer $22.80 TIMES MARKUP for parts nothing says they were ever charged for. The guard
   * refuses that row at the paper and typing doors; the card may not draw what Apply refuses.
   */
  it("fits money out as a cost on the job, and refuses money in in the cost guard's own words", () => {
    const job = { choice: "job", jobId: "job-kitchen" } as const;
    expect(choiceFits(job, "out")).toBe(true);
    expect(jobRefusalFor("out")).toBeNull();
    // Not the bucket answer's rule: a bucket IS the company's own book, and a refund comes off it.
    expect(choiceFits({ choice: "cost", bucket: "Fuel" }, "in")).toBe(true);
    expect(choiceFits(job, "in")).toBe(false);
    // THE SENTENCE IS THE GUARD'S, word for word, plus this door's next step — never invented here.
    const why = jobRefusalFor("in")!;
    expect(why.startsWith(RETURN_ON_JOB_WHY)).toBe(true);
    expect(why).toContain("credit paper on that job");
    // NO DEAD DOOR: the credit's row and every money-in list leave the job out, so nobody taps a
    // button that can only refuse. A bucket refund is still right there.
    const { view, plan, group, books } = sortOf(CREDITED);
    expect(view.rows[0].direction).toBe("in");
    expect(JSON.stringify(view.rows[0].others)).not.toContain("job:");
    expect(JSON.stringify(view.otherInSingle)).not.toContain("job:");
    expect(JSON.stringify(view.otherIn)).not.toContain("job:");
    expect(view.rows[0].others!.some((b) => b.label === "Refund: Tools & Supplies")).toBe(true);
    // AND A HAND-MADE PICK IS REFUSED, in the same sentence: the card is not the boundary.
    const refused = validPicks({ [group.id]: "job:job-kitchen" }, plan, books);
    expect(refused.ok.size).toBe(0);
    expect(refused.refused[0]).toContain(RETURN_ON_JOB_WHY);
  });

  it("is offered ONLY on a row that is one line, only going out, and never as a quick button", () => {
    const single = everyChoice("out", ORG_BOOKS(), true).map(choiceId);
    const several = everyChoice("out", ORG_BOOKS(), false).map(choiceId);
    expect(single).toContain("job:job-kitchen");
    expect(single).toContain("job:job-shop");
    expect(several.some((id) => id.startsWith("job:"))).toBe(false);
    // The everyday answers keep their places: the jobs are added, never put in front.
    expect(single.slice(0, several.length)).toEqual(several);
    // Money in is offered no job, one line or several.
    for (const only of [true, false]) expect(everyChoice("in", ORG_BOOKS(), only).some((c) => c.choice === "job")).toBe(false);
    // THREE TRIPS TO ONE SUPPLY HOUSE are ONE row of three lines, and it offers no job: one tap must
    // never put three jobs' material on one job.
    const { view } = sortOf(THREE_TRIPS);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].single).toBe(false);
    expect(view.otherOut.some((b) => b.id.startsWith("job:"))).toBe(false);
    expect(view.otherOutSingle.some((b) => b.id.startsWith("job:"))).toBe(true);
    // No row's guess or button is ever a job: there is no way to guess WHICH job.
    const guessed = [...view.rows.flatMap((r) => r.buttons.map((b) => b.id)), ...sortOf(BOUGHT).view.rows.flatMap((r) => [...r.buttons.map((b) => b.id), r.guess ?? ""])];
    expect(guessed.some((id) => id.startsWith("job:"))).toBe(false);
  });

  /**
   * ONE CARD, ONE COPY OF THE JOB LIST. A company may have 500 live jobs (BANK_JOBS) and a statement
   * may hold forty single deposits — each of which is a question row of its own. A job list rebuilt
   * into every one of those rows' Other… lists ships the same 500 buttons forty times in the page's
   * props, on every load and every revalidate, when only the ONE row being answered needs a list at
   * all. The jobs ride in the shared money-out list, once.
   */
  it("hands the browser each job once, however many rows the statement has", () => {
    const deposits = ["Date,Description,Amount"];
    for (let d = 1; d <= 12; d++) deposits.push(`09/${String(d).padStart(2, "0")}/2026,DEPOSIT,${100 + d}.00`);
    const books = ORG_BOOKS();
    const { view } = sortOf(`${deposits.join("\n")}\n`, books);
    // Every one of them is its own row, and each is one line (so each would have taken a job list).
    expect(view.rows).toHaveLength(12);
    expect(view.rows.every((r) => r.direction === "in" && r.single)).toBe(true);
    for (const j of books.jobs) {
      const times = JSON.stringify(view).split(`job:${j.id}`).length - 1;
      expect(times, `${j.label} rides in the card ${times} times`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * NEVER A RULE. `learnable` is worked out BEFORE a merchant's lines are grouped, so a row that turns
   * out to hold one line can still be learnable — which means nothing but learnableAnswer stands
   * between a job pick and "this merchant is always this job", spending one job's money on another's
   * for ever. Both halves are pinned here: the row IS learnable, and the answer is not.
   */
  it("is never learned as a rule, even on a row a rule could be learned from", async () => {
    const { group } = sortOf(BOUGHT);
    expect(group.single).toBe(true);
    expect(group.learnable).toBe(true);
    expect(learnableAnswer({ choice: "job", jobId: "job-kitchen" }, "out")).toBe(false);
    expect(learnableAnswer({ choice: "invoice", invoiceId: "inv-1" }, "in")).toBe(false);
    expect(learnableAnswer({ choice: "other_income" }, "in")).toBe(false);
    expect(learnableAnswer({ choice: "cost", bucket: "Fuel" }, "out")).toBe(true);
    expect(learnableAnswer({ choice: "draw" }, "out")).toBe(true);
    // MONEY IN LEARNS ONLY THE TWO ANSWERS THAT ARE TRUE OF A MERCHANT EVERY TIME (0376), and the list
    // says so rather than the apply loop: Already Counted, and the owner's own money going in.
    expect(learnableAnswer({ choice: "not_income" }, "in")).toBe(true);
    expect(learnableAnswer({ choice: "owner_in" }, "in")).toBe(true);
    expect(learnableAnswer({ choice: "cost", bucket: "Fuel" }, "in")).toBe(false);
    // Each of the owner's two words goes ONE way only, so neither can be learned for the other
    // direction - bank_rules_income_is_in (0376) refuses exactly these two rows.
    expect(learnableAnswer({ choice: "owner_in" }, "out")).toBe(false);
    expect(learnableAnswer({ choice: "draw" }, "in")).toBe(false);
    // A rule row that somehow carried the word places nothing: its lines ask, every time.
    expect(ruleChoice({ id: "r", direction: "out", key: "supply", choice: "job", bucket: null, supplierAccountId: null, profileId: null }, ORG_BOOKS())).toBeNull();
    // And the one door that learns reads it, so it cannot be forgotten there.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/(app)/bills/bank-core.ts", "utf8")).toContain("!learnableAnswer(w.choice, g.direction)");
  });

  it("refuses a job that isn't this company's, and a job on a row that is several lines", () => {
    const { plan, group, books } = sortOf(BOUGHT);
    expect(validPicks({ [group.id]: "job:job-kitchen" }, plan, books).ok.get(group.id)).toEqual({ choice: "job", jobId: "job-kitchen" });
    const stranger = validPicks({ [group.id]: "job:another-companys-job" }, plan, books);
    expect(stranger.ok.size).toBe(0);
    expect(stranger.refused[0]).toMatch(/that job isn't one of yours$/);
    const three = sortOf(THREE_TRIPS);
    const refused = validPicks({ [three.group.id]: "job:job-kitchen" }, three.plan, three.books);
    expect(refused.ok.size).toBe(0);
    expect(refused.refused[0]).toMatch(/a job goes on one line at a time$/);
    // WITH NO JOB OFFERED AT ALL (no 0375 on the database yet): nothing is on the list, and a
    // hand-made pick is refused rather than written.
    const noJobs = sortOf(BOUGHT, ORG_BOOKS({ jobs: [] }));
    expect(noJobs.view.otherOutSingle.some((b) => b.id.startsWith("job:"))).toBe(false);
    expect(JSON.stringify(noJobs.view)).not.toContain("job:");
    expect(validPicks({ [noJobs.group.id]: "job:job-kitchen" }, noJobs.plan, noJobs.books).ok.size).toBe(0);
  });

  it("puts the money on the job with no bucket beside it, and draws it where job money is drawn", () => {
    // THE TWO FIELDS ON THE BILLS ROW, from the answer the line holds: the one rule Apply writes with
    // and Undo checks against.
    expect(billPlacement(storedAnswer({ choice: "job", jobId: "job-kitchen" }))).toEqual({ job_id: "job-kitchen", category: null });
    expect(billPlacement(storedAnswer({ choice: "cost", bucket: "Fuel" }))).toEqual({ job_id: null, category: "Fuel" });
    expect(billPlacement(storedAnswer(null))).toEqual({ job_id: null, category: null });
    // THE LINE'S OWN ROW: the word and the job, inseparable (0375's bank_lines_job_named). The key is
    // on the row only when a job was named, so a database without the column is never sent it.
    expect(storedAnswer({ choice: "job", jobId: "job-kitchen" })).toMatchObject({ choice: "job", job_id: "job-kitchen", bucket: null, invoice_id: null });
    expect("job_id" in storedAnswer({ choice: "cost", bucket: "Fuel" })).toBe(false);
    expect("job_id" in storedAnswer(null)).toBe(false);
    // WHERE THE MONEY WENT: the same segment a bill already on a job draws, by the P&L's own words.
    expect(flowLabelOf("job", null)).toEqual({ key: "materials", label: "Materials & Bills" });
  });
});

/**
 * WHERE YOUR MONEY CAME IN, ON THE CARD (0376's lane). The pure arithmetic is pinned in
 * bank-money-in.test.ts; this is the part that has to be true of the DOWNLOAD: the block is on the card
 * above the rows, its left-hand column is every payment of the period (not the ones a match may still
 * claim), and a deposit's guess shows the channel's working instead of asking to be believed.
 *
 * The fixture statement carries one card payout (STRIPE TRANSFER $485.40), one swept app balance (VENMO
 * CASHOUT $300.00) and one deposit whose words say nothing at all (DEPOSIT $1,275.00).
 */
describe("where your money came in", () => {
  /** An invented month of payments behind that statement. */
  const PERIOD = [
    { cents: 50_000, day: "2026-09-16", method: "card", feeCents: 1_460 },
    { cents: 30_000, day: "2026-09-19", method: "venmo", feeCents: null },
    { cents: 20_000, day: "2026-09-06", method: "cash", feeCents: null },
    { cents: 12_750, day: "2026-09-04", method: "", feeCents: null },
  ];
  const booksWith = (over: Partial<BankBooks> = {}) => ORG_BOOKS({ periodPayments: PERIOD, ...over });
  const cardOf = (books = booksWith()) => {
    const dl = download();
    return bankViewOf(dl, planBankDownload(dl, books), books);
  };

  it("says per channel what was recorded and what should reach THIS account", () => {
    const ch = cardOf().channels!;
    expect(ch.rows.map((r) => [r.key, r.recordedCents, r.expectedCents])).toEqual([
      ["card", 50_000, 48_540],
      ["venmo", 30_000, 30_000],
      ["cash", 20_000, 0],
      [NOT_SAID, 12_750, null],
    ]);
    // Cash is a statement, not a row to balance; the method nobody wrote down is in no total.
    expect(ch.expectedCents).toBe(48_540 + 30_000);
    expect(ch.unsaidCents).toBe(12_750);
  });

  it("compares it with the download's own money in, and never with its money out", () => {
    const ch = cardOf().channels!;
    // The three deposits on the statement, and nothing else: a charge is not money that came in.
    expect(ch.reachedCents).toBe(48_540 + 30_000 + 127_500);
    // The one deposit whose words name no way of being paid is said on its own.
    expect(ch.unnamedCents).toBe(127_500);
    // AND THE $127.50 NOBODY WROTE THE METHOD OF IS NAMED BESIDE THE ALL-CLEAR, not left to the rows: read
    // alone, "everything you were paid ... did" is heard as a verification of the lot.
    expect(ch.say).toBe(
      "Everything you were paid that should reach this account did, and $1,275.00 more came in besides. Another $127.50 doesn't say how it was paid, so there was nothing to check it against.",
    );
  });

  it("does not move when a line is applied, because it reads EVERY payment of the period", () => {
    // `payments` is the unmarked rows only - what a match may still claim - so it shrinks with every
    // Apply. Reading the channel view off it would make "what you were paid" fall as he sorted.
    const bare = cardOf(booksWith({ payments: [] })).channels!;
    const withSome = cardOf(
      booksWith({ payments: [{ id: "p1", invoiceId: "i1", invoiceNumber: "INV-1001", cents: 127_500, day: "2026-09-04", method: "check", feeCents: null, stripe: false }] }),
    ).channels!;
    expect(withSome.rows).toEqual(bare.rows);
    expect(withSome.recordedCents).toBe(bare.recordedCents);
  });

  it("has nothing to say, and says nothing, where there is nothing worked out", () => {
    // No payments read (the card an office viewer who may not see owner money is handed, and the card a
    // failed read gives) and no money in: a block of dashes is a dead end, so there is no block.
    expect(channelViewOf({ from: "2026-09-01", to: "2026-09-30", lines: [] }, {})).toBeNull();
    expect(channelViewOf({ from: null, to: null, lines: download().lines }, { periodPayments: PERIOD })).toBeNull();
    const dl = download();
    expect(bankViewOf({ ...dl, lines: [] }, planBankDownload({ ...dl, lines: [] }, ORG_BOOKS()), ORG_BOOKS()).channels).toBeNull();
  });

  it("draws no block at all on a CREDIT CARD'S own statement", () => {
    // This reader takes card downloads, and the only money IN on one is the company paying its own card
    // off - which guessFor already calls not income. Compared with what customers paid in those days, the
    // block announced the whole month's takings as missing from an account none of it was ever going to
    // reach: "$8,000.00 of what you were paid hasn't reached this account", about a credit card.
    const cardDl = download(
      `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-09-02,2026-09-03,5678,GAS AND GO 12,Gas/Automotive,62.10,
2026-09-20,2026-09-21,5678,AUTOPAY PAYMENT THANK YOU,Payment/Credit,,2000.00
`,
      "card.csv",
    );
    const cardBooks = ORG_BOOKS({ periodPayments: [{ cents: 1_000_000, day: "2026-09-10", method: "check", feeCents: null }] });
    expect(channelViewOf(cardDl, cardBooks)).toBeNull();
    expect(bankViewOf(cardDl, planBankDownload(cardDl, cardBooks), cardBooks).channels).toBeNull();
    // A PAYOUT OF CUSTOMERS' MONEY KEEPS THE BLOCK, because a processor's words are customers' money
    // arriving - the same pair of tests guessFor asks, so there is one rule.
    const payoutDl = download(
      `Date,Description,Amount
09/20/2026,STRIPE TRANSFER 0920,2000.00
`,
      "Checking2.csv",
    );
    expect(channelViewOf(payoutDl, cardBooks)).not.toBeNull();
  });

  it("A GUESS SHOWS ITS WORKING: a deposit the statement names gets the channel's own figures", () => {
    const rows = cardOf().rows;
    const stripe = rows.find((r) => r.title.includes("STRIPE"))!;
    expect(stripe.hint).toBe("Card: $500.00 this period. A payout lands days later: $485.40 after $14.60 of fees. The statement names exactly that much.");
    const venmo = rows.find((r) => r.title.includes("VENMO"))!;
    expect(venmo.hint).toContain("Venmo: $300.00 this period.");
    // AND IT DOES NOT SAY THE MONEY IS STILL IN VENMO over a statement that names the cashout in full: the
    // clause after it proves the one before it, which is the whole of what a shown working is for.
    expect(venmo.hint).toContain("Already moved to the bank, not sitting in Venmo. The statement names exactly that much.");
    expect(venmo.hint).not.toContain("until somebody moves it");
  });

  it("and says NOTHING on a deposit whose words name no channel", () => {
    // Erik's $7,714.09 case: three deposits from his personal account were customers paying his Venmo.
    // "It looks like a deposit" is not a reason, so the row carries none.
    const plain = cardOf().rows.find((r) => r.title.startsWith("Deposit"))!;
    expect(plain.hint).toBeNull();
  });

  it("a payment of this very money already in North still wins the line, as the more exact reason", () => {
    const books = booksWith({
      payments: [{ id: "p1", invoiceId: "i1", invoiceNumber: "INV-1001", cents: 48_540, day: "2026-09-16", method: "card", feeCents: null, stripe: true }],
    });
    const stripe = cardOf(books).rows.find((r) => r.title.includes("STRIPE"))!;
    expect(stripe.hint).toMatch(/^Maybe the payment on INV-1001 /);
  });
});

/**
 * MONEY IN FROM THE OWNER (0376): the mirror of Owner's Draw. Money OUT to him has been an answer since
 * 0363; money IN from him could only be filed as Other Income, which is inside Revenue, so his Revenue
 * and his bottom line read high by every cent he put in.
 */
describe("the owner's own money going in", () => {
  const NAMES = namesOf(ORG_BOOKS());

  it("reads back exactly, and is said in the words that pair with Owner's Draw", () => {
    expect(choiceId({ choice: "owner_in" })).toBe("owner_in");
    expect(parseChoiceId("owner_in")).toEqual({ choice: "owner_in" });
    expect(parseChoiceId("owner_in:something")).toBeNull();
    expect(choiceLabel({ choice: "owner_in" }, NAMES)).toBe("Owner's Money In");
    expect(choiceLabel({ choice: "draw" }, NAMES)).toBe("Owner's Draw");
  });

  it("goes ONE way only, the mirror of the draw, at both ends", () => {
    expect(choiceFits({ choice: "owner_in" }, "in")).toBe(true);
    expect(choiceFits({ choice: "owner_in" }, "out")).toBe(false);
    expect(choiceFits({ choice: "draw" }, "out")).toBe(true);
    expect(choiceFits({ choice: "draw" }, "in")).toBe(false);
    // On the card: in the money-in Other... list, and nowhere on money out.
    const ins = everyChoice("in", ORG_BOOKS(), true).map(choiceId);
    expect(ins).toContain("owner_in");
    expect(everyChoice("out", ORG_BOOKS(), true).map(choiceId)).not.toContain("owner_in");
    // AFTER Already Counted: his own first case looked like a contribution and was a customer's payment,
    // so the answer a hand reaches first stays the one that is right more often.
    expect(ins.indexOf("owner_in")).toBeGreaterThan(ins.indexOf("not_income"));
  });

  it("IS NEVER THE GUESS, on any line of the statement", () => {
    const dl = download();
    for (const l of dl.lines) expect(guessFor(l, ORG_BOOKS())?.choice, l.description).not.toBe("owner_in");
    const plan = planBankDownload(dl, ORG_BOOKS());
    for (const g of plan.groups) expect(g.guess, g.label).not.toBe("owner_in");
  });

  it("writes NO row: the bank line IS the record, exactly like the draw", () => {
    expect(storedAnswer({ choice: "owner_in" })).toEqual({ choice: "owner_in", bucket: null, supplier_account_id: null, profile_id: null, invoice_id: null });
    expect("job_id" in storedAnswer({ choice: "owner_in" })).toBe(false);
    expect(billPlacement(storedAnswer({ choice: "owner_in" }))).toEqual({ job_id: null, category: null });
    expect(storedChoice({ choice: "owner_in" })).toBe("owner_in");
    expect(storedChoiceName("owner_in")).toBe("owner_in");
  });

  it("MAY be learned as a rule, and a rule row holding it places the answer", () => {
    // Unlike a job (0375), "a transfer from my own other account is money I put in" is true of that
    // account every time - which is why 0376 taught bank_rules_income_is_in the word.
    const r: BooksRule = { id: "r-own", direction: "in", key: "transfer 9876", choice: "owner_in", bucket: null, supplierAccountId: null, profileId: null };
    expect(ruleChoice(r, ORG_BOOKS())).toEqual({ choice: "owner_in" });
  });

  it("the database allows the word on both tables, and only one way round (0376)", () => {
    const sql = readFileSync(fileURLToPath(new URL("../../supabase/migrations/0376_rent_is_a_bucket_and_money_can_come_from_the_owner.sql", import.meta.url)), "utf8");
    // THE CHOICE LISTS: a word the card offers that the database refuses is a raw error mid-Apply.
    const lists = [...sql.matchAll(/choice in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((w) => w[1]));
    expect(lists.length).toBeGreaterThanOrEqual(3);
    for (const list of lists) expect(list).toContain("owner_in");
    // AND THE DIRECTION RULE, which is the teeth behind choiceFits: a money-in rule carries a money-in
    // answer and nothing else, and owner_in is one of them.
    expect(sql).toMatch(/\(direction = 'in'\) = \(choice in \('other_income', 'not_income', 'owner_in'\)\)/);
  });

  it("is refused on a line of money going OUT, in the door's own words", () => {
    const dl = download();
    const plan = planBankDownload(dl, ORG_BOOKS());
    const out = plan.groups.find((g) => g.direction === "out")!;
    const res = validPicks({ [out.id]: "owner_in" }, plan, ORG_BOOKS());
    expect(res.ok.size).toBe(0);
    expect(res.refused[0]).toContain("that answer doesn't fit money out");
  });
});
