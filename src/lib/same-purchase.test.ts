import { describe, it, expect } from "vitest";
import { indexSupplierAliases } from "@/lib/supplier-identity";
import {
  billsCarryingNumber,
  billsCoveredByDocuments,
  billsMaybeCarryingNumber,
  namesakeSaid,
  normalizeDocNumber,
  readPaperMatch,
  sameStore,
  storeBillsOf,
  samePurchaseCandidates,
  samePurchaseSentence,
  type LedgerBill,
  type SupplierDoc,
} from "./same-purchase";

/**
 * ONE PURCHASE, ONE BILL (audit v994, DB1). Every fixture is ET Electric's own: the CED account
 * (6fae3d9c), Paper B's counter ticket on J-011 (e2380fc9, 8802-SO-257555, $323.71) and Paper A's
 * TOOLS ticket (fef38cb9, 8802-SO-257558, $44.44, no job).
 */
const CED = "6fae3d9c-2bd5-484f-8998-94ddcf77a52d";
const J011 = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";
const aliases = indexSupplierAliases([{ alias: "Consolidated Electrical Dist.", supplier_account_id: CED }]);

const paperB: LedgerBill = {
  id: "e2380fc9",
  supplier: "Consolidated Electrical Dist.",
  supplier_account_id: CED,
  bill_number: "8802-SO-257555",
  supplier_invoice_number: null,
  amount: "323.71",
  bill_date: "2026-09-24",
  job_id: J011,
  jobs: { job_number: "J-011", name: "13897 Honeysuckle" },
};
const paperA: LedgerBill = {
  id: "fef38cb9",
  supplier: "Consolidated Electrical Dist.",
  supplier_account_id: CED,
  bill_number: "8802-SO-257558",
  supplier_invoice_number: null,
  amount: "44.44",
  bill_date: "2026-09-24",
  job_id: null,
};
/** A tray ticket that DID carry CED's invoice number (the J-046 counter sheet shape). */
const trayTicket: LedgerBill = {
  id: "tray-1",
  supplier: "Consolidated Electrical Dist.",
  supplier_account_id: CED,
  bill_number: "8802-1109000",
  amount: "400.00",
  bill_date: "2026-09-10",
  job_id: "job-046",
};

describe("billsCarryingNumber: the one reading every door uses", () => {
  it("finds the tray's bill_number from CED's own document (the double bill the audit found)", () => {
    expect(billsCarryingNumber("#8802 1109000", { accountId: CED }, [trayTicket], aliases).map((b) => b.id)).toEqual(["tray-1"]);
  });

  it("finds a supplier_invoice_number from a tray paper", () => {
    const recorded: LedgerBill = { ...trayTicket, id: "rec-1", bill_number: null, supplier_invoice_number: "8802-1109000" };
    expect(billsCarryingNumber("8802-1109000", { supplier: "Consolidated Electrical Dist." }, [recorded], aliases).map((b) => b.id)).toEqual(["rec-1"]);
  });

  it("finds a number named on a scanned statement's own lines", () => {
    const statement: LedgerBill = { ...trayTicket, id: "st-1", bill_number: null, named_numbers: ["8802-1105868", "8802-1105963"] };
    expect(billsCarryingNumber("8802-1105963", { accountId: CED }, [statement], aliases)).toHaveLength(1);
  });

  it("never a set-aside copy (0271)", () => {
    expect(billsCarryingNumber("8802-1109000", { accountId: CED }, [{ ...trayTicket, superseded_by_bill_id: "keeper" }], aliases)).toEqual([]);
  });

  it("never a bill on another account", () => {
    expect(billsCarryingNumber("8802-1109000", { accountId: "acct-other" }, [trayTicket], aliases)).toEqual([]);
  });

  it("a long number under another spelling is never certain (DB5 is Erik's call): only a maybe, never a short one", () => {
    const unfiled: LedgerBill = { ...trayTicket, supplier: "CED Truckee counter", supplier_account_id: null };
    expect(billsCarryingNumber("8802-1109000", { accountId: CED }, [unfiled], aliases)).toEqual([]);
    // A paper from any vendor is not refused as "already on the books" by a number alone.
    expect(billsCarryingNumber("8802-1109000", { supplier: "Home Depot" }, [unfiled], aliases)).toEqual([]);
    expect(billsMaybeCarryingNumber("8802-1109000", { accountId: CED }, [unfiled], aliases).map((b) => b.id)).toEqual(["tray-1"]);
    expect(billsMaybeCarryingNumber("1234", { accountId: CED }, [{ ...unfiled, bill_number: "1234" }], aliases)).toEqual([]);
    // A bill filed on an account, or already certain, is never a maybe.
    expect(billsMaybeCarryingNumber("8802-1109000", { accountId: CED }, [trayTicket], aliases)).toEqual([]);
    expect(billsMaybeCarryingNumber("8802-1109000", { accountId: "acct-other" }, [trayTicket], aliases)).toEqual([]);
  });

  it("the exact spelling on no account is still certain", () => {
    const unfiled: LedgerBill = { ...trayTicket, supplier: "CED Truckee counter", supplier_account_id: null };
    expect(billsCarryingNumber("8802-1109000", { supplier: "CED Truckee counter" }, [unfiled], aliases)).toHaveLength(1);
  });

  it("normalises the printed number one way", () => {
    expect(normalizeDocNumber("8802-SO-257555")).toBe("8802SO257555");
  });
});

