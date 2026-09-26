import { describe, it, expect } from "vitest";
import { supplierSaysBalance } from "./supplier-balance";
import {
  claimableDiscounts,
  discountReading,
  invoicesNeedingBill,
  invoicesNeedingJob,
  isUsableJobName,
  lateInterest,
  matchJobName,
  missedDiscounts,
  needsJobTotals,
  openDocuments,
  reconcileSummary,
  supplierSaysOpen,
  type ReconcileJob,
  type SupplierInvoiceRow,
} from "./supplier-reconcile";

/**
 * THE REAL BOOK, THE NIGHT IT WAS RECONCILED (Erik, 2026-09-19; migration 0273).
 *
 * Every string in this file came off his CED portal or out of his own job list. Nothing is
 * invented, because the whole value of the matcher is how it behaves on HIS drift - four spellings
 * of one road, two typos, a unit number written with and without a space, and a job name field
 * that once got filled with the form's own column header.
 *
 * The numbers the assertions turn on, all of them checked against the loaded table:
 *   · CED says $3,845.14 open across 20 documents ($4,102.47 of charges less $257.33 of credits).
 *   · $25.48 of prompt-pay discount still claimable, all of it by 10 October. NOT the $29.62
 *     the column sums to: the $4.14 on 8802-1107230 rides on an invoice its own credit memo has
 *     already reversed, and CED does not discount money it has taken back.
 *   · $25.99 of it already expired on invoices that are still open.
 *   · $60.42 of late interest charged, $46.42 of that still open.
 *   · $1,765.72 of settled invoices with no bill anywhere in the app.
 */

const TODAY = "2026-09-19";
/** The day his records start: the app's first scanned bill. Anything CED sent before that could
 *  not possibly have been recorded here, so it is counted and named, never nagged about. */
const RECORDS_START = "2026-06-01";

/** His jobs, exactly as they read in his book tonight. Five of them are on Rhodesia Road and two
 *  are at 235 Timbercreek, which is the entire reason this matcher refuses to pick. */
const JOBS: ReconcileJob[] = [
  { id: "j-002", jobNumber: "J-002", name: "Tao Zhu", status: "in_progress", address: "235 Timbercreek Court" },
  { id: "j-006", jobNumber: "J-006", name: "5659 Rhodesia", status: "complete", address: "5659 Rhodesia Road" },
  { id: "j-009", jobNumber: "J-009", name: "TTP #11", status: "complete", address: "300 W Lake Blvd, Tahoe City, CA 96145, USA" },
  { id: "j-010", jobNumber: "J-010", name: "11301 Purple Sage", status: "complete", address: "11301 Purple Sage Rd, Truckee, CA 96161, USA" },
  { id: "j-011", jobNumber: "J-011", name: "13897 Herringbone", status: "in_progress", address: "13897 Herringbone Way" },
  { id: "j-013", jobNumber: "J-013", name: "TTP #56", status: "on_hold", address: "300 W Lake Blvd, Tahoe City, CA 96145, USA" },
  { id: "j-014", jobNumber: "J-014", name: "5659 Rhodesia", status: "to_be_scheduled", address: "5659 Rhodesia Rd, Carnelian Bay, CA 96140, USA" },
  { id: "j-016", jobNumber: "J-016", name: "13466 Northwoods", status: "complete", address: "13466 Northwoods Boulevard" },
  { id: "j-017", jobNumber: "J-017", name: "TTP #224", status: "complete", address: "300 West Lake Boulevard" },
  { id: "j-028", jobNumber: "J-028", name: "85 Whitney Place", status: "in_progress", address: "85 Whitney Court" },
  { id: "j-030", jobNumber: "J-030", name: "13631 Northwoods", status: "complete", address: "13631 Northwoods Boulevard" },
  { id: "j-032", jobNumber: "J-032", name: "Tao Zhu - Chandalier", status: "complete", address: "235 Timbercreek Ct, Reno, NV 89511, USA" },
  { id: "j-033", jobNumber: "J-033", name: "5659 Rhodesia", status: "complete", address: "5659 Rhodesia Rd, Carnelian Bay, CA 96140, USA" },
  { id: "j-034", jobNumber: "J-034", name: "5659 Rhodesia - Panel Upgrade", status: "on_hold", address: "5659 Rhodesia Road" },
  { id: "j-039", jobNumber: "J-039", name: "10410 Badger Lane", status: "complete", address: "10410 Badger Lane" },
  { id: "j-042", jobNumber: "J-042", name: "TTP #106", status: "in_progress", address: "300 West Lake Boulevard" },
  { id: "j-045", jobNumber: "J-045", name: "13683 Hillside", status: "complete", address: "13683 Hillside Drive" },
  { id: "j-047", jobNumber: "J-047", name: "Jackie Burks", status: "scheduled", address: "5659 Rhodesia Road" },
];

