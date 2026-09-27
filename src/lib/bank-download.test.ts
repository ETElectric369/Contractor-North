import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCSV } from "@/lib/csv";
import {
  bankHeadline,
  bankViewOf,
  branchFromNumbers,
  choiceId,
  cleanDescription,
  findBankHeader,
  guessFor,
  isBareCheck,
  lineNamesAccount,
  looksLikeBankTable,
  merchantKeyOf,
  parseChoiceId,
  planBankDownload,
  noLinesSaid,
  sayGroupMoney,
  readBankDate,
  readBankMoney,
  readBankTable,
  redactDigits,
  ruleFor,
  depositKindOf,
  swapDownloadSigns,
  last4FromName,
  withAccountLast4,
  validPicks,
  type BankBooks,
  type BankDownload,
  type BooksRule,
} from "./bank-download";
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
const CHECKING_CSV = `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance
XXXXX1234,09/25/2026,,MONTHLY SERVICE FEE,12.00,,Posted,9000.00
XXXXX1234,09/24/2026,,DENTAL CARE LLC,150.00,,Posted,9012.00
XXXXX1234,09/23/2026,,1111-HOME HARDWARE #55 ANYTOWN,45.10,,Posted,9162.00
XXXXX1234,09/22/2026,,CONTRACTOR SUPPLY CO PMT CS-12345,1000.00,,Posted,9207.10
XXXXX1234,09/20/2026,,VENMO CASHOUT,,300.00,Posted,10207.10
XXXXX1234,09/18/2026,,STRIPE TRANSFER ST-AB12,,485.40,Posted,9907.10
XXXXX1234,09/16/2026,,1111-SHELL 123 ANYTOWN ST,100.00,,Posted,9421.70
XXXXX1234,09/15/2026,,ATM WITHDRAWAL 000123 MAIN ST,200.00,,Posted,9521.70
XXXXX1234,09/12/2026,,1111-ACME INSURANCE CO,31.90,,Posted,9721.70
XXXXX1234,09/10/2026,,ONLINE TRANSFER TO CHK XXXXXX9876 REF #IB0123456789,2000.00,,Posted,9746.07
XXXXX1234,09/09/2026,,1111-SHELL 456 OTHERTOWN,100.00,,Posted,11746.07
XXXXX1234,09/05/2026,1043,CHECK,640.00,,Posted,11846.07
XXXXX1234,09/04/2026,,DEPOSIT,,1275.00,Posted,12441.07
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
    const plan = planBankDownload(dl, ORG_BOOKS({ already: new Map([[fee.key, { choice: "cost", bucket: "Fees", costKind: null, amountCents: -1200 }]]) }));
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

  it("a fill-up already on the books is tagged Fuel by the company's answer for that merchant, never by its words alone", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount\n09/12/2026,1111-CORNER STORE ANYTOWN,-138.62\n09/14/2026,1111-SHELL OIL ANYTOWN,-60.00\n`), "x.csv", hash)!;
    const bill = (id: string, cents: number, supplier: string) => ({ id, cents, day: "2026-09-12", supplier, jobId: null, category: "Gas & Truck", onAccount: false, costKind: null });
    const books = ORG_BOOKS({
      bills: [bill("b-store", 13862, "Corner Store"), { ...bill("b-shell", 6000, "Shell Oil"), day: "2026-09-14" }],
      rules: [{ id: "r-store", direction: "out", key: "corner", choice: "cost", bucket: "Gas & Truck", costKind: "fuel", supplierAccountId: null, profileId: null, minCents: 12000, maxCents: 14000 }],
    });
    const plan = planBankDownload(dl, books);
    expect(plan.dispositions.get(dl.lines[0].key)).toMatchObject({ how: "match", ids: ["b-store"], tag: "fuel" });
    // No answer for SHELL yet: matched, untagged (the person's tap on a later SHELL row is what says).
    expect(plan.dispositions.get(dl.lines[1].key)).toMatchObject({ how: "match", ids: ["b-shell"] });
    expect((plan.dispositions.get(dl.lines[1].key) as { tag?: string }).tag).toBeUndefined();
  });

  it("one bill is matched once, even when two lines could take it", () => {
    const dl = download();
    const books = ORG_BOOKS({ bills: [{ id: "b-shell", cents: 10000, day: "2026-09-12", supplier: "Shell", jobId: null, category: "Gas & Truck", onAccount: false }] });
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

describe("the company's own rules", () => {
  const rule = (over: Partial<BooksRule>): BooksRule => ({ id: "r", direction: "out", key: "shell", choice: "cost", bucket: "Gas & Truck", costKind: "fuel", supplierAccountId: null, profileId: null, ...over });

  it("a rule the company made places every line of that merchant, and the longest key wins", () => {
    const dl = download();
    const books = ORG_BOOKS({
      rules: [
        rule({ id: "r-shell", key: "shell" }),
        rule({ id: "r-draw", key: "transfer 9876", choice: "draw", bucket: null, costKind: null }),
        rule({ id: "r-home", key: "home", choice: "personal", bucket: null, costKind: null }),
        rule({ id: "r-home-hw", key: "home hardware", choice: "cost", bucket: "Tools & Supplies", costKind: null }),
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
        rule({ id: "r-in", direction: "in", key: "shell", choice: "other_income", bucket: null, costKind: null }),
        rule({ id: "r-check", key: "check", choice: "personal", bucket: null, costKind: null }),
        rule({ id: "r-dep", direction: "in", key: "deposit", choice: "other_income", bucket: null, costKind: null }),
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
        rule({ id: "r-reg", direction: "in", key: "regular", choice: "other_income", bucket: null, costKind: null }),
        rule({ id: "r-acme", direction: "in", key: "acme", choice: "other_income", bucket: null, costKind: null }),
        rule({ id: "r-jane", direction: "in", key: "jane", choice: "not_income", bucket: null, costKind: null }),
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

  it("a rule for a supplier or a person no longer here is not used", () => {
    const dl = download();
    const plan = planBankDownload(dl, ORG_BOOKS({ rules: [rule({ id: "r-gone", key: "dental", choice: "crew", bucket: null, costKind: null, profileId: "someone-gone" })] }));
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
    expect(shell.guess).toBe("cost:Gas & Truck:fuel");
    expect(shell.buttons).toEqual(["cost:Gas & Truck:fuel", "cost:Gas & Truck:truck", "personal"]);
    expect(plan.groups.find((g) => g.label.includes("ACME INSURANCE"))!.guess).toBe("cost:Insurance & Licenses");
    expect(plan.groups.find((g) => g.label.includes("SERVICE FEE"))!.guess).toBe("cost:Fees");
    expect(plan.groups.find((g) => g.label.includes("ATM"))!.guess).toBe("petty_cash");
    expect(plan.groups.find((g) => g.label.includes("ONLINE TRANSFER"))!.guess).toBe("draw");
    // Nothing the words know: no guess, and the row still asks.
    expect(plan.groups.find((g) => g.label.includes("DENTAL"))!.guess).toBeNull();
  });

  it("a bare Withdrawal is never an ATM, and Point Of Sale never a merchant", () => {
    const line = (description: string, cents = -6210) => ({ row: 2, postedOn: "2026-09-10", cents, description, check: null, last4: null, merchantKey: merchantKeyOf(description), key: "k" });
    const books = ORG_BOOKS();
    expect(guessFor(line("POINT OF SALE WITHDRAWAL SHELL OIL 57444 ANYTOWN CA"), books)).toEqual({ choice: "cost", bucket: "Gas & Truck", costKind: "fuel" });
    expect(guessFor(line("Withdrawal POS #123456 SHELL OIL"), books)).toEqual({ choice: "cost", bucket: "Gas & Truck", costKind: "fuel" });
    expect(guessFor(line("ONLINE TRANSFER WITHDRAWAL TO XXXXXX9876"), books)).toEqual({ choice: "draw" });
    expect(guessFor(line("Withdrawal ACH ACME INSURANCE"), books)).toEqual({ choice: "cost", bucket: "Insurance & Licenses", costKind: null });
    expect(guessFor(line("ATM WITHDRAWAL 000123 MAIN ST"), books)).toEqual({ choice: "petty_cash" });
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
    expect(guessFor(lineBy(dl, "SHELL 456"), books)).toEqual({ choice: "cost", bucket: "Gas & Truck", costKind: "fuel" });
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
      already: new Map([[fee.key, { choice: "cost", bucket: "Fees", costKind: null, amountCents: -1200 }]]),
      payments: [{ id: "pay-1", invoiceId: "inv-1", invoiceNumber: "INV-1001", cents: 127500, day: "2026-09-03", method: "check", feeCents: null, stripe: false }],
      rules: [{ id: "r", direction: "out", key: "shell", choice: "cost", bucket: "Gas & Truck", costKind: "fuel", supplierAccountId: null, profileId: null }],
    });
    const plan = planBankDownload(dl, books);
    expect(bankHeadline(dl, plan.counts, "2026-09-27")).toBe("Bank ••1234 · Sep 2–Sep 25 · 4 sorted · 1 already in North · 9 need you");
    const view = bankViewOf(dl, plan, books, { today: "2026-09-27" });
    expect(view.rows.map((r) => r.title)).toContain("Check 1043");
    expect(view.flow.find((s) => s.key === "fuel")!.cents).toBe(28845);
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
      { [shell.id]: "cost:Gas & Truck:fuel", [dep.id]: "invoice:inv-1", "out:nobody": "personal" },
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

  it("choice ids read back exactly, and a kind rides only on Gas & Truck", () => {
    for (const id of ["cost:Gas & Truck:fuel", "cost:Fees", "draw", "personal", "petty_cash", "not_cost", "other_income", "not_income", "crew:abcdef12", "supplier:abcdef12", "invoice:abcdef12"]) {
      expect(choiceId(parseChoiceId(id)!)).toBe(id);
    }
    expect(parseChoiceId("cost:Fees:fuel")).toBeNull();
    expect(parseChoiceId("cost:Seventh Bucket")).toBeNull();
    expect(parseChoiceId("drawx")).toBeNull();
  });
});
