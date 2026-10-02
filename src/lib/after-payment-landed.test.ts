import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

/**
 * WHAT HAPPENS AFTER MONEY LANDS ON AN INVOICE (M1) — the four steps, without a database.
 *
 * THE DEFECT THIS WOULD HAVE CAUGHT: a deposit matched out of the bank download recomputed the
 * invoice and stopped. The job it paid off stayed "in progress" on the tile, the map and My Day;
 * nobody was told; no screen refreshed. Two of the four steps, at one of three doors.
 *
 * So: the recalc lands, a paid-off job is finished, the bell rings ONCE in the door's own words, and
 * the money screens are refreshed — and when the recalc does NOT land, nothing is finished off a
 * stale balance and the refusal says so in words.
 */
const calls = vi.hoisted(() => ({
  revalidated: [] as string[],
  pushedToGoogle: [] as string[],
  reported: [] as string[],
  rang: [] as { org: string | null | undefined; people: string[]; kind: string; line: { title: string; body?: string | null; url?: string | null } }[],
  staff: ["erik", "office-2", "office-3"] as string[],
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => calls.revalidated.push(p) }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: async (_k: string, id: string) => void calls.pushedToGoogle.push(id) }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void calls.reported.push(where) }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: async () => {} }));
vi.mock("@/lib/push", () => ({ orgStaffIds: async () => calls.staff }));
vi.mock("@/lib/notifications", () => ({
  notifyPeople: async (org: string | null | undefined, people: (string | null | undefined)[], kind: string, line: any) => {
    calls.rang.push({ org, people: people.filter((p): p is string => !!p), kind, line });
    return { bell: true, pushed: people.filter((p): p is string => !!p) };
  },
}));

/**
 * WHAT THE JOB HAS WORKED THAT NO BILL CLAIMS (M3). The billing step the gate now runs asks
 * unbilledWorkForJob; every test above is on a job with no billing_type, so the step skips before it ever
 * gets here and they are unaffected. The one test that sets `work.rows` is the T&M case.
 */
const work = vi.hoisted(() => ({ rows: null as Record<string, unknown> | null }));
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: async () =>
    work.rows ?? {
      hours: 0, laborAmount: 0, laborByPerson: [], billsAmount: 0, excluded: 0, billsCount: 0, markupPct: 0.11,
      billsBilled: 0, returnsAmount: 0, returnsCount: 0, returnsCredit: 0, stockCount: 0, stockAmount: 0,
      stockBilled: 0, stockShorts: 0, stockShortsWords: null, stockNoCostWords: null, total: 0,
      lastInvoiceNumber: null, lastInvoiceAt: null, lastInvoiceStatus: null, poCoveredBills: 0,
      claimedCount: 0, claimedOn: [], schemaReady: true, rows: [],
    },
  fixedBillingsNotYetNetted: async () => 0,
  claimedSourcesOnJob: async () => ({}),
}));

import { afterPaymentLanded } from "./after-payment-landed";

const ORG = "org-et";
const INV = "inv-80";
const JOB = "job-5659";

/** A $1,000 bill on a started job, with `paid` dollars of payments already on it. */
const books = (paid: number, over: Record<string, unknown> = {}) => ({
  invoices: [{ id: INV, org_id: ORG, job_id: JOB, invoice_kind: "standard", status: "sent", invoice_number: "INV-080", tax_rate: 0, total: 1000, amount_paid: 0, customers: { name: "Rita Moss" }, ...over }],
  invoice_items: [{ invoice_id: INV, line_total: 1000 }],
  payments: paid ? [{ invoice_id: INV, amount: paid }] : [],
  customer_credits: [] as any[],
  jobs: [{ id: JOB, status: "in_progress" }],
});