const jobNamed = (name: string) => JOBS.find((j) => j.name === name)!.id;

let seq = 0;
function invoice(partial: Partial<SupplierInvoiceRow>): SupplierInvoiceRow {
  seq += 1;
  return {
    id: `si-${seq}`,
    invoiceNumber: `8802-110${1000 + seq}`,
    kind: "invoice",
    invoiceDate: "2026-09-01",
    dueDate: null,
    jobNameRaw: null,
    jobId: null,
    jobName: null,
    total: 0,
    openBalance: null,
    closed: false,
    discountAmount: null,
    discountBy: null,
    sourceFile: null,
    billCount: 0,
    ...partial,
  };
}

/**
 * The twenty documents CED calls open tonight, plus the settled ones that matter to a section
 * below. Numbers, dates, job names and discounts are copied from the portal.
 */
function hisBook(): SupplierInvoiceRow[] {
  return [
    // ── open ────────────────────────────────────────────────────────────────────────────────
    invoice({ invoiceNumber: "8802-1107820", invoiceDate: "2026-09-16", jobNameRaw: "85 WHITNEY", total: 187.64, openBalance: 187.64, discountAmount: 1.77, discountBy: "2026-10-10" }),
    invoice({ invoiceNumber: "8802-1107695", invoiceDate: "2026-09-16", jobNameRaw: "85 WHITNEY", total: 1062.18, openBalance: 1062.18, discountAmount: 8.47, discountBy: "2026-10-10", billCount: 1 }),
    invoice({ invoiceNumber: "8802-1106969", invoiceDate: "2026-09-04", jobNameRaw: "13897 HERRINGBONE", total: 301.81, openBalance: 301.81, discountAmount: 5.54, discountBy: "2026-10-10" }),
    invoice({ invoiceNumber: "8802-1107337", invoiceDate: "2026-09-03", kind: "credit_memo", jobNameRaw: "TTP 106", total: -225.47, openBalance: -225.47 }),
    invoice({ invoiceNumber: "8802-1107338", invoiceDate: "2026-09-03", jobNameRaw: "TTP106", total: 223.29, openBalance: 223.29, discountAmount: 4.1, discountBy: "2026-10-10" }),
    invoice({ invoiceNumber: "8802-1107230", invoiceDate: "2026-09-03", jobNameRaw: "TTP 106", total: 225.47, openBalance: 225.47, discountAmount: 4.14, discountBy: "2026-10-10" }),
    invoice({ invoiceNumber: "8802-1107139", invoiceDate: "2026-09-01", jobNameRaw: "13683 HILLSIDE", total: 59.17, openBalance: 59.17, discountAmount: 0.9, discountBy: "2026-10-10" }),
    invoice({ invoiceNumber: "8802-1107088", invoiceDate: "2026-09-01", jobNameRaw: "13683 HILLSIDE", total: 456.02, openBalance: 456.02, discountAmount: 4.7, discountBy: "2026-10-10", billCount: 1 }),
    invoice({ invoiceNumber: "9019994306", invoiceDate: "2026-08-25", kind: "service_charge", total: 15.16, openBalance: 15.16 }),
    invoice({ invoiceNumber: "8802-1106249", invoiceDate: "2026-08-21", jobNameRaw: "13897 HERRING BONE", total: 150.27, openBalance: 150.27, discountAmount: 1.15, discountBy: "2026-09-10", billCount: 1 }),
    invoice({ invoiceNumber: "8802-1106188", invoiceDate: "2026-08-21", jobNameRaw: "13897 HARRINGBONE", total: 199.48, openBalance: 199.48, discountAmount: 3.67, discountBy: "2026-09-10", billCount: 1 }),
    invoice({ invoiceNumber: "8802-1105997", invoiceDate: "2026-08-19", jobNameRaw: "10429 BADGER", total: 2.3, openBalance: 2.3, discountAmount: 0.04, discountBy: "2026-09-10" }),
    invoice({ invoiceNumber: "8802-1105963", invoiceDate: "2026-08-19", jobNameRaw: "85 WHITNEY PL", total: 84.37, openBalance: 84.37, discountAmount: 0.26, discountBy: "2026-09-10", billCount: 1 }),
    invoice({ invoiceNumber: "8802-1104645", invoiceDate: "2026-08-06", kind: "credit_memo", jobNameRaw: "13631 NORTHWOODS", total: -31.86, openBalance: -31.86 }),
    invoice({ invoiceNumber: "8802-1104646", invoiceDate: "2026-07-29", jobNameRaw: "13631 NORTHWOODS", total: 36.54, openBalance: 36.54, discountAmount: 0.34, discountBy: "2026-08-10", billCount: 1 }),
    invoice({ invoiceNumber: "8802-1104644", invoiceDate: "2026-07-29", jobNameRaw: "85 WHITNEY PLACE", total: 95.27, openBalance: 95.27, discountAmount: 1.48, discountBy: "2026-08-10", billCount: 1 }),
    invoice({ invoiceNumber: "8802-1104268", invoiceDate: "2026-07-28", jobNameRaw: "13631 NORTHWOODS", total: 859.99, openBalance: 859.99, discountAmount: 6.25, discountBy: "2026-08-10", billCount: 1 }),
    invoice({ invoiceNumber: "8802-1104147", invoiceDate: "2026-07-28", jobNameRaw: "13631 NORTHWOODS", total: 101.96, openBalance: 101.96, discountAmount: 0.93, discountBy: "2026-08-10" }),
    invoice({ invoiceNumber: "9019682437", invoiceDate: "2026-07-25", kind: "service_charge", total: 31.26, openBalance: 31.26 }),
    // Part paid: $998.77 raised, $10.29 still open. The balance must read the OPEN figure.
    invoice({ invoiceNumber: "8802-1103832", invoiceDate: "2026-07-22", jobNameRaw: "13631 NORTHWOODS", total: 998.77, openBalance: 10.29, discountAmount: 11.87, discountBy: "2026-08-10", billCount: 1 }),

    // ── settled, and recorded nowhere in the app: the $1,765.72 ─────────────────────────────
    invoice({ invoiceNumber: "8802-1105878", invoiceDate: "2026-08-19", jobNameRaw: "5659 RHODESIA", total: 216.44, closed: true }),
    invoice({ invoiceNumber: "8802-1102291", invoiceDate: "2026-06-29", jobNameRaw: "CUSTOMER ORDER NO.", total: 451.75, closed: true }),
    invoice({ invoiceNumber: "8802-1102103", invoiceDate: "2026-06-25", jobNameRaw: "TTP56", total: 523.47, closed: true }),
    invoice({ invoiceNumber: "8802-1101475", invoiceDate: "2026-06-16", jobNameRaw: "11301 PURPLE SAGE", total: 186.93, closed: true }),
    invoice({ invoiceNumber: "8802-1101219", invoiceDate: "2026-06-11", jobNameRaw: "5659 RODESSIA", total: 4.63, closed: true }),
    invoice({ invoiceNumber: "8802-1101094", invoiceDate: "2026-06-10", jobNameRaw: "561 RHODESIA", total: 379.35, closed: true }),
    invoice({ invoiceNumber: "8802-1100911", invoiceDate: "2026-06-08", jobNameRaw: "5661 RHODESIA", total: 3.15, closed: true }),

    // ── settled, before his records start, and with a bill or without ───────────────────────
    invoice({ invoiceNumber: "8802-1100090", invoiceDate: "2026-05-28", jobNameRaw: "5659 RHODESIA", total: 744.96, closed: true }),
    invoice({ invoiceNumber: "8802-1099048", invoiceDate: "2026-05-28", jobNameRaw: "3639 SADDLE RD", total: 355.17, closed: true }),
    invoice({ invoiceNumber: "9019059048", invoiceDate: "2026-05-25", kind: "service_charge", total: 14, closed: true }),

    // A statement is a SUMMARY of invoices already in this list. It must never touch the balance.
    invoice({ invoiceNumber: "STATEMENT-082526", invoiceDate: "2026-08-25", kind: "statement", total: 2587.66, closed: true }),
  ];
}

