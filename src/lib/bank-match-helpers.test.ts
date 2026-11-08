import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PREFIX_COVERAGE,
  ACCOUNT_PREFIX_FLOOR,
  SUPPLIER_PREFIX_FLOOR,
  RETURN_WINDOW_DAYS,
  WORKED_DAYS_BACK,
  jobWorkedNear,
  jobsWorkedOn,
  lineNamesAccount,
  lineNamesSupplier,
  onAccountForMatch,
  prefixNames,
  returnOfCharge,
  sameMoneyBill,
  shiftDay,
  type BankBooks,
  type BooksAccount,
  type BooksBill,
  type ChargeLine,
  type WorkedDay,
} from "./bank-download";

/**
 * THE COUNTER MATCH'S HELPERS (cn-v1154), each pinned by a table. Every store, company, person and
 * number here is MADE UP: Thistlewood Hardware, Bayberry Supply, the Larkspur and Snowbell jobs, Sam
 * Tillery's punches. Nothing comes from any company's real bank file or books.
 */

const line = (cents: number, postedOn: string, description: string) => ({ cents, postedOn, description });

const bill = (over: Partial<BooksBill> & Pick<BooksBill, "id" | "cents" | "day">): BooksBill => ({
  supplier: "Thistlewood Hardware",
  jobId: null,
  category: "Receipt",
  onAccount: false,
  ...over,
});

const account = (over: Partial<BooksAccount> = {}): BooksAccount => ({
  id: "acct-bayberry",
  name: "Bayberry Supply",
  number: null,
  branch: null,
  onAccount: true,
  aliases: [],
  ...over,
});

describe("a bank's cut-short word opens the name's word", () => {
  it("names a supplier 3 letters up with nothing more asked, and a noise word names nobody", () => {
    const cases: [string, string, number, boolean][] = [
      // The acceptance cases.
      ["HARDWAR", "Hardware", SUPPLIER_PREFIX_FLOOR, true],
      ["SUP", "Supply", SUPPLIER_PREFIX_FLOOR, true],
      ["HD", "Hardware", SUPPLIER_PREFIX_FLOOR, false], // too short
      // A short start of a long word is a supplier's: the same cents on the same days gate that match.
      ["HOMES", "Homestead", SUPPLIER_PREFIX_FLOOR, true],
      // The whole word is the longest prefix there is; a longer word opens nothing.
      ["hardware", "Hardware", SUPPLIER_PREFIX_FLOOR, true],
      ["hardwares", "Hardware", SUPPLIER_PREFIX_FLOOR, false],
      // Both sides are read as letters and digits only.
      ["thistle-wood", "Thistlewood", SUPPLIER_PREFIX_FLOOR, true],
      ["O'REIL", "O'Reilly", SUPPLIER_PREFIX_FLOOR, true],
      // Words that name nobody: the bank's noise, the way the money went, a word that opens a name alone.
      ["pos", "Postal Annex", SUPPLIER_PREFIX_FLOOR, false],
      ["card", "Cardinal Electric", SUPPLIER_PREFIX_FLOOR, false],
      ["purchase", "Purchase Power", SUPPLIER_PREFIX_FLOOR, false],
      ["online", "Online Metals", SUPPLIER_PREFIX_FLOOR, false],
      ["transfer", "Transfer Flow", SUPPLIER_PREFIX_FLOOR, false],
      ["the", "Theodore Supply", SUPPLIER_PREFIX_FLOOR, false],
      // Nothing opens nothing, whatever the floor.
      ["", "Hardware", 0, false],
      ["HARD", "", SUPPLIER_PREFIX_FLOOR, false],
    ];
    for (const [bank, target, floor, want] of cases) expect([bank, target, floor, prefixNames(bank, target, floor)]).toEqual([bank, target, floor, want]);
  });

  it("names an account 5 letters up, and only when they are most of the word: a guess has no money gate", () => {
    // The floor was four and BAYB opened Bayberry (skeptic #58): by the same rule "homes" opened
    // "Homestead", and Pay Homestead would have been the guess on any store that starts the same way.
    // An account asks for five letters AND six of every ten letters of the word they open.
    const cases: [string, string, boolean, string][] = [
      ["HARDWAR", "Hardware", true, "seven of eight letters"],
      ["BAYBE", "Bayberry", true, "five of eight letters, 62%"],
      ["BAYB", "Bayberry", false, "four letters are under the floor, whatever they cover (true at the floor of four)"],
      ["SUP", "Supply", false, "three are too"],
      ["HOMES", "Homestead", false, "five of nine letters, 55%: most of the word is missing"],
      ["HOMEST", "Homestead", true, "six of nine, 66%"],
      ["THISTL", "Thistlewood", false, "six of eleven, 54%"],
      ["THISTLE", "Thistlewood", true, "seven of eleven, 63%"],
      ["supply", "Supply", true, "the whole word"],
      ["online", "Online", false, "a word that names nobody names nobody, whole word or not"],
    ];
    for (const [bank, target, want, why] of cases) expect([bank, target, prefixNames(bank, target, ACCOUNT_PREFIX_FLOOR, ACCOUNT_PREFIX_COVERAGE), why]).toEqual([bank, target, want, why]);
  });

  it("the floors are three for a supplier and five for an account, whose word must cover 60% of the name's", () => {
    expect(SUPPLIER_PREFIX_FLOOR).toBe(3);
    expect(ACCOUNT_PREFIX_FLOOR).toBe(5);
    expect(ACCOUNT_PREFIX_COVERAGE).toBe(60);
  });
});

