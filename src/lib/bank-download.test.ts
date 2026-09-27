import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCSV } from "@/lib/csv";
import {
  bankHeadline,
  bankViewOf,
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
  readBankTable,
  redactDigits,
  ruleFor,
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
XXXXX1234,09/12/2026,,1111-SIMPLY INSURED CO,31.90,,Posted,9721.70
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

  it("an unsigned Amount with a Debit/Credit type column reads the type", () => {
    const dl = readBankTable(parseCSV(`Date,Description,Amount,Type\n09/01/2026,SHOP RENT,650.00,Debit\n09/02/2026,CUSTOMER DEPOSIT,900.00,Credit\n`), "x.csv", hash)!;
    expect(dl.lines.map((l) => l.cents)).toEqual([-65000, 90000]);
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
  });
});

describe("privacy: what is kept of a line", () => {
  it("cuts every run of 6+ digits to its last 4, even printed in groups", () => {
    expect(redactDigits("ACH DEBIT 123456789012")).toBe("ACH DEBIT ••9012");
    expect(redactDigits("CARD 4111-1111-1111-1234 SHELL")).toBe("CARD ••1234 SHELL");
    expect(redactDigits("CALL 775 555 1234")).toBe("CALL ••1234");
    // Short numbers stay: a store number, a check, a card's last 4.
    expect(redactDigits("1111-SHELL 10068 ANYTOWN")).toBe("1111-SHELL 10068 ANYTOWN");
    expect(cleanDescription("ONLINE   TRANSFER TO CHK XXXXXX9876 REF #IB0123456789")).toBe("ONLINE TRANSFER TO CHK XXXXXX9876 REF #IB••6789");
    const dl = download();
    for (const l of dl.lines) expect(l.description).not.toMatch(/\d{6,}/);
    expect(JSON.stringify(dl)).not.toContain("0123456789");
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
    expect(plan.groups.find((g) => g.label.includes("SIMPLY INSURED"))!.guess).toBe("cost:Insurance & Licenses");
    expect(plan.groups.find((g) => g.label.includes("SERVICE FEE"))!.guess).toBe("cost:Fees");
    expect(plan.groups.find((g) => g.label.includes("ATM"))!.guess).toBe("petty_cash");
    expect(plan.groups.find((g) => g.label.includes("ONLINE TRANSFER"))!.guess).toBe("draw");
    // Nothing the words know: no guess, and the row still asks.
    expect(plan.groups.find((g) => g.label.includes("DENTAL"))!.guess).toBeNull();
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
});

describe("the card and the person's answers", () => {
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
    const wrong = validPicks({ [shell.id]: "other_income", [dep.id]: "cost:Fees" }, plan, books);
    expect(wrong.ok.size).toBe(0);
    expect(wrong.refused).toHaveLength(2);
    const stranger = validPicks({ [shell.id]: "crew:not-our-person" }, plan, books);
    expect(stranger.refused[0]).toMatch(/isn't on your crew/);
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