// ── THE MATCHER, ON HIS ACTUAL DRIFT ────────────────────────────────────────────────────────────

describe("matching a CED job name to one of his jobs", () => {
  const top = (raw: string) => matchJobName(raw, JOBS).ranked[0]?.job.name;

  it("picks 13631 Northwoods over 13466 Northwoods, because the house number decides", () => {
    const m = matchJobName("13631 NORTHWOODS", JOBS);
    expect(m.verdict).toBe("one");
    expect(m.ranked[0].job.id).toBe("j-030");
    // Same street, wrong house. It must not be the front-runner, and it must not tie.
    expect(m.ranked[1].job.id).not.toBe("j-030");
    expect(m.ranked[0].score - m.ranked[1].score).toBeGreaterThan(0.75);
  });

  it("matches 85 WHITNEY PLACE and the shorter 85 WHITNEY to the same job", () => {
    expect(matchJobName("85 WHITNEY PLACE", JOBS).verdict).toBe("one");
    expect(top("85 WHITNEY PLACE")).toBe("85 Whitney Place");
    expect(matchJobName("85 WHITNEY", JOBS).verdict).toBe("one");
    expect(top("85 WHITNEY")).toBe("85 Whitney Place");
    // And "85 WHITNEY PL", the third spelling on the same account.
    expect(top("85 WHITNEY PL")).toBe("85 Whitney Place");
  });

  it("reads through CED's two Herringbone spellings, one of them a typo", () => {
    for (const raw of ["13897 HERRINGBONE", "13897 HERRING BONE", "13897 HARRINGBONE"]) {
      const m = matchJobName(raw, JOBS);
      expect(m.verdict, raw).toBe("one");
      expect(m.ranked[0].job.id, raw).toBe("j-011");
    }
  });

  it("treats TTP 106 and TTP106 as the same unit, and does not confuse it with TTP 11 or TTP 56", () => {
    for (const raw of ["TTP 106", "TTP106"]) {
      const m = matchJobName(raw, JOBS);
      expect(m.verdict, raw).toBe("one");
      expect(m.ranked[0].job.id, raw).toBe("j-042");
    }
    expect(matchJobName("TTP56", JOBS).ranked[0].job.id).toBe("j-013");
    expect(matchJobName("TTP 56", JOBS).ranked[0].job.id).toBe("j-013");
  });

  it("ASKS about 5659 RODESSIA, because he has five jobs on that road", () => {
    const m = matchJobName("5659 RODESSIA", JOBS);
    expect(m.verdict).toBe("ask");
    // Every job whose address is 5659 Rhodesia is in the running, under whatever name he gave it.
    const close = m.ranked.filter((g) => m.ranked[0].score - g.score < 0.75).map((g) => g.job.id);
    expect(close).toContain("j-006");
    expect(close).toContain("j-033");
    expect(close).toContain("j-047");
    expect(close.length).toBeGreaterThanOrEqual(3);
    expect(m.because).toContain("Only you know");
  });

  it("ASKS about 235 TIMBER CREEK, because both Tao Zhu jobs are at that address", () => {
    const m = matchJobName("235 TIMBER CREEK", JOBS);
    expect(m.verdict).toBe("ask");
    const close = m.ranked.filter((g) => m.ranked[0].score - g.score < 0.75).map((g) => g.job.id);
    expect(close).toContain("j-002");
    expect(close).toContain("j-032");
  });

  it("never offers a job for STOCK, which is not one", () => {
    const m = matchJobName("STOCK", JOBS);
    expect(m.verdict).toBe("stock");
    expect(m.ranked).toEqual([]);
    expect(m.because).toContain("shop stock");
  });

  it("calls CED's own column header a blank, and still offers every job", () => {
    const m = matchJobName("CUSTOMER ORDER NO.", JOBS);
    expect(m.verdict).toBe("blank");
    expect(m.ranked).toHaveLength(JOBS.length);
    expect(m.because).toContain("no job name");
    // An empty field lands in the same place.
    expect(matchJobName("", JOBS).verdict).toBe("blank");
    expect(matchJobName(null, JOBS).verdict).toBe("blank");
  });

  it("knows CED's column header is not a name, by the same rule the screen reads rows with", () => {
    // One rule, two readers: the matcher's verdict and the row title above it. If they ever
    // parted company a row would quote "CUSTOMER ORDER NO." back at him as a place.
    expect(isUsableJobName("CUSTOMER ORDER NO.")).toBe(false);
    expect(isUsableJobName("  ")).toBe(false);
    expect(isUsableJobName(null)).toBe(false);
    expect(isUsableJobName("N/A")).toBe(false);
    expect(isUsableJobName("5659 RODESSIA")).toBe(true);
    expect(isUsableJobName("STOCK")).toBe(true); // a real word CED meant; just never a job
  });

  it("says so plainly when a house number is one he has no job at", () => {
    // CED wrote 561 and 5661 for a road where his five jobs are all at 5659. Guessing one of them
    // would be inventing a job cost; saying nothing looks right is the true answer.
    for (const raw of ["561 RHODESIA", "5661 RHODESIA"]) {
      const m = matchJobName(raw, JOBS);
      expect(m.verdict, raw).toBe("weak");
      expect(m.ranked.length, raw).toBe(JOBS.length);
      expect(m.because, raw).toContain("Nothing on your job list");
    }
  });

  it("ranks the closest job first even when it will not call it a guess", () => {
    // "10429 BADGER" against a job at 10410 Badger Lane: same street, a house number that is not
    // his. Badger still goes to the top of the list - a ranking is a convenience, never a filter.
    const m = matchJobName("10429 BADGER", JOBS);
    expect(m.verdict).toBe("weak");
    expect(m.ranked[0].job.id).toBe("j-039");
    expect(m.ranked).toHaveLength(JOBS.length);
  });

  it("always hands back every job, so the one he wants is never missing", () => {
    for (const raw of ["13631 NORTHWOODS", "5659 RODESSIA", "235 TIMBER CREEK", "10429 BADGER"]) {
      expect(matchJobName(raw, JOBS).ranked, raw).toHaveLength(JOBS.length);
    }
  });

  it("has nothing to offer when he has no jobs, and does not pretend otherwise", () => {
    const m = matchJobName("13631 NORTHWOODS", []);
    expect(m.ranked).toEqual([]);
    expect(m.verdict).toBe("weak");
  });
});