describe("the line names the supplier", () => {
  it("by a word they share, the name's first five letters, or a cut-short word that opens one of its words", () => {
    const cases: [string, string, boolean][] = [
      ["1111-HARDWAR #221 ANYTOWN", "Thistlewood Hardware", true], // cut short by the bank
      ["1111-SUP 4410 ANYTOWN", "Bayberry Supply", true], // three letters are enough for a supplier
      ["1111-HD 4410 ANYTOWN", "Home Depot", false], // two are not
      ["THISTLEWOOD HARDWARE #221", "Thistlewood Hardware", true], // the rule that was already here: a shared word
      ["1111-LOWES #1234 ANYTOWN", "Lowe's", true], // and the first five letters
      ["1111-ACME DINER ANYTOWN", "Thistlewood Hardware", false], // another merchant
      ["POS DEBIT PURCHASE", "Postal Annex", false], // noise alone names nobody
      ["CHECK 1050", "Thistlewood Hardware", false], // a bare check names nobody
    ];
    for (const [description, supplier, want] of cases) expect([description, supplier, lineNamesSupplier(description, supplier)]).toEqual([description, supplier, want]);
  });
});

describe("the line names the account", () => {
  it("by a cut-short word five letters up that is most of the word, never four, and the rules that were already here still hold", () => {
    const bayberry = account({ number: "BS-4410", aliases: ["BBS"] });
    const cases: [string, boolean, string][] = [
      ["1111-BAYBE 4410 ANYTOWN", true, "five letters, most of the name's word, open it"],
      ["1111-BAYB 4410 ANYTOWN", false, "four do not (they did at the floor of four): an account drives a guess with no money gate"],
      ["1111-SUP 4410 ANYTOWN", false, "nor three"],
      ["1111-BAYBERRY #12 ANYTOWN", true, "the whole word, where the first twelve letters of the name were cut"],
      ["SUPPLY HOUSE 123", true, "a word the name carries names it; the supplier-payment match still asks for the same cents, and a guess is never picked"],
      ["PAYMENT BS-4410", true, "the account number, as before"],
      ["1111-BBS ANYTOWN", true, "a short spelling as a word of its own, as before"],
      ["1111-ABBSTORE ANYTOWN", false, "never letters inside another word, as before"],
      ["POS PURCHASE CARD", false, "noise names nobody"],
      ["1111-THISTLEWOOD HARDWARE", false, "another store"],
    ];
    for (const [description, want, why] of cases) expect([description, lineNamesAccount(description, bayberry), why]).toEqual([description, want, why]);
    // "HOMES" is five letters but 55% of "Homestead": a line from any store that starts the same way
    // must not guess Pay Homestead. The whole word still names it.
    const homestead = account({ id: "acct-homestead", name: "Homestead Builders Supply" });
    expect(lineNamesAccount("1111-HOMES 4410 ANYTOWN", homestead)).toBe(false);
    expect(lineNamesAccount("1111-HOMESTEAD 4410 ANYTOWN", homestead)).toBe(true);
  });

  it("an alias is opened the same way as the name", () => {
    const known = account({ aliases: ["Bayberry Pro Desk"] });
    expect(lineNamesAccount("1111-BAYBE PRO 4410", known)).toBe(true);
    // Four letters are under the floor even as the alias's whole word (before this wave they named
    // nothing either): "DESK" alone could be any store's.
    expect(lineNamesAccount("1111-DESK 4410", known)).toBe(false);
    expect(lineNamesAccount("1111-DES 4410", known)).toBe(false);
  });
});