describe("samePurchaseCandidates: the counter ticket and CED's invoice for it", () => {
  // CED invoices Paper B's breakers later, under its own number, job name "13897 HONEYSUCKLE".
  const cedInvoice: SupplierDoc = {
    id: "si-new",
    invoice_number: "8802-1109999",
    supplier_account_id: CED,
    job_id: J011,
    total: "323.71",
    invoice_date: "2026-09-26",
  };

  it("offers Paper B's SO ticket to CED's invoice for it: same account, job and total, two days apart", () => {
    const c = samePurchaseCandidates(cedInvoice, [paperB, paperA], new Set(), aliases);
    expect(c).toEqual([expect.objectContaining({ billId: "e2380fc9", exact: false, dollarsOff: 0, daysApart: 2, jobId: J011 })]);
    expect(samePurchaseSentence(c[0])).toContain("Maybe already on the books: Consolidated Electrical Dist. #8802-SO-257555, $323.71, 2026-09-24, on J-011 13897 Honeysuckle");
    expect(samePurchaseSentence(c[0])).toContain("the same total, 2 days apart");
  });

  it("offers Paper A's TOOLS ticket to a no-job invoice for the same $44.44", () => {
    const tools: SupplierDoc = { ...cedInvoice, id: "si-tools", job_id: null, total: "44.44" };
    expect(samePurchaseCandidates(tools, [paperB, paperA], new Set(), aliases).map((c) => c.billId)).toEqual(["fef38cb9"]);
  });

  it("never a bill a document already covers, another job's, another account's, or a statement", () => {
    expect(samePurchaseCandidates(cedInvoice, [paperB], new Set(["e2380fc9"]), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, job_id: "job-other" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, supplier: "Home Depot", supplier_account_id: "acct-hd" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, is_statement: true }], new Set(), aliases)).toEqual([]);
  });

  it("only within a few dollars and days (outside the dollars, on the same job, it is a reprice offer, never a tie)", () => {
    const off = samePurchaseCandidates(cedInvoice, [{ ...paperB, amount: "330.00" }], new Set(), aliases);
    expect(off).toEqual([expect.objectContaining({ billId: "e2380fc9", reprice: true, exact: false })]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, bill_date: "2026-07-01" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, amount: "321.00" }], new Set(), aliases)).toEqual([expect.objectContaining({ billId: "e2380fc9", exact: false })]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, amount: "321.00" }], new Set(), aliases)[0].reprice).toBeUndefined();
  });

  it("a $0.00 placeholder is never 'maybe the same purchase', and a small invoice is held to 3% (the live replay)", () => {
    // ET's books: a $0.00 CED bill on J-013 was offered against 8802-1105997 ($2.30) by a flat $5.
    const small: SupplierDoc = { ...cedInvoice, id: "si-small", invoice_number: "8802-1105997", job_id: "j13", total: "2.30", invoice_date: "2026-08-19" };
    const zero: LedgerBill = { ...paperB, id: "zero", bill_number: null, amount: "0.00", job_id: "j13", bill_date: "2026-08-19" };
    expect(samePurchaseCandidates(small, [zero], new Set(), aliases)).toEqual([]);
    // $4.00 against $2.30 is outside 3%: not a tie; on the same job it is offered as another price.
    expect(samePurchaseCandidates(small, [{ ...zero, amount: "4.00" }], new Set(), aliases)).toEqual([expect.objectContaining({ billId: "zero", reprice: true })]);
    expect(samePurchaseCandidates(small, [{ ...zero, amount: "2.30" }], new Set(), aliases)).toEqual([expect.objectContaining({ billId: "zero", exact: false })]);
  });

  it("a bill carrying the invoice's own number is certain, and ranked first", () => {
    const exact: LedgerBill = { ...paperB, id: "exact-1", bill_number: "8802-1109999", amount: "100.00", bill_date: "2026-01-01" };
    const c = samePurchaseCandidates(cedInvoice, [paperB, exact], new Set(["exact-1"]), aliases);
    expect(c.map((x) => [x.billId, x.exact])).toEqual([
      ["exact-1", true],
      ["e2380fc9", false],
    ]);
    expect(samePurchaseSentence(c[0])).toMatch(/^Already on the books with this number:/);
  });
});

describe("billsCoveredByDocuments", () => {
  it("covers a bill by a link or by carrying a document's number on its account", () => {
    const docs: SupplierDoc[] = [{ id: "si-1", invoice_number: "8802-1109000", supplier_account_id: CED, total: 400, invoice_date: "2026-09-12" }];
    const covered = billsCoveredByDocuments([trayTicket, paperB, paperA], docs, [{ bill_id: "fef38cb9", supplier_invoice_id: "si-9" }], aliases);
    expect([...covered].sort()).toEqual(["fef38cb9", "tray-1"]);
  });

  it("never by a long number under another spelling: that would drop a real purchase from Purchases Not in Your Books", () => {
    const docs: SupplierDoc[] = [{ id: "si-1", invoice_number: "8802-1109000", supplier_account_id: CED, total: 400, invoice_date: "2026-09-12" }];
    const unfiled: LedgerBill = { ...trayTicket, supplier: "Some Other Supply", supplier_account_id: null };
    expect([...billsCoveredByDocuments([unfiled], docs, [], aliases)]).toEqual([]);
  });
});