// ── WHAT CED SAYS ───────────────────────────────────────────────────────────────────────────────

describe("what the supplier says is open", () => {
  it("reads $3,845.14 across 20 documents, which is what the portal prints", () => {
    const says = supplierSaysOpen(hisBook());
    expect(says.owed).toBe(3845.14);
    expect(says.charges).toBe(4102.47);
    expect(says.credits).toBe(257.33);
    expect(says.documents).toBe(20);
    expect(says.asOf).toBe("2026-09-16");
  });

  it("uses the OPEN balance, not the invoice total, on a part-paid document", () => {
    // 8802-1103832 was raised at $998.77 and has $10.29 left on it. Reading the total would put
    // $988.48 of money he has already paid back onto his balance.
    const one = hisBook().filter((i) => i.invoiceNumber === "8802-1103832");
    expect(supplierSaysOpen(one).owed).toBe(10.29);
  });

  it("is the SAME number the account card above it prints, to the cent", () => {
    // The two cards measure one question. If this ever drifts, one of his screens is arguing with
    // the other, which is the fault this whole wave exists to delete.
    const book = hisBook();
    expect(supplierSaysOpen(book).owed).toBe(supplierSaysBalance(book, TODAY)!.gross);
    expect(claimableDiscounts(book, TODAY).total).toBe(
      supplierSaysBalance(book, TODAY)!.discountStillClaimable,
    );
    expect(missedDiscounts(book, TODAY).total).toBe(
      supplierSaysBalance(book, TODAY)!.discountExpiredUnclaimed,
    );
  });

  it("still agrees the day after the deadline, which is when the missed column fills up", () => {
    /**
     * THE $4.14 THAT WAS GOING TO BECOME MONEY HE LOST (review, 2026-09-20).
     *
     * Invoice 8802-1107230 is reversed to the cent by open credit memo 8802-1107337, so its $4.14
     * is correctly left out of what is still on the table. `missedDiscounts` had no such rule -
     * it was the one of the three discount readings with no reversal filter - and it was dormant
     * only because that deadline had not passed. On 11 October, if CED has not yet closed the
     * invoice and its memo together (they close only when he pays the covering statement), the
     * card would have told him he let a prompt-pay discount expire on five receptacles he sent
     * back and was never billed for. Before the fix this read 55.61 against the balance's 51.47.
     *
     * Asserting it at a date PAST the deadline is the point: at TODAY both sides are 25.99 and
     * the parity above passes either way, which is why this went unnoticed.
     */
    const AFTER = "2026-10-11";
    const book = hisBook();
    expect(missedDiscounts(book, AFTER).total).toBe(
      supplierSaysBalance(book, AFTER)!.discountExpiredUnclaimed,
    );
    expect(missedDiscounts(book, AFTER).rows.some((r) => r.invoice.invoiceNumber === "8802-1107230")).toBe(false);
    // And the rebill CED wrote in its place - 8802-1107338, the $223.29 he really owes - is still
    // counted, because only the reversed half drops out.
    expect(missedDiscounts(book, AFTER).rows.some((r) => r.invoice.invoiceNumber === "8802-1107338")).toBe(true);
  });

  it("falls back to the total when the supplier gave no open figure, never to zero", () => {
    const one = [invoice({ total: 120.5, openBalance: null, closed: false })];
    expect(supplierSaysOpen(one).owed).toBe(120.5);
  });

  it("lists the open documents newest first", () => {
    const docs = openDocuments(hisBook());
    expect(docs).toHaveLength(20);
    expect(docs[0].invoiceNumber).toBe("8802-1107820");
    expect(docs[docs.length - 1].invoiceNumber).toBe("8802-1103832");
  });
});