describe("afterPaymentLanded — the four steps every pay door takes", () => {
  beforeEach(() => {
    calls.revalidated.length = 0;
    calls.pushedToGoogle.length = 0;
    calls.reported.length = 0;
    calls.rang.length = 0;
    calls.staff = ["erik", "office-2", "office-3"];
    work.rows = null;
  });

  /**
   * THE CUSTOMER'S PAY BUTTON LEAVES WORK OFF A BILL, AND THE OFFICE HEARS IT (M3, the money seam).
   *
   * Erik bills part of a time-and-materials job, the customer taps Pay on the emailed link, and until
   * now the job went complete with hours and receipts no bill claimed — drafted nowhere, named nowhere,
   * and invisible to migration 0371's Done, Not Billed pile, which excludes any job that has a live
   * bill. Now the gate's billing step refuses the finish, and THIS is where the refusal becomes a
   * sentence: its own bell line, with its own door (the job, where the bill is made — not the invoice
   * that is already paid), to the whole office including whoever recorded the payment, because typing a
   * payment is not the same as being told your job still has 19.5 hours off every bill.
   */
  it("a T&M job's last bill is paid with 19.5 h on no bill: the job stays open and the office is TOLD, in its own line", async () => {
    work.rows = { hours: 19.5, laborAmount: 2437.5, laborByPerson: [], billsAmount: 400, excluded: 0, billsCount: 2, markupPct: 0.11,
      billsBilled: 473.62, returnsAmount: 0, returnsCount: 0, returnsCredit: 0, stockCount: 0, stockAmount: 0,
      stockBilled: 0, stockShorts: 0, stockShortsWords: null, stockNoCostWords: null, total: 2911.12,
      lastInvoiceNumber: "INV-080", lastInvoiceAt: null, lastInvoiceStatus: "paid", poCoveredBills: 0,
      claimedCount: 0, claimedOn: [], schemaReady: true, rows: [] };
    const db = fakeDb({
      ...books(1000),
      jobs: [{ id: JOB, status: "in_progress", billing_type: "tm", job_number: "J-002", name: "41 Larkspur", customers: { name: "Marla Finch" } }],
    });
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000, said: "paid online" } });

    // The money landed. The job did NOT end, and nothing left Google.
    expect(r.settled).toBe(true);
    expect(db.tables.invoices[0].status).toBe("paid");
    expect(r.job.completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect(calls.pushedToGoogle).toEqual([]);

    // TWO lines, two facts: the payment, then the job. Never one line carrying both.
    expect(calls.rang).toHaveLength(2);
    expect(calls.rang[0].line).toMatchObject({ title: "Payment received", body: "$1,000.00 paid online on INV-080 — Rita Moss", url: `/billing/${INV}` });
    expect(calls.rang[1]).toMatchObject({ org: ORG, kind: "invoice_paid" });
    expect(calls.rang[1].line.title).toBe("Still to bill");
    expect(calls.rang[1].line.body).toContain("19.5 h and 2 bills ($2,911.12)");
    expect(calls.rang[1].line.body).toContain("41 Larkspur · J-002 — Marla Finch");
    expect(calls.rang[1].line.body).toContain("This Is The Last Bill");
    // The door is the JOB: the invoice is paid, so sending a person there is a dead end.
    expect(calls.rang[1].line.url).toBe(`/jobs/${JOB}`);
    // Nobody is left out of this one, not even the person who typed the payment.
    expect(calls.rang[1].people).toEqual(["erik", "office-2", "office-3"]);
    expect(calls.reported).toEqual([]);
  });

  it("a deposit off the bank file pays the last bill: the figures land, the JOB IS FINISHED, the office hears it once, every money screen refreshes", async () => {
    const db = fakeDb(books(1000));
    const r = await afterPaymentLanded(db, {
      invoiceId: INV,
      orgId: ORG,
      bell: { amount: 1000, said: "from the bank file", recordedBy: "erik" },
    });

    // 1. the recalc landed and said paid
    expect(r.settled).toBe(true);
    expect(db.tables.invoices[0]).toMatchObject({ amount_paid: 1000, status: "paid" });
    // 2. the job is done, and it left Google (this is the step the bank download never took)
    expect(r.job).toEqual({ completed: true, jobId: JOB });
    expect(db.tables.jobs[0].status).toBe("complete");
    expect(calls.pushedToGoogle).toEqual([JOB]);
    // 3. one bell line, in this door's words, with the person who tapped Apply left out of it
    expect(calls.rang).toEqual([
      {
        org: ORG,
        people: ["office-2", "office-3"],
        kind: "invoice_paid",
        line: { title: "Payment recorded", body: "$1,000.00 from the bank file on INV-080 — Rita Moss", url: `/billing/${INV}` },
      },
    ]);
    expect(r.rang).toEqual(["office-2", "office-3"]);
    // 4. every screen that shows money (the helper's own refresh, plus the finish's four)
    expect(calls.revalidated).toContain("/billing");
    expect(calls.revalidated).toContain(`/billing/${INV}`);
    expect(calls.revalidated).toContain("/planner");
    expect(calls.revalidated).toContain("/analytics");
    expect(calls.reported).toEqual([]);
  });

  it("a part payment: the figures land, the job stays open in its own words, and the office still hears what came in", async () => {
    const db = fakeDb(books(400));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 400, said: "paid online" } });
    expect(r.settled).toBe(true);
    expect(db.tables.invoices[0]).toMatchObject({ amount_paid: 400, status: "partial" });
    expect(r.job.completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
    // Money that arrived on its own is news, and it is news to the whole office (no recorder).
    expect(calls.rang[0].people).toEqual(["erik", "office-2", "office-3"]);
    expect(calls.rang[0].line).toMatchObject({ title: "Payment received", body: "$400.00 paid online on INV-080 — Rita Moss" });
  });

  it("a REPEAT (the row was already there) settles again and rings NOTHING: one payment, one bell", async () => {
    const db = fakeDb(books(1000));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG });
    expect(r.settled).toBe(true);
    expect(db.tables.invoices[0].status).toBe("paid");
    expect(r.job).toEqual({ completed: true, jobId: JOB });
    expect(calls.rang).toEqual([]);
    expect(r.rang).toEqual([]);
  });

  it("the recalc could not read: NOTHING is finished off a stale balance, and the refusal says why", async () => {
    const db = fakeDb(books(1000), { failing: ["payments"] });
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000, recordedBy: "erik" } });
    expect(r.settled).toBe(false);
    expect(r.job).toEqual({ completed: false, why: "the invoice's figures didn't recompute, so nothing was finished" });
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect(db.log.some((l) => l.table === "jobs" && l.verb === "update")).toBe(false);
    expect(calls.reported).toContain("recalcInvoice:read");
    // The money IS recorded, so the bell line still stands as the record of it.
    expect(calls.rang).toHaveLength(1);
  });

  it("paid twice: the bell says OVERPAID and names the amount over, because only a person can choose credit or refund", async () => {
    const db = fakeDb(books(2000));
    await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000, said: "paid online" } });
    expect(calls.rang[0].line.title).toBe("Overpaid — action needed");
    expect(calls.rang[0].line.body).toBe("$1,000.00 paid online on INV-080 — Rita Moss. That's $1,000.00 MORE than the total. Credit it or refund it.");
  });

  it("a payment with no company on it: nobody is rung and the ops log says so, and the figures still land", async () => {
    const db = fakeDb(books(1000));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: null, bell: { amount: 1000 } });
    expect(r.settled).toBe(true);
    expect(calls.rang).toEqual([]);
    expect(calls.reported).toContain("afterPaymentLanded:bell");
  });

  it("a paid DRAW is a stage of the job, not its end — the gate's rule, reached through this door", async () => {
    const db = fakeDb(books(1000, { invoice_kind: "deposit" }));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000 } });
    expect(r.settled).toBe(true);
    expect(r.job).toEqual({ completed: false, why: "a paid deposit draw is a stage of the job, not its end" });
    expect(db.tables.jobs[0].status).toBe("in_progress");
  });

  it("a bell that blows up never unsaves the payment: the figures and the job still land, and the ops log hears it", async () => {
    const db = fakeDb(books(1000));
    calls.staff = null as unknown as string[]; // orgStaffIds answers with something unusable
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000 } });
    expect(r.settled).toBe(true);
    expect(r.job).toEqual({ completed: true, jobId: JOB });
    expect(calls.reported).toContain("afterPaymentLanded:bell");
  });
});