describe("the receipt a bank line could be", () => {
  const used = new Set<string>();

  it("money out is a positive bill and money in a negative one, never the other way round", () => {
    const receipt = bill({ id: "b-receipt", cents: 4510, day: "2026-09-12" });
    const credit = bill({ id: "b-credit", cents: -4510, day: "2026-09-12" });
    const out = line(-4510, "2026-09-12", "1111-THISTLEWOOD HARDWARE #221");
    const back = line(4510, "2026-09-12", "THISTLEWOOD HARDWARE REFUND");
    expect(sameMoneyBill(out, [receipt, credit], used)).toEqual({ best: receipt, next: null });
    expect(sameMoneyBill(back, [receipt, credit], used)).toEqual({ best: credit, next: null });
    expect(sameMoneyBill(line(-4500, "2026-09-12", "1111-THISTLEWOOD HARDWARE #221"), [receipt], used).best).toBeNull();
    expect(sameMoneyBill(line(0, "2026-09-12", "NOTHING"), [bill({ id: "b-zero", cents: 0, day: "2026-09-12" })], used).best).toBeNull();
  });

  it("within 3 days either way: the third day is in, the fourth out, and `days` moves the edge", () => {
    const out = line(-4510, "2026-09-12", "1111-THISTLEWOOD HARDWARE #221");
    const cases: [string, boolean][] = [
      ["2026-09-09", true],
      ["2026-09-08", false],
      ["2026-09-15", true],
      ["2026-09-16", false],
    ];
    for (const [day, want] of cases) expect([day, sameMoneyBill(out, [bill({ id: "b", cents: 4510, day })], used).best !== null]).toEqual([day, want]);
    expect(sameMoneyBill(out, [bill({ id: "b", cents: 4510, day: "2026-09-10" })], used, 1).best).toBeNull();
    expect(sameMoneyBill(out, [bill({ id: "b", cents: 4510, day: "2026-09-10" })], used, 2).best?.id).toBe("b");
    // A bill with no day is nowhere near.
    expect(sameMoneyBill(out, [bill({ id: "b", cents: 4510, day: null })], used).best).toBeNull();
  });

  it("a bill already taken, or one an account pays, is never offered", () => {
    const out = line(-4510, "2026-09-12", "1111-THISTLEWOOD HARDWARE #221");
    const a = bill({ id: "b-a", cents: 4510, day: "2026-09-12" });
    const b = bill({ id: "b-b", cents: 4510, day: "2026-09-13" });
    expect(sameMoneyBill(out, [a, b], new Set(["b-a"]))).toEqual({ best: b, next: null });
    expect(sameMoneyBill(out, [bill({ id: "b-acct", cents: 4510, day: "2026-09-12", onAccount: true })], used).best).toBeNull();
  });

  it("nearest day first, then the supplier the line names, then the earlier bill, then the id; the runner-up comes too", () => {
    const out = line(-4510, "2026-09-12", "1111-THISTLEWOOD HARDWARE #221");
    const named = bill({ id: "b-named", cents: 4510, day: "2026-09-13" });
    const other = bill({ id: "b-other", cents: 4510, day: "2026-09-11", supplier: "Bayberry Supply" });
    const sameDayOther = bill({ id: "b-today", cents: 4510, day: "2026-09-12", supplier: "Bayberry Supply" });
    // Nearest wins even when the line names the farther one.
    expect(sameMoneyBill(out, [named, sameDayOther], used)).toEqual({ best: sameDayOther, next: named });
    // At the same distance, the one the line names.
    expect(sameMoneyBill(out, [other, named], used)).toEqual({ best: named, next: other });
    // Neither named: the earlier bill.
    const early = bill({ id: "b-early", cents: 4510, day: "2026-09-11", supplier: "Bayberry Supply" });
    const late = bill({ id: "b-late", cents: 4510, day: "2026-09-13", supplier: "Catbird Lumber" });
    expect(sameMoneyBill(out, [late, early], used)).toEqual({ best: early, next: late });
    // The same day and neither named: the id.
    const twinB = bill({ id: "b-2", cents: 4510, day: "2026-09-11", supplier: "Bayberry Supply" });
    const twinA = bill({ id: "b-1", cents: 4510, day: "2026-09-11", supplier: "Catbird Lumber" });
    expect(sameMoneyBill(out, [twinB, twinA], used)).toEqual({ best: twinA, next: twinB });
    // One bill: no runner-up. None: neither.
    expect(sameMoneyBill(out, [named], used)).toEqual({ best: named, next: null });
    expect(sameMoneyBill(out, [], used)).toEqual({ best: null, next: null });
  });
});