// ── THE THREE THINGS THAT NEED HIM ──────────────────────────────────────────────────────────────

describe("invoices with no job", () => {
  const rows = () => invoicesNeedingJob(hisBook(), JOBS);

  it("takes in invoices and credit memos, and never interest or statements", () => {
    const kinds = new Set(rows().map((r) => r.invoice.kind));
    expect(kinds.has("invoice")).toBe(true);
    expect(kinds.has("credit_memo")).toBe(true);
    expect(kinds.has("service_charge")).toBe(false);
    expect(kinds.has("statement")).toBe(false);
  });

  it("puts the biggest money first, because that is the job cost most worth two minutes", () => {
    // 8802-1107695 ($1,062.18) is bigger, and a bill already covers it, so it asks nothing. Of
    // what is left, from the day his records start, TTP56's $523.47 leads.
    expect(invoicesNeedingJob(hisBook(), JOBS, { since: RECORDS_START })[0].invoice.invoiceNumber).toBe("8802-1102103");
  });

  it("never lists a paper a bill already covers: its job is the bill's (Wave A, the 19 covered papers)", () => {
    const covered = hisBook().filter((i) => (Number(i.billCount) || 0) > 0 && !i.jobId).map((i) => i.invoiceNumber);
    expect(covered.length).toBeGreaterThan(5);
    const listed = rows().map((r) => r.invoice.invoiceNumber);
    for (const n of covered) expect(listed).not.toContain(n);
  });

  it("leaves out everything dated before his books began, and keeps the day itself", () => {
    const listed = invoicesNeedingJob(hisBook(), JOBS, { since: "2026-06-08" }).map((r) => r.invoice.invoiceNumber);
    expect(listed).not.toContain("8802-1100090"); // 5/28 5659 RHODESIA
    expect(listed).not.toContain("8802-1099048"); // 5/28 3639 SADDLE RD
    expect(listed).toContain("8802-1100911"); // 6/08 itself counts
  });

  it("leaves out an invoice a person has already placed", () => {
    const placed = hisBook().map((i) =>
      i.invoiceNumber === "8802-1107695" ? { ...i, jobId: jobNamed("85 Whitney Place"), jobName: "85 Whitney Place" } : i,
    );
    const numbers = invoicesNeedingJob(placed, JOBS).map((r) => r.invoice.invoiceNumber);
    expect(numbers).not.toContain("8802-1107695");
  });

  it("counts the ones it will not decide separately from the ones it will", () => {
    const totals = needsJobTotals(rows());
    expect(totals.rows).toBeGreaterThan(0);
    expect(totals.undecided).toBeGreaterThan(0);
    // Nothing on his account is shop stock tonight; the counter exists for when it is.
    expect(totals.stock).toBe(0);
  });

  it("holds a STOCK invoice in the list but offers it nothing", () => {
    const book = [...hisBook(), invoice({ invoiceNumber: "8802-1103061", jobNameRaw: "STOCK", total: 114.4, closed: true })];
    const stockRow = invoicesNeedingJob(book, JOBS).find((r) => r.invoice.invoiceNumber === "8802-1103061");
    expect(stockRow).toBeTruthy();
    expect(stockRow!.match.verdict).toBe("stock");
    expect(stockRow!.match.ranked).toEqual([]);
    expect(needsJobTotals(invoicesNeedingJob(book, JOBS)).stockTotal).toBe(114.4);
  });
});