/**
 * THE TEETH: A FOURTH PAYMENT WRITER CANNOT FORGET THE FOUR STEPS.
 *
 * A shared helper is only a convention while a new door can be written without it. This walks the
 * source for every place that puts a row in `payments` and insists each one calls the helper — so a
 * fourth writer is RED until its author reads this and decides on purpose. (A deliberate bypass
 * tripwire, which is the only thing a source-text check is ever allowed to be: the behaviour itself
 * is pinned above.)
 */
describe("every door that records a payment goes through the one helper", () => {
  /** Source with comments removed, so prose can neither satisfy nor trip an assertion about code. */
  const code = (path: string) =>
    readFileSync(join(process.cwd(), path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");

  const writers = (readdirSync(join(process.cwd(), "src"), { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join("src", f))
    .filter((f) => /from\("payments"\)\s*\.(insert|upsert)\(/.test(code(f)));

  it("finds the writers (so an empty scan can never pass)", () => {
    expect(writers.sort()).toEqual([
      "src/app/(app)/billing/actions.ts", // Record Payment (and Settle Up, which records through it)
      "src/app/(app)/bills/bank-core.ts", // a deposit off the bank file, put on an invoice
      "src/lib/record-invoice-payment.ts", // the card / bank / Tap to Pay writer, webhook and sheet
    ]);
  });

  for (const f of writers) {
    it(`${f} calls afterPaymentLanded`, () => {
      expect(
        code(f),
        `${f} writes a payment row. Everything that follows a payment lives in lib/after-payment-landed (recalc, finish the job, the bell, the refresh) — call afterPaymentLanded instead of writing any of it again here.`,
      ).toMatch(/afterPaymentLanded\(/);
    });
  }

  it("and nothing writes those four steps for itself any more", () => {
    for (const f of writers) {
      const src = code(f);
      expect(src, f).not.toMatch(/completeJobWhenPaid\(/);
      expect(src, f).not.toMatch(/sendPushToProfiles\(/);
    }
  });
});