describe("a bill that must stay out of the counter match", () => {
  const onAccount = new Set(["acct-bayberry"]);
  const none = new Set<string>();
  const owedBill = { id: "b-owed", supplierAccountId: "acct-bayberry", status: "unpaid", amount: 100 };
  const paidBill = { id: "b-paid", supplierAccountId: "acct-bayberry", status: "paid", amount: 100 };

  it("stays out when its account is on account and it is still owed, or a lump payment paid it", () => {
    expect(onAccountForMatch(owedBill, onAccount, none)).toBe(true);
    expect(onAccountForMatch(paidBill, onAccount, new Set(["b-paid"]))).toBe(true);
  });

  it("a receipt paid at the register of an on-account store matches like any receipt", () => {
    expect(onAccountForMatch(paidBill, onAccount, none)).toBe(false);
  });

  it("a counter store's bill is never kept out, owed or allocated; nor is a bill on no account", () => {
    const counter = new Set(["acct-thistlewood"]);
    expect(onAccountForMatch(owedBill, counter, new Set(["b-owed"]))).toBe(false);
    expect(onAccountForMatch({ ...owedBill, supplierAccountId: null }, onAccount, new Set(["b-owed"]))).toBe(false);
  });

  // "Still owed" is the tree's ONE still-owed test (lib/supplier-owed isStillOwed, pinned there and fenced
  // by supplier-owed-one-place.test.ts): by the NUMBER when amount_paid was read — a word that disagrees
  // with the money loses — and by the status word only when the number was never read.
  it("money still open on it keeps it out whatever the status word says; with no number read, the word decides", () => {
    const cases: [string, number | null | undefined, number, boolean][] = [
      ["paid", 100, 100, false],
      ["paid", 40, 100, true],
      ["paid", null, 100, false],
      ["paid", undefined, 100, false],
      ["unpaid", 100, 100, false], // the number says nothing is open: the word is stale, the receipt matches
      ["unpaid", null, 100, true], // no number read: the word is all there is, and "unpaid" is owed
      ["paid", -50, -50, false], // a credit, used up
      ["paid", 0, -50, true], // a credit still open
    ];
    for (const [status, amountPaid, amount, want] of cases)
      expect([status, amountPaid, amount, onAccountForMatch({ id: "b", supplierAccountId: "acct-bayberry", status, amountPaid, amount }, onAccount, none)]).toEqual([status, amountPaid, amount, want]);
  });
});