describe("invoices with no bill", () => {
  it("adds up to the $1,765.72 CED has already settled and nothing here ever saw", () => {
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    expect(slice.settledTotal).toBe(1765.72);
    expect(slice.settledRows).toBe(7);
    const numbers = slice.rows.filter((r) => r.closed).map((r) => r.invoiceNumber);
    expect(numbers).toContain("8802-1102103"); // TTP56, $523.47, on a job about to be billed
    expect(numbers).toContain("8802-1101475"); // Purple Sage, $186.93, job already paid and closed
  });

  it("counts the open ones too, and keeps the two totals apart", () => {
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    expect(slice.openRows).toBeGreaterThan(0);
    expect(slice.total).toBe(Number((slice.settledTotal + slice.openTotal).toFixed(2)));
  });

  it("is only ever about PURCHASES - never a statement, a credit or an interest charge", () => {
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    expect(slice.rows.every((r) => r.kind === "invoice")).toBe(true);
  });

  it("puts the settled ones first, because nothing else on the screen will mention them again", () => {
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    expect(slice.rows[0].closed).toBe(true);
  });

  it("counts what it left behind instead of dropping it", () => {
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    // Two May purchases predate his first scanned bill: $744.96 and $355.17.
    expect(slice.olderRows).toBe(2);
    expect(slice.olderTotal).toBe(1100.13);
    expect(slice.since).toBe(RECORDS_START);
    // With no boundary, every one of them is on the list and nothing is left over.
    const all = invoicesNeedingBill(hisBook(), {});
    expect(all.olderRows).toBe(0);
    expect(all.total).toBe(Number((slice.total + slice.olderTotal).toFixed(2)));
  });

  it("leaves out an invoice a scanned bill already covers", () => {
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    expect(slice.rows.map((r) => r.invoiceNumber)).not.toContain("8802-1104268");
  });

  /**
   * THE WRONG COLOUR RETURN. 8802-1107230 is five light almond USB receptacles Erik sent straight
   * back; 8802-1107337 is CED taking the $225.47 off again, and its own PDF names its parent
   * ("ORIGINAL INVOICE(S): 1107230"). Both are open, both name TTP 106, and no bill covers the
   * invoice - so before this rule the list offered "Record It As A Bill" on merchandise he does
   * not have, one tap from a customer's job. The ivory replacement beside it, 8802-1107338, is a
   * real purchase and must stay.
   */
  it("never offers a purchase a credit memo already took back off the account", () => {
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    const numbers = slice.rows.map((r) => r.invoiceNumber);
    expect(numbers).not.toContain("8802-1107230");
    expect(numbers).toContain("8802-1107338");
    expect(slice.reversedRows).toBe(1);
    expect(slice.reversedTotal).toBe(225.47);
  });

  it("does not quietly lose the returned money out of its own totals", () => {
    // What it left out is counted, not dropped: rows + older + reversed is every purchase there is.
    const slice = invoicesNeedingBill(hisBook(), { since: RECORDS_START });
    expect(slice.total).toBe(Number((slice.settledTotal + slice.openTotal).toFixed(2)));
    const purchases = hisBook().filter((r) => r.kind === "invoice" && !(Number(r.billCount) || 0));
    const every = purchases.reduce((s, r) => Number((s + Number(r.total)).toFixed(2)), 0);
    expect(Number((slice.total + slice.olderTotal + slice.reversedTotal).toFixed(2))).toBe(every);
  });
});