describe("the same long number under another spelling is offered, never assumed", () => {
  const doc: SupplierDoc = { id: "si-1", invoice_number: "8802-1109000", supplier_account_id: CED, job_id: "job-other", total: 999, invoice_date: "2026-01-01" };
  const unfiled: LedgerBill = { ...trayTicket, supplier: "CED Truckee counter", supplier_account_id: null };

  it("is a maybe candidate whatever the money, days or job, and says why", () => {
    const c = samePurchaseCandidates(doc, [unfiled], new Set(), aliases);
    expect(c).toEqual([expect.objectContaining({ billId: "tray-1", exact: false, otherSpelling: true })]);
    expect(samePurchaseSentence(c[0])).toBe(
      "Maybe already on the books: CED Truckee counter #8802-1109000, $400.00, 2026-09-10, on a job. It carries this number, under a supplier name that is on no supplier account yet.",
    );
  });

  it("not when a document already covers it, or it is a statement", () => {
    expect(samePurchaseCandidates(doc, [unfiled], new Set(["tray-1"]), aliases)).toEqual([]);
    expect(samePurchaseCandidates(doc, [{ ...unfiled, is_statement: true }], new Set(), aliases)).toEqual([]);
  });
});

/**
 * ONE PURCHASE, WHOLE (0381, task 2 2026-10-07). The J-011 shape, scrubbed: the counter ticket
 * 8802-SO-257899 ($613.19) and the correction 8802-1109100 ($95.99) filed under it. CED's own copy
 * of 8802-1109100 ($709.18) is that purchase's paper.
 */
describe("a bill and the corrections under it are one purchase", () => {
  const ticket: LedgerBill = { ...paperB, id: "ticket", bill_number: "8802-SO-257899", amount: "613.19", bill_date: "2026-09-24" };
  const correction: LedgerBill = { ...paperB, id: "corr", bill_number: "8802-1109100", amount: "95.99", bill_date: "2026-10-07", corrects_bill_id: "ticket" };
  const other: LedgerBill = { ...paperB, id: "other", bill_number: "8802-SO-257900", amount: "95.99", bill_date: "2026-10-06" };
  const cedCopy: SupplierDoc = { id: "si-copy", invoice_number: "8802-1109100", supplier_account_id: CED, job_id: null, total: "709.18", invoice_date: "2026-10-07" };

  it("the number on the correction finds the ticket too, original first; and the ticket's number finds the correction", () => {
    expect(billsCarryingNumber("8802-1109100", { accountId: CED }, [other, correction, ticket], aliases).map((b) => b.id)).toEqual(["ticket", "corr"]);
    expect(billsCarryingNumber("8802-SO-257899", { accountId: CED }, [other, correction, ticket], aliases).map((b) => b.id)).toEqual(["ticket", "corr"]);
  });

  it("CED's copy of the correction's paper covers the whole purchase, and so does a link to either member", () => {
    expect([...billsCoveredByDocuments([ticket, correction, other], [cedCopy], [], aliases)].sort()).toEqual(["corr", "ticket"]);
    expect([...billsCoveredByDocuments([ticket, correction, other], [], [{ bill_id: "corr", supplier_invoice_id: "si-x" }], aliases)].sort()).toEqual(["corr", "ticket"]);
    expect([...billsCoveredByDocuments([ticket, correction, other], [], [{ bill_id: "ticket", supplier_invoice_id: "si-x" }], aliases)].sort()).toEqual(["corr", "ticket"]);
  });

  it("is offered once, as the original, at the together total, and the label says so", () => {
    const c = samePurchaseCandidates(cedCopy, [other, correction, ticket], new Set(), aliases);
    expect(c.map((x) => [x.billId, x.exact, x.amount])).toEqual([["ticket", true, 709.18]]);
    expect(c[0].label).toBe("Consolidated Electrical Dist. #8802-SO-257899 corrected by 8802-1109100, $709.18 together, 2026-09-24, on J-011 13897 Honeysuckle");
    expect(samePurchaseSentence(c[0])).toBe(`Already on the books with this number: ${c[0].label}.`);
  });

  it("a correction is never a candidate on its own: a $95.99 paper on the job is offered the other $95.99 ticket, not the correction", () => {
    const near: SupplierDoc = { ...cedCopy, id: "si-near", invoice_number: "8802-1109200", total: "95.99", job_id: J011 };
    expect(samePurchaseCandidates(near, [ticket, correction, other], new Set(), aliases).map((x) => x.billId)).toEqual(["other"]);
  });

  it("the tolerance is measured against the together total", () => {
    const paper: SupplierDoc = { ...cedCopy, id: "si-t", invoice_number: "8802-1109300", total: "709.18", job_id: J011 };
    expect(samePurchaseCandidates(paper, [ticket, correction], new Set(), aliases).map((x) => [x.billId, x.exact, x.dollarsOff])).toEqual([["ticket", false, 0]]);
    // $613.19 alone is no longer the purchase's figure: not a tie (a reprice offer at most).
    expect(samePurchaseCandidates({ ...paper, total: "613.19" }, [ticket, correction], new Set(), aliases).filter((x) => !x.reprice)).toEqual([]);
  });

  it("a correction whose original the list does not hold stands alone rather than vanishing", () => {
    expect(billsCarryingNumber("8802-1109100", { accountId: CED }, [correction], aliases).map((b) => b.id)).toEqual(["corr"]);
    expect(samePurchaseCandidates(cedCopy, [correction], new Set(), aliases).map((x) => [x.billId, x.amount])).toEqual([["corr", 95.99]]);
  });

  it("a set-aside copy (0271) is in no purchase", () => {
    expect(billsCarryingNumber("8802-1109100", { accountId: CED }, [ticket, { ...correction, superseded_by_bill_id: "keeper" }], aliases)).toEqual([]);
  });
});