describe("the job the crew was on", () => {
  // Sam Tillery and Dana Rook's punches around one week.
  const worked: WorkedDay[] = [
    { jobId: "job-larkspur", day: "2026-09-10", minutes: 240 },
    { jobId: "job-snowbell", day: "2026-09-10", minutes: 120 },
    { jobId: "job-snowbell", day: "2026-09-10", minutes: 180 }, // a second punch on the same job
    { jobId: "job-catbird", day: "2026-09-08", minutes: 60 },
    { jobId: "job-thistlewood", day: "2026-09-08", minutes: 60 },
    { jobId: "job-larkspur", day: "2026-09-14", minutes: 480 },
  ];

  it("lists a day's jobs most minutes first, both punches on one job counted together, a tie by id", () => {
    expect(jobsWorkedOn("2026-09-10", worked)).toEqual(["job-snowbell", "job-larkspur"]);
    expect(jobsWorkedOn("2026-09-08", worked)).toEqual(["job-catbird", "job-thistlewood"]);
    expect(jobsWorkedOn("2026-09-09", worked)).toEqual([]);
    expect(jobsWorkedOn("2026-09-10", [])).toEqual([]);
  });

  it("takes the day's top job, else the nearer of the two days before, never a third day back and never a day after", () => {
    expect(jobWorkedNear("2026-09-10", worked)).toEqual({ jobId: "job-snowbell", day: "2026-09-10" });
    // Nothing on the 11th: the 10th is one day back.
    expect(jobWorkedNear("2026-09-11", worked)).toEqual({ jobId: "job-snowbell", day: "2026-09-10" });
    // Nothing on the 12th or 11th: the 10th is two days back.
    expect(jobWorkedNear("2026-09-12", worked)).toEqual({ jobId: "job-snowbell", day: "2026-09-10" });
    // Nothing on the 9th: the 8th is one day back.
    expect(jobWorkedNear("2026-09-09", worked)).toEqual({ jobId: "job-catbird", day: "2026-09-08" });
    // Day minus one beats day minus two when both were worked, however long the farther day ran.
    expect(jobWorkedNear("2026-09-11", [...worked, { jobId: "job-catbird", day: "2026-09-09", minutes: 600 }])).toEqual({ jobId: "job-snowbell", day: "2026-09-10" });
    // Three days back is too far, and the 14th is after the 13th.
    expect(jobWorkedNear("2026-09-13", worked)).toBeNull();
    expect(WORKED_DAYS_BACK).toBe(2);
  });

  it("walks calendar days on the string, across a month end and a leap day", () => {
    expect(shiftDay("2026-10-01", -1)).toBe("2026-09-30");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDay("2026-09-12", 0)).toBe("2026-09-12");
    expect(jobWorkedNear("2026-10-01", [{ jobId: "job-larkspur", day: "2026-09-30", minutes: 60 }])).toEqual({ jobId: "job-larkspur", day: "2026-09-30" });
  });

  it("the books carry the clocked time as an optional list, so every older fixture still reads", () => {
    const books: Pick<BankBooks, "worked"> = {};
    expect(books.worked ?? []).toEqual([]);
    const withWork: Pick<BankBooks, "worked"> = { worked };
    expect(jobsWorkedOn("2026-09-14", withWork.worked ?? [])).toEqual(["job-larkspur"]);
  });
});