describe("the prompt-pay discount, and the interest he paid instead", () => {
  it("has $25.48 still claimable, all of it by 10 October", () => {
    const live = claimableDiscounts(hisBook(), TODAY);
    expect(live.total).toBe(25.48);
    // Six, not seven: the reversed 8802-1107230 is not among them.
    expect(live.rows).toHaveLength(6);
    expect(live.nextDeadline).toBe("2026-10-10");
    expect(live.daysLeft).toBe(21);
    // Every one of his falls on the same day, so the whole figure rides on that date and the
    // card is entitled to say so.
    expect(live.dueOnNext).toBe(25.48);
  });

  it("separates what rides on the SOONEST date from the whole claimable figure", () => {
    // The day an August invoice sits beside a September one, "$25.48 comes off if you pay by the
    // 10th" stops being true. dueOnNext is what keeps that sentence honest without the screen
    // having to work anything out.
    const mixed = [
      invoice({ total: 100, discountAmount: 2, discountBy: "2026-09-25" }),
      invoice({ total: 100, discountAmount: 3, discountBy: "2026-09-25" }),
      invoice({ total: 100, discountAmount: 7, discountBy: "2026-10-10" }),
    ];
    const live = claimableDiscounts(mixed, TODAY);
    expect(live.total).toBe(12);
    expect(live.nextDeadline).toBe("2026-09-25");
    expect(live.dueOnNext).toBe(5);
  });

  it("has $25.99 that already expired on invoices that are still open", () => {
    expect(missedDiscounts(hisBook(), TODAY).total).toBe(25.99);
  });

  it("calls a discount on a settled document neither live nor missed", () => {
    // It was taken or it was not. Either way there is nothing left to decide, so it must not sit
    // on a screen headed "about to expire" and it must not be counted as money he lost.
    const settled = invoice({ total: 100, closed: true, discountAmount: 2, discountBy: "2026-10-10" });
    expect(discountReading(settled, TODAY).state).toBe("none");
    expect(claimableDiscounts([settled], TODAY).total).toBe(0);
    expect(missedDiscounts([settled], TODAY).total).toBe(0);
  });

  it("is still live on the last day, and expired the next", () => {
    const onTheDay = invoice({ total: 100, discountAmount: 2, discountBy: "2026-09-19" });
    expect(discountReading(onTheDay, TODAY).state).toBe("live");
    expect(discountReading(onTheDay, TODAY).daysLeft).toBe(0);
    expect(discountReading(onTheDay, "2026-09-20").state).toBe("expired");
  });

  it("says what being late has cost: $60.42 charged, $46.42 of it still open", () => {
    const interest = lateInterest(hisBook());
    expect(interest.charged).toBe(60.42);
    expect(interest.stillOpen).toBe(46.42);
    expect(interest.documents).toBe(3);
  });
});

describe("the summary the account card reads", () => {
  it("agrees to the penny with the functions underneath it", () => {
    const book = hisBook();
    const s = reconcileSummary(book, JOBS, TODAY, { since: RECORDS_START });
    expect(s.says.owed).toBe(3845.14);
    expect(s.claimable.total).toBe(25.48);
    expect(s.claimable.by).toBe("2026-10-10");
    expect(s.claimable.dueOnNext).toBe(25.48);
    expect(s.missed).toBe(25.99);
    expect(s.interest.charged).toBe(60.42);
    expect(s.needsBill.settledTotal).toBe(1765.72);
    expect(s.needsJob.rows).toBe(invoicesNeedingJob(book, JOBS, { since: RECORDS_START }).length);
    expect(s.anyOpenQuestions).toBe(true);
  });

  it("has no open questions on an account that is fully placed, billed and in date", () => {
    const clean = [
      invoice({ total: 100, closed: true, billCount: 1, jobId: "j-030", jobNameRaw: "13631 NORTHWOODS" }),
    ];
    const s = reconcileSummary(clean, JOBS, TODAY, { since: RECORDS_START });
    expect(s.anyOpenQuestions).toBe(false);
    expect(s.says.owed).toBe(0);
  });
});