/**
 * THE SAME PURCHASE AT ANOTHER PRICE (Erik, 2026-10-04: the counter priced a fixture at $0.00 and
 * CED's invoice came to $95.99 more). Nothing within tolerance used to mean Record It as a Bill was
 * the only door: a second full bill on the job. Now the uncovered tickets on that job are offered,
 * and the door is Correct This Bill.
 */
describe("the same purchase at another price: a reprice offer, never a tie", () => {
  const ticket: LedgerBill = { ...paperB, id: "ticket", bill_number: "8802-SO-257899", amount: "613.19", bill_date: "2026-09-24" };
  const second: LedgerBill = { ...paperB, id: "second", bill_number: "8802-SO-257901", amount: "400.00", bill_date: "2026-09-25" };
  const third: LedgerBill = { ...paperB, id: "third", bill_number: "8802-SO-257902", amount: "380.00", bill_date: "2026-09-26" };
  const fourth: LedgerBill = { ...paperB, id: "fourth", bill_number: "8802-SO-257903", amount: "360.00", bill_date: "2026-09-27" };
  const tiny: LedgerBill = { ...paperB, id: "tiny", bill_number: "8802-SO-257906", amount: "44.44", bill_date: "2026-09-26" };
  const elsewhere: LedgerBill = { ...paperB, id: "elsewhere", bill_number: "8802-SO-257904", amount: "700.00", bill_date: "2026-10-01", job_id: "job-other" };
  /** CED's invoice for the ticket, $95.99 more, filed on no job yet; its printed label names J-011. */
  const invoice: SupplierDoc = { id: "si-inv", invoice_number: "8802-1109100", supplier_account_id: CED, job_id: null, total: "709.18", invoice_date: "2026-10-07" };
  const all = [ticket, second, third, fourth, tiny, elsewhere];

  it("offers the uncovered tickets on the job the paper names, closest in money first, at most three, and says the gap", () => {
    const c = samePurchaseCandidates(invoice, all, new Set(), aliases, { namedJobId: J011 });
    expect(c.map((x) => [x.billId, x.reprice, x.amount, x.paperTotal, x.dollarsOff])).toEqual([
      ["ticket", true, 613.19, 709.18, 95.99],
      ["second", true, 400, 709.18, 309.18],
      ["third", true, 380, 709.18, 329.18],
    ]);
    expect(samePurchaseSentence(c[0])).toBe(
      "Maybe the same purchase at another price: Consolidated Electrical Dist. #8802-SO-257899, $613.19, 2026-09-24, on J-011 13897 Honeysuckle. This paper says $709.18 (+$95.99). Correct This Bill puts the difference under it as its own bill.",
    );
  });

  it("a paper filed on the job gets the same offer; a paper that names no job and is filed on none gets none", () => {
    expect(samePurchaseCandidates({ ...invoice, job_id: J011 }, all, new Set(), aliases).map((x) => x.billId)).toEqual(["ticket", "second", "third"]);
    expect(samePurchaseCandidates(invoice, all, new Set(), aliases)).toEqual([]);
  });

  it("never while anything is within tolerance, and never a covered ticket, a statement, another account, or one past the days", () => {
    const tie: LedgerBill = { ...paperB, id: "tie", bill_number: "8802-SO-257905", amount: "709.18", bill_date: "2026-10-06" };
    expect(samePurchaseCandidates(invoice, [ticket, tie], new Set(), aliases, { namedJobId: J011 }).map((x) => [x.billId, !!x.reprice])).toEqual([["tie", false]]);
    expect(samePurchaseCandidates(invoice, [ticket], new Set(["ticket"]), aliases, { namedJobId: J011 })).toEqual([]);
    expect(samePurchaseCandidates(invoice, [{ ...ticket, is_statement: true }], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
    expect(samePurchaseCandidates(invoice, [{ ...ticket, supplier: "Home Depot", supplier_account_id: "acct-hd" }], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
    expect(samePurchaseCandidates(invoice, [{ ...ticket, bill_date: "2026-07-01" }], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
  });

  it("a paper for less says a credit", () => {
    const less: SupplierDoc = { ...invoice, total: "561.61" };
    const c = samePurchaseCandidates(less, [ticket], new Set(), aliases, { namedJobId: J011 });
    expect(samePurchaseSentence(c[0])).toContain("This paper says $561.61 (−$51.58).");
  });

  it("the same order of money only: never a $44.44 ticket for a $709.18 paper, never a credit bill, never an undated paper", () => {
    expect(samePurchaseCandidates(invoice, [tiny], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
    expect(samePurchaseCandidates(invoice, [{ ...ticket, amount: "-50.00" }], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
    expect(samePurchaseCandidates({ ...invoice, invoice_date: null }, [ticket], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
    // Half and twice are the edges, either way round.
    expect(samePurchaseCandidates(invoice, [{ ...ticket, amount: "354.59" }], new Set(), aliases, { namedJobId: J011 })).toHaveLength(1);
    expect(samePurchaseCandidates(invoice, [{ ...ticket, amount: "354.58" }], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
    expect(samePurchaseCandidates(invoice, [{ ...ticket, amount: "1418.36" }], new Set(), aliases, { namedJobId: J011 })).toHaveLength(1);
    expect(samePurchaseCandidates(invoice, [{ ...ticket, amount: "1418.37" }], new Set(), aliases, { namedJobId: J011 })).toEqual([]);
  });
});

/**
 * THE ONE RULE (cn-v1212): THE STORE, THE TOTAL AND THE DAY. Stand-ins only: a Bayberry Lumber
 * counter slip for $18.40 on 2026-11-23, read sometimes with the store's short number "417" and
 * sometimes with a long invoice number "INV-9001417" (7 digits and more); the store's bills.
 * The candidates handed in are the store's own (storeBillsOf, tested below).
 */
describe("readPaperMatch: the store, the total and the day", () => {
  const LONG = "INV-9001417";
  const bill = (id: string, over: Partial<LedgerBill> = {}): LedgerBill => ({
    id,
    supplier: "Bayberry Lumber",
    supplier_account_id: "acct-bayberry",
    bill_number: null,
    supplier_invoice_number: null,
    amount: "61.75",
    bill_date: "2026-11-02",
    job_id: "job-902",
    ...over,
  });
  const slip = { number: null as string | null, amount: 18.40 as number | string | null | undefined, date: "2026-11-23" as string | null };
  const reading = (paper: Partial<typeof slip>, bills: LedgerBill[]) => {
    const r = readPaperMatch({ ...slip, ...paper }, bills);
    // `why` is left out of the answer when it is null (toEqual skips an undefined key), so every
    // expectation that names a namesake names its kind too.
    return { same: r.same?.original.id ?? null, namesake: r.namesake?.original.id ?? null, why: r.why ?? undefined };
  };
  const SAME_DAY = { amount: "18.40", bill_date: "2026-11-23" };

  it("step 1: a total that was not read (null, undefined, empty, NaN, \"abc\") says nothing, whatever agrees", () => {
    const twin = bill("b1", { ...SAME_DAY, bill_number: LONG });
    for (const amount of [null, undefined, "", Number.NaN, "abc"]) {
      expect(readPaperMatch({ ...slip, number: LONG, amount }, [twin])).toStrictEqual({ same: null, namesake: null, why: null });
    }
  });
  it("no bills of the store: a purchase of its own", () => {
    expect(reading({}, [])).toEqual({ same: null, namesake: null });
    expect(reading({ number: LONG }, [])).toEqual({ same: null, namesake: null });
  });

  // ── step 3: the total and the day ──
  it("no number at all: the same total on the same day is that purchase", () => {
    expect(reading({}, [bill("b1", SAME_DAY)])).toEqual({ same: "b1", namesake: null });
  });
  it("no number: the same total on another day is a purchase of its own", () => {
    expect(reading({}, [bill("b1", { amount: "18.40" })])).toEqual({ same: null, namesake: null });
  });
  it("no number: another total on the same day is a purchase of its own", () => {
    expect(reading({}, [bill("b1", { amount: "18.41", bill_date: "2026-11-23" })])).toEqual({ same: null, namesake: null });
  });
  it("a paper with no day: the total alone decides nothing", () => {
    expect(reading({ date: null }, [bill("b1", SAME_DAY)])).toEqual({ same: null, namesake: null });
    expect(reading({ date: "" }, [bill("b1", SAME_DAY)])).toEqual({ same: null, namesake: null });
  });
  it("THE STAND-IN STORY: a short number at another total on another day: its own purchase, and no namesake", () => {
    expect(reading({ number: "417" }, [bill("b1", { bill_number: "417" })])).toEqual({ same: null, namesake: null });
  });
  it("a short number at the same total on another day: its own purchase, SAID once as a \"day\" namesake (skeptic #106, S2; it was silent)", () => {
    expect(reading({ number: "417" }, [bill("b1", { bill_number: "417", amount: "18.40" })])).toEqual({ same: null, namesake: "b1", why: "day" });
  });
  it("a short number at the same total on the same day: that purchase, by the total and the day", () => {
    expect(reading({ number: "417" }, [bill("b1", { bill_number: "417", ...SAME_DAY })])).toEqual({ same: "b1", namesake: null });
  });
  it("several agree by total and day: one carrying the paper's number (short counts here) first", () => {
    expect(reading({ number: "417" }, [bill("b1", SAME_DAY), bill("b2", { ...SAME_DAY, bill_number: "417" })])).toEqual({ same: "b2", namesake: null });
    expect(reading({ number: "417" }, [bill("b1", SAME_DAY), bill("b2", { ...SAME_DAY, supplier_invoice_number: "#417" })])).toEqual({ same: "b2", namesake: null });
  });
  it("several agree by total and day, none carries the number: the FIRST", () => {
    expect(reading({ number: "417" }, [bill("b1", SAME_DAY), bill("b2", SAME_DAY)])).toEqual({ same: "b1", namesake: null });
    expect(reading({}, [bill("b0"), bill("b1", SAME_DAY), bill("b2", SAME_DAY)])).toEqual({ same: "b1", namesake: null });
  });

  // ── step 2: a long number and the total ──
  it("a LONG number at the same total on ANOTHER day: that purchase (the same invoice, typed on another date)", () => {
    expect(reading({ number: LONG }, [bill("b1", { bill_number: LONG, amount: "18.40" })])).toEqual({ same: "b1", namesake: null });
  });
  it("the long number in supplier_invoice_number, spelled another way, is the purchase's own", () => {
    expect(reading({ number: LONG }, [bill("b1", { supplier_invoice_number: "inv 9001417", amount: "18.40" })])).toEqual({ same: "b1", namesake: null });
  });
  it("six digits is short, seven is long: the same total on another day", () => {
    expect(reading({ number: "INV-900141" }, [bill("b1", { bill_number: "INV-900141", amount: "18.40" })])).toEqual({ same: null, namesake: "b1", why: "day" });
    expect(reading({ number: "INV-9001417" }, [bill("b1", { bill_number: "INV-9001417", amount: "18.40" })])).toEqual({ same: "b1", namesake: null });
  });
  it("six digits never makes a namesake; seven does", () => {
    expect(reading({ number: "INV-900141" }, [bill("b1", { bill_number: "INV-900141" })])).toEqual({ same: null, namesake: null });
    expect(reading({ number: "INV-9001417" }, [bill("b1", { bill_number: "INV-9001417" })])).toEqual({ same: null, namesake: "b1", why: "total" });
  });
  it("several carry the long number at the total: the one whose day agrees first, else the first", () => {
    const at = { bill_number: LONG, amount: "18.40" };
    expect(reading({ number: LONG }, [bill("b1", at), bill("b2", { ...at, bill_date: "2026-11-23" })])).toEqual({ same: "b2", namesake: null });
    expect(reading({ number: LONG }, [bill("b1", at), bill("b2", { ...at, bill_date: "2026-11-20" })])).toEqual({ same: "b1", namesake: null });
  });
  it("step 2 comes before step 3: a long-number purchase at the total on another day beats a numberless twin by total and day", () => {
    expect(reading({ number: LONG }, [bill("twin", SAME_DAY), bill("own", { bill_number: LONG, amount: "18.40" })])).toEqual({ same: "own", namesake: null });
  });

  // ── step 4: the namesake ──
  it("ONE purchase carries the long number at another total: its own purchase, and that one is the namesake", () => {
    expect(reading({ number: LONG }, [bill("b1", { bill_number: LONG })])).toEqual({ same: null, namesake: "b1", why: "total" });
  });
  it("TWO carry the long number at other totals: the number repeats, no namesake", () => {
    expect(reading({ number: LONG }, [bill("b1", { bill_number: LONG }), bill("b2", { bill_number: LONG, amount: "9.00" })])).toEqual({ same: null, namesake: null });
  });
  it("a namesake beside a twin by total and day: the twin, and no namesake", () => {
    expect(reading({ number: LONG }, [bill("b1", { bill_number: LONG }), bill("b2", SAME_DAY)])).toEqual({ same: "b2", namesake: null });
  });
  it("a long number on the paper and a numberless bill at another total: nothing", () => {
    expect(reading({ number: LONG }, [bill("b1")])).toEqual({ same: null, namesake: null });
  });

  // ── the money and the day, as cn-v1211 had them ──
  it("cents decide: 18.40 against 18.400000001 agrees, against 18.41 does not", () => {
    expect(reading({ amount: 18.400000001 }, [bill("b1", SAME_DAY)])).toEqual({ same: "b1", namesake: null });
    expect(reading({ amount: 18.41 }, [bill("b1", SAME_DAY)])).toEqual({ same: null, namesake: null });
  });
  it("a string amount \"18.40\" agrees with a number 18.4", () => {
    expect(reading({ amount: "18.40" }, [bill("b1", { amount: 18.4, bill_date: "2026-11-23" })])).toEqual({ same: "b1", namesake: null });
  });
  it("a credit whose negative totals agree on the day: same", () => {
    expect(reading({ amount: -18.4 }, [bill("b1", { amount: "-18.40", bill_date: "2026-11-23" })])).toEqual({ same: "b1", namesake: null });
  });
  it("the sign counts: -50.00 and 50.00 never agree, by day or by long number", () => {
    expect(reading({ amount: -50 }, [bill("b1", { amount: "50.00", bill_date: "2026-11-23" })])).toEqual({ same: null, namesake: null });
    expect(reading({ amount: 50, number: LONG }, [bill("b1", { amount: "-50.00", bill_number: LONG })])).toEqual({ same: null, namesake: "b1", why: "total" });
  });
  it("a bill_date that is a timestamp agrees by its first ten characters, and so does the paper's", () => {
    expect(reading({}, [bill("b1", { amount: "18.40", bill_date: "2026-11-23T08:15:00+00:00" })])).toEqual({ same: "b1", namesake: null });
    expect(reading({ date: "2026-11-23T17:40:00Z" }, [bill("b1", SAME_DAY)])).toEqual({ same: "b1", namesake: null });
  });
  it("a purchase with no amount on any member has no total: a paper of 0.00 never agrees with it", () => {
    expect(reading({ amount: 0 }, [bill("b1", { amount: null, bill_date: "2026-11-23" })])).toEqual({ same: null, namesake: null });
    expect(reading({ amount: "0.00", number: LONG }, [bill("b1", { amount: null, bill_number: LONG })])).toEqual({ same: null, namesake: "b1", why: "total" });
    expect(
      reading({ amount: 0 }, [bill("o1", { amount: null, bill_date: "2026-11-23" }), bill("c1", { amount: null, corrects_bill_id: "o1" })]),
    ).toEqual({ same: null, namesake: null });
  });
  it("a member whose own amount is null is never agreed by a paper of 0.00", () => {
    expect(reading({ amount: 0 }, [bill("o1", { amount: "5.00", bill_date: "2026-11-23" }), bill("c1", { amount: null, corrects_bill_id: "o1" })])).toEqual({ same: null, namesake: null });
  });
  it("a superseded copy is no purchase", () => {
    expect(reading({}, [bill("b1", { ...SAME_DAY, superseded_by_bill_id: "keeper" })])).toEqual({ same: null, namesake: null });
  });

  // ── a family: an original and its correction are one purchase ──
  const family = (over: { o?: Partial<LedgerBill>; c?: Partial<LedgerBill> } = {}) => [
    bill("o1", { bill_number: "SO-88", amount: "10.00", bill_date: "2026-11-02", ...over.o }),
    bill("c1", { amount: "8.40", bill_date: "2026-11-23", corrects_bill_id: "o1", ...over.c }),
  ];
  it("a family agrees by the together total and by ONE member's day (the correction's): the original", () => {
    expect(reading({}, family())).toEqual({ same: "o1", namesake: null });
  });
  it("a family agrees by one member's own amount on the original's day", () => {
    expect(reading({ amount: 10, date: "2026-11-02" }, family())).toEqual({ same: "o1", namesake: null });
  });
  it("a family at the together total on a day no member has: its own purchase", () => {
    expect(reading({ date: "2026-11-24" }, family())).toEqual({ same: null, namesake: null });
  });
  it("a family whose correction carries the long number: found at the together total whatever the day, the namesake at another", () => {
    expect(reading({ number: LONG, date: "2026-11-24" }, family({ c: { bill_number: LONG } }))).toEqual({ same: "o1", namesake: null });
    expect(reading({ number: LONG, amount: 30 }, family({ c: { bill_number: LONG } }))).toEqual({ same: null, namesake: "o1", why: "total" });
  });

  // ── F1 (skeptic #106, N1): an amount and a day belong together; a correction's own amount never agrees ──
  // A stand-in purchase: an original of $50.00 on 11-02 and a correction of +$12.00 under it on 11-20,
  // $62.00 together.
  const corrected = (over: { o?: Partial<LedgerBill>; c?: Partial<LedgerBill> } = {}) => [
    bill("o1", { amount: "50.00", bill_date: "2026-11-02", ...over.o }),
    bill("c1", { amount: "12.00", bill_date: "2026-11-20", corrects_bill_id: "o1", ...over.c }),
  ];
  it("N1: a new $12.00 slip on the correction's day is a purchase of its own (a correction's amount is a difference)", () => {
    expect(reading({ amount: 12, date: "2026-11-20" }, corrected())).toEqual({ same: null, namesake: null });
    expect(reading({ amount: 12, date: "2026-11-02" }, corrected())).toEqual({ same: null, namesake: null });
  });
  it("N1: nor by a long number the correction carries, nor as a \"day\" namesake", () => {
    expect(reading({ amount: 12, number: LONG, date: "2026-11-24" }, corrected({ c: { bill_number: LONG } }))).toEqual({ same: null, namesake: "o1", why: "total" });
    expect(reading({ amount: 12, number: "417", date: "2026-11-24" }, corrected({ c: { bill_number: "417" } }))).toEqual({ same: null, namesake: null });
  });
  it("the ORIGINAL ticket photographed again after a correction: its own amount on its own day", () => {
    expect(reading({ amount: 50, date: "2026-11-02" }, corrected())).toEqual({ same: "o1", namesake: null });
  });
  it("the original's own amount on the CORRECTION's day is not that pair: a purchase of its own", () => {
    expect(reading({ amount: 50, date: "2026-11-20" }, corrected())).toEqual({ same: null, namesake: null });
  });
  it("the later paper: the together total on the correction's day, or the original's", () => {
    expect(reading({ amount: 62, date: "2026-11-20" }, corrected())).toEqual({ same: "o1", namesake: null });
    expect(reading({ amount: 62, date: "2026-11-02" }, corrected())).toEqual({ same: "o1", namesake: null });
    expect(reading({ amount: 62, date: "2026-11-21" }, corrected())).toEqual({ same: null, namesake: null });
  });
  it("step 2's preference reads the day of the amount that agreed: the original's day for its own amount", () => {
    // p1's own $50.00 agrees but only its correction sits on the paper's day; p2's original does.
    const bills = [
      bill("p1", { amount: "50.00", bill_date: "2026-11-02", bill_number: LONG }),
      bill("p1c", { amount: "12.00", bill_date: "2026-11-23", corrects_bill_id: "p1" }),
      bill("p2", { amount: "50.00", bill_date: "2026-11-23", bill_number: LONG }),
    ];
    expect(reading({ amount: 50, number: LONG }, bills)).toEqual({ same: "p2", namesake: null });
  });

  // ── F2 (skeptic #106, S2): the same number at the same total on another day is SAID ──
  it("\"day\": a short number carried at the same total on another day, by the together total too", () => {
    expect(reading({ number: "417", amount: 62, date: "2026-11-24" }, corrected({ o: { bill_number: "417" } }))).toEqual({ same: null, namesake: "o1", why: "day" });
    expect(reading({ number: "#417", date: "2026-11-24" }, [bill("b1", { supplier_invoice_number: "417", amount: "18.40" })])).toEqual({ same: null, namesake: "b1", why: "day" });
  });
  it("\"day\" needs a number and a day on the paper", () => {
    expect(reading({}, [bill("b1", { bill_number: "417", amount: "18.40" })])).toEqual({ same: null, namesake: null });
    expect(reading({ number: "417", date: null }, [bill("b1", { bill_number: "417", amount: "18.40" })])).toEqual({ same: null, namesake: null });
  });
  it("\"day\" needs exactly ONE carrier at the paper's total; a carrier at another total beside it does not count", () => {
    const at = { bill_number: "417", amount: "18.40" };
    expect(reading({ number: "417" }, [bill("b1", at), bill("b2", { ...at, bill_date: "2026-11-09" })])).toEqual({ same: null, namesake: null });
    expect(reading({ number: "417" }, [bill("b1", at), bill("b2", { bill_number: "417", amount: "9.00" })])).toEqual({ same: null, namesake: "b1", why: "day" });
  });
  it("a bill at the same total on another day that does NOT carry the number is no \"day\" namesake", () => {
    expect(reading({ number: "417" }, [bill("b1", { amount: "18.40" })])).toEqual({ same: null, namesake: null });
  });
});

describe("sameStore and storeBillsOf: the candidates are the paper's own store", () => {
  const aliases = indexSupplierAliases([
    { alias: "Bayberry Lumber", supplier_account_id: "acct-bayberry" },
    { alias: "Northline Supply", supplier_account_id: "acct-northline" },
  ]);
  const st = (name: string | null, account: string | null = null) => ({ name, account });

  it("the same account, or the exact spelling: one store (sameSupplier)", () => {
    expect(sameStore(st("Bayberry Lumber"), st("anything", "acct-bayberry"), aliases)).toBe(true);
    expect(sameStore(st("Bayberry Lumber"), st("bayberry lumber "), null)).toBe(true);
  });
  it("two spellings normalizeSupplierName joins are one store when one side is on no account", () => {
    expect(sameStore(st("Bayberry Lumber Co."), st("BAYBERRY LUMBER, INC."), null)).toBe(true);
    expect(sameStore(st("Bayberry Lumber (Truckee)"), st("Bayberry Lumber"), aliases)).toBe(true);
    expect(sameStore(st("Bayberry Lumber"), st("Bayberry Lumber Co.", null), aliases)).toBe(true);
  });
  it("two accounts are never joined by a name", () => {
    expect(sameStore(st("Bayberry Lumber", "acct-bayberry"), st("Bayberry Lumber", "acct-other"), aliases)).toBe(false);
    expect(sameStore(st("Bayberry Lumber"), st("Bayberry Lumber Co.", "acct-northline"), aliases)).toBe(false);
  });
  it("another store, or an empty name, is not the store", () => {
    expect(sameStore(st("Bayberry Lumber"), st("Northline Supply"), null)).toBe(false);
    expect(sameStore(st(""), st(""), null)).toBe(false);
    expect(sameStore(st("Inc."), st("LLC"), null)).toBe(false);
  });

  const b = (id: string, over: Partial<LedgerBill> = {}): LedgerBill => ({
    id,
    supplier: "Bayberry Lumber",
    supplier_account_id: null,
    bill_number: null,
    amount: "18.40",
    bill_date: "2026-11-23",
    ...over,
  });
  it("storeBillsOf: live bills of the store only, never the excepted one, grown to whole purchases", () => {
    const bills = [
      b("mine"),
      b("other-store", { supplier: "Northline Supply" }),
      b("copy", { superseded_by_bill_id: "mine" }),
      b("self"),
      b("orig", { supplier: "Northline Supply" }),
      b("corr", { corrects_bill_id: "orig" }),
      b("spelled", { supplier: "Bayberry Lumber, Inc." }),
    ];
    expect(storeBillsOf({ supplier: "Bayberry Lumber" }, bills, null, { exceptBillId: "self" }).map((x) => x.id)).toEqual(["mine", "orig", "corr", "spelled"]);
  });
  it("storeBillsOf: the excepted bill never brings its own family in (a correction of another store's spelling under it)", () => {
    const bills = [b("self"), b("corr-n", { supplier: "Northline Supply", corrects_bill_id: "self" })];
    expect(storeBillsOf({ supplier: "Bayberry Lumber" }, bills, null, { exceptBillId: "self" })).toEqual([]);
  });
  it("storeBillsOf: on an account, a bill on another account is not the store, whatever its name", () => {
    const bills = [b("there", { supplier_account_id: "acct-northline" }), b("here", { supplier_account_id: "acct-bayberry" })];
    expect(storeBillsOf({ accountId: "acct-bayberry", supplier: "Bayberry Lumber" }, bills, aliases).map((x) => x.id)).toEqual(["here"]);
  });
});

describe("namesakeSaid: the plain line beside a recorded paper", () => {
  it("\"total\": says it was recorded and names the bill, in fixed words", () => {
    expect(namesakeSaid("Bayberry Lumber #417, $61.75, 2026-11-02, on J-902 Stand-in Deck", "total")).toBe(
      "Recorded as its own purchase. A bill with the same number is already on the books at another total: Bayberry Lumber #417, $61.75, 2026-11-02, on J-902 Stand-in Deck.",
    );
  });
  it("\"day\": the same number and the same total on another day, in fixed words", () => {
    expect(namesakeSaid("Bayberry Lumber #417, $18.40, 2026-11-02, on J-902 Stand-in Deck", "day")).toBe(
      "Recorded as its own purchase. A bill with the same number and the same total is already on the books on another day: Bayberry Lumber #417, $18.40, 2026-11-02, on J-902 Stand-in Deck.",
    );
  });
});
