import { describe, it, expect } from "vitest";
import { indexSupplierAliases } from "@/lib/supplier-identity";
import {
  billsCarryingNumber,
  billsCoveredByDocuments,
  billsMaybeCarryingNumber,
  namesakeSaid,
  normalizeDocNumber,
  readNumberMatch,
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
 * A NUMBER ALONE NEVER SAYS "SAME PURCHASE"; THE MONEY MUST AGREE (cn-v1211). Stand-ins only: a
 * lumber store's counter slip read as number "417" for $18.40, and the bills of that store carrying 417.
 */
describe("readNumberMatch: the money must agree", () => {
  const bill = (id: string, over: Partial<LedgerBill> = {}): LedgerBill => ({
    id,
    supplier: "Bayberry Lumber",
    supplier_account_id: "acct-bayberry",
    bill_number: "417",
    supplier_invoice_number: null,
    amount: "61.75",
    bill_date: "2026-11-02",
    job_id: "job-902",
    ...over,
  });
  const slip = { number: "417", amount: 18.40 as number | string | null, date: "2026-11-23" as string | null };
  const reading = (paper: Partial<typeof slip>, bills: LedgerBill[]) => {
    const r = readNumberMatch({ ...slip, ...paper }, bills);
    return { same: r.same?.original.id ?? null, namesake: r.namesake?.original.id ?? null };
  };
  const STATEMENT = { bill_number: "STMT-11", amount: "900.00", named_numbers: ["417"] };

  it("no purchases: a purchase of its own, no namesake, whether or not the total was read", () => {
    expect(reading({}, [])).toEqual({ same: null, namesake: null });
    expect(readNumberMatch({ ...slip, amount: null }, [])).toStrictEqual({ same: null, namesake: null });
  });
  it("one purchase, the same total, the same day: same", () => {
    expect(reading({}, [bill("b1", { amount: "18.40", bill_date: "2026-11-23" })])).toEqual({ same: "b1", namesake: null });
  });
  it("one purchase, the same total, another day: same (a ticket and its invoice are dated apart)", () => {
    expect(reading({}, [bill("b1", { amount: "18.40" })])).toEqual({ same: "b1", namesake: null });
  });
  it("one purchase at another total (the stand-in story): not same, and it is the namesake", () => {
    expect(reading({}, [bill("b1")])).toEqual({ same: null, namesake: "b1" });
  });
  it("an original and a correction, the number on the correction only, the paper at the together total: same", () => {
    expect(reading({}, [bill("o1", { bill_number: "SO-88", amount: "10.00" }), bill("c1", { amount: "8.40", corrects_bill_id: "o1" })])).toEqual({ same: "o1", namesake: null });
  });
  it("that family, the paper at one member's own amount: same", () => {
    expect(reading({}, [bill("o1", { bill_number: "SO-88", amount: "40.00" }), bill("c1", { amount: "18.40", corrects_bill_id: "o1" })])).toEqual({ same: "o1", namesake: null });
  });
  it("two purchases, one a twin by total and day: same, and it is the twin, never the first", () => {
    expect(reading({}, [bill("b1"), bill("b2", { amount: "18.40", bill_date: "2026-11-23" })])).toEqual({ same: "b2", namesake: null });
  });
  it("two purchases, the same total on another day: not same, no namesake (the number repeats)", () => {
    expect(reading({}, [bill("b1"), bill("b2", { amount: "18.40" })])).toEqual({ same: null, namesake: null });
  });
  it("two purchases, no total agrees: not same, no namesake", () => {
    expect(reading({}, [bill("b1"), bill("b2", { amount: "8.00", bill_date: "2026-11-23" })])).toEqual({ same: null, namesake: null });
  });
  it("a superseded copy is no purchase", () => {
    expect(reading({}, [bill("b1", { amount: "18.40", bill_date: "2026-11-23", superseded_by_bill_id: "keeper" })])).toEqual({ same: null, namesake: null });
  });
  it("a credit whose negative totals agree: same", () => {
    expect(reading({ amount: -18.40 }, [bill("b1", { amount: "-18.40" })])).toEqual({ same: "b1", namesake: null });
  });
  it("18.40 against 18.400000001 agrees (cents decide)", () => {
    expect(reading({ amount: 18.400000001 }, [bill("b1", { amount: "18.40" })])).toEqual({ same: "b1", namesake: null });
  });
  it("a total that was not read (null, NaN, \"abc\") cannot disagree: same, as before", () => {
    for (const amount of [null, Number.NaN, "abc"]) expect(reading({ amount }, [bill("b1")])).toEqual({ same: "b1", namesake: null });
  });
  it("an unread total takes the purchase carrying the number as its own before a statement", () => {
    expect(reading({ amount: null }, [bill("st1", STATEMENT), bill("b1")])).toEqual({ same: "b1", namesake: null });
    expect(reading({ amount: null }, [bill("st1", STATEMENT)])).toEqual({ same: "st1", namesake: null });
  });
  it("a string amount \"18.40\" agrees", () => {
    expect(reading({ amount: "18.40" }, [bill("b1", { amount: 18.40 })])).toEqual({ same: "b1", namesake: null });
  });
  it("a statement that names the number on its lines, alone: same (the money test does not apply)", () => {
    expect(reading({}, [bill("st1", STATEMENT)])).toEqual({ same: "st1", namesake: null });
  });
  it("a statement beside one own-number purchase at another total: same, the statement", () => {
    expect(reading({}, [bill("b1"), bill("st1", STATEMENT)])).toEqual({ same: "st1", namesake: null });
  });
  it("a statement beside one own-number purchase at the paper's total: same, the own one", () => {
    expect(reading({}, [bill("st1", STATEMENT), bill("b1", { amount: "18.40" })])).toEqual({ same: "b1", namesake: null });
  });
  it("a member whose own amount is null is never agreed by a paper of 0.00", () => {
    expect(reading({ amount: 0 }, [bill("o1", { bill_number: "SO-88", amount: "5.00" }), bill("c1", { amount: null, corrects_bill_id: "o1" })])).toEqual({ same: null, namesake: "o1" });
  });
  it("no paper date, two purchases of the same total: not same", () => {
    expect(reading({ date: null }, [bill("b1", { amount: "18.40" }), bill("b2", { amount: "18.40" })])).toEqual({ same: null, namesake: null });
  });
  it("the number in supplier_invoice_number is the purchase's own", () => {
    expect(reading({}, [bill("b1", { bill_number: null, supplier_invoice_number: "#417" })])).toEqual({ same: null, namesake: "b1" });
  });
  // The reviewer's surviving mutants (skeptic #105) and the hardening of fixer 1211.
  it("a purchase with no amount on any member has no total: a paper of 0.00 never agrees with it", () => {
    expect(reading({ amount: 0 }, [bill("b1", { amount: null, bill_date: "2026-11-23" })])).toEqual({ same: null, namesake: "b1" });
    expect(reading({ amount: "0.00" }, [bill("o1", { bill_number: "SO-88", amount: null }), bill("c1", { amount: null, corrects_bill_id: "o1" })])).toEqual({ same: null, namesake: "o1" });
  });
  it("the day is read from EVERY member: only the correction dated on the paper's day, beside a second purchase, is the twin", () => {
    expect(
      reading({}, [bill("b2"), bill("o1", { bill_number: "SO-88", amount: "10.00" }), bill("c1", { amount: "8.40", bill_date: "2026-11-23", corrects_bill_id: "o1" })]),
    ).toEqual({ same: "o1", namesake: null });
  });
  it("a bill_date that is a timestamp agrees by its first ten characters", () => {
    expect(reading({}, [bill("b1"), bill("b2", { amount: "18.40", bill_date: "2026-11-23T08:15:00+00:00" })])).toEqual({ same: "b2", namesake: null });
  });
  it("a paper date that is a timestamp agrees by its first ten characters", () => {
    expect(reading({ date: "2026-11-23T17:40:00Z" }, [bill("b1"), bill("b2", { amount: "18.40", bill_date: "2026-11-23" })])).toEqual({ same: "b2", namesake: null });
  });
  it("the sign counts: a paper of -50.00 does not agree with a bill of 50.00, nor the reverse", () => {
    expect(reading({ amount: -50 }, [bill("b1", { amount: "50.00" })])).toEqual({ same: null, namesake: "b1" });
    expect(reading({ amount: 50 }, [bill("b1", { amount: "-50.00" })])).toEqual({ same: null, namesake: "b1" });
    expect(reading({ amount: "-50.00" }, [bill("b1", { amount: "50.00", bill_date: "2026-11-23" }), bill("b2", { amount: "8.00" })])).toEqual({ same: null, namesake: null });
  });
  it("two twins by total and day: the FIRST", () => {
    const twin = { amount: "18.40", bill_date: "2026-11-23" };
    expect(reading({}, [bill("b1"), bill("t1", twin), bill("t2", twin)])).toEqual({ same: "t1", namesake: null });
  });
  it("two statements naming the number: the FIRST", () => {
    expect(reading({}, [bill("st1", STATEMENT), bill("st2", { ...STATEMENT, bill_number: "STMT-12" })])).toEqual({ same: "st1", namesake: null });
  });
});

describe("namesakeSaid: the plain line beside a recorded paper", () => {
  it("says it was recorded and names the bill, in fixed words", () => {
    expect(namesakeSaid("Bayberry Lumber #417, $61.75, 2026-11-02, on J-902 Stand-in Deck")).toBe(
      "Recorded as its own purchase. A bill with the same number is already on the books at another total: Bayberry Lumber #417, $61.75, 2026-11-02, on J-902 Stand-in Deck.",
    );
  });
});