describe("the charge a refund undoes", () => {
  const charge = (over: Partial<ChargeLine> & Pick<ChargeLine, "lineKey">): ChargeLine => ({
    postedOn: "2026-09-12",
    cents: -4510,
    description: "1111-THISTLEWOOD HARDWARE #221 ANYTOWN",
    answer: { choice: "cost", bucket: "Tools & Supplies", jobId: null },
    ...over,
  });
  const refund = line(4510, "2026-09-15", "THISTLEWOOD HARDWARE #221 REFUND");

  it("says where the charge's money went: a bucket, a job, or nowhere yet", () => {
    const onBucket = charge({ lineKey: "c-bucket" });
    const onJob = charge({ lineKey: "c-job", answer: { choice: "job", bucket: null, jobId: "job-larkspur" } });
    const unanswered = charge({ lineKey: "c-none", answer: null });
    expect(returnOfCharge(refund, [onBucket])).toEqual({ charge: onBucket, state: "bucket" });
    expect(returnOfCharge(refund, [onJob])).toEqual({ charge: onJob, state: "job" });
    expect(returnOfCharge(refund, [unanswered])).toEqual({ charge: unanswered, state: "unanswered" });
    // A charge answered as no cost at all (the owner's draw, a matched bill) has nothing to put money back on.
    expect(returnOfCharge(refund, [charge({ lineKey: "c-draw", answer: { choice: "draw", bucket: null, jobId: null } })])).toBeNull();
    expect(returnOfCharge(refund, [charge({ lineKey: "c-matched", answer: { choice: "matched", bucket: null, jobId: null } })])).toBeNull();
  });

  it("the same merchant, on the refund's day or up to 7 days before it, for at least the refund's money", () => {
    const cases: [string, Partial<ChargeLine>, boolean][] = [
      ["another store", { description: "1111-BAYBERRY SUPPLY 4410" }, false],
      ["another store sharing the trade's word", { description: "1111-BAYBERRY HARDWARE 4410" }, false],
      ["the same store printed behind the bank's lead words", { description: "ONLINE PAYMENT THE THISTLEWOOD HARDWARE" }, true],
      ["the day itself", { postedOn: "2026-09-15" }, true],
      ["seven days before", { postedOn: "2026-09-08" }, true],
      ["eight days before", { postedOn: "2026-09-07" }, false],
      ["posted after the refund", { postedOn: "2026-09-16" }, false],
      ["a smaller charge", { cents: -3000 }, false],
      ["a bigger charge, refunded in part", { cents: -9000 }, true],
      ["money in is no charge", { cents: 4510 }, false],
      ["a charge with only noise for words", { description: "POS PURCHASE 4410" }, false],
    ];
    for (const [why, over, want] of cases) expect([why, returnOfCharge(refund, [charge({ lineKey: "c", ...over })]) !== null]).toEqual([why, want]);
    // THE REFUND'S FIRST WORD IS THE STORE (skeptic #58): a brand leads a bank's description and
    // "hardware" never does, so a Thistlewood refund never finds a Bayberry Hardware charge through the
    // trade's word; the store's own refund still does, and so does one printed behind a processor's
    // lead ("PP*"). A refund with only noise for words names no charge.
    const bayberryCharge = charge({ lineKey: "c-bayberry", description: "1111-BAYBERRY HARDWARE 4410 ANYTOWN" });
    expect(returnOfCharge(line(4510, "2026-09-15", "THISTLEWOOD HARDWARE REFUND"), [bayberryCharge])).toBeNull();
    expect(returnOfCharge(line(4510, "2026-09-15", "BAYBERRY HARDWARE REFUND"), [bayberryCharge])?.charge.lineKey).toBe("c-bayberry");
    expect(returnOfCharge(line(4510, "2026-09-15", "PP*THISTLEWOOD HARDWARE"), [charge({ lineKey: "c" })])?.charge.lineKey).toBe("c");
    expect(returnOfCharge(line(4510, "2026-09-15", "POS CREDIT 4410"), [charge({ lineKey: "c" })])).toBeNull();
    expect(RETURN_WINDOW_DAYS).toBe(7);
    // `days` moves the edge.
    expect(returnOfCharge(refund, [charge({ lineKey: "c", postedOn: "2026-09-12" })], 2)).toBeNull();
    expect(returnOfCharge(refund, [charge({ lineKey: "c", postedOn: "2026-09-12" })], 3)?.charge.lineKey).toBe("c");
  });

  it("nearest day first, then the charge closest to the refund's money, then the key; a money-out line asks nothing", () => {
    const far = charge({ lineKey: "c-far", postedOn: "2026-09-09" });
    const near = charge({ lineKey: "c-near", postedOn: "2026-09-14", cents: -9000 });
    expect(returnOfCharge(refund, [far, near])?.charge.lineKey).toBe("c-near");
    const whole = charge({ lineKey: "c-whole", postedOn: "2026-09-14" });
    expect(returnOfCharge(refund, [near, whole])?.charge.lineKey).toBe("c-whole");
    const twinB = charge({ lineKey: "c-2", postedOn: "2026-09-14" });
    const twinA = charge({ lineKey: "c-1", postedOn: "2026-09-14" });
    expect(returnOfCharge(refund, [twinB, twinA])?.charge.lineKey).toBe("c-1");
    expect(returnOfCharge(line(-4510, "2026-09-15", "1111-THISTLEWOOD HARDWARE #221"), [far])).toBeNull();
    expect(returnOfCharge(refund, [])).toBeNull();
  });
});
