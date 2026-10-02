import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

/**
 * PAID COMPLETES THE JOB (209451e1, the money half) — the gate, without a database.
 *
 * A standard invoice paid in full on a job that has STARTED (in progress / on hold) with no other
 * open bill marks the job complete. A paid draw never does; a job that hasn't started (to be
 * scheduled, scheduled) stays on the schedule however its bill was paid; a job already complete
 * or cancelled is left alone; a second open bill on the job keeps it open. The write is checked,
 * and the touches a finish makes (the calendar push, the revalidates) run only after a row moved.
 */
const calls = vi.hoisted(() => ({ pushed: [] as string[], revalidated: [] as string[], reported: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => calls.revalidated.push(p) }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: async (_k: string, id: string) => void calls.pushed.push(id) }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void calls.reported.push(where) }));

/**
 * THE BILLING STEP'S READS, FAKED (M3). lib/finish-bills-first asks unbilledWorkForJob what the job has
 * worked that no bill claims; everything else it needs (the job's billing_type, its payment schedule, its
 * draws, its open draft) comes off the fake database below, so the gate's own rule 4 is exercised, not
 * stubbed. `unbilled` is what the module under test would read from a real one.
 */
const work = vi.hoisted(() => ({ rows: null as Record<string, unknown> | null, throws: false, lump: 0 }));
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: async () => {
    if (work.throws) throw new Error("statement timeout");
    return work.rows ?? nothingUnbilled();
  },
  fixedBillingsNotYetNetted: async () => work.lump,
  claimedSourcesOnJob: async () => ({}),
}));

function nothingUnbilled(over: Record<string, unknown> = {}) {
  return {
    hours: 0, laborAmount: 0, laborByPerson: [], billsAmount: 0, excluded: 0, billsCount: 0, markupPct: 0.11,
    billsBilled: 0, returnsAmount: 0, returnsCount: 0, returnsCredit: 0, stockCount: 0, stockAmount: 0,
    stockBilled: 0, stockShorts: 0, stockShortsWords: null, stockNoCostWords: null, total: 0,
    lastInvoiceNumber: null, lastInvoiceAt: null, lastInvoiceStatus: null, poCoveredBills: 0,
    claimedCount: 0, claimedOn: [], schemaReady: true, rows: [],
    ...over,
  };
}

import { completeJobWhenPaid } from "./complete-job-when-paid";

const JOB = "job-5659";
const paidStandard = (over: Record<string, unknown> = {}) => ({ id: "inv-1", job_id: JOB, invoice_kind: "standard", status: "paid", ...over });

describe("completeJobWhenPaid — the gate", () => {
  beforeEach(() => {
    calls.pushed.length = 0;
    calls.revalidated.length = 0;
    calls.reported.length = 0;
    work.rows = null;
    work.throws = false;
    work.lump = 0;
  });

  it("a started job, a standard invoice, fully paid: the job is complete, Google and the pages hear it", async () => {
    const db = fakeDb({ invoices: [paidStandard()], jobs: [{ id: JOB, status: "in_progress" }] });
    const r = await completeJobWhenPaid(db, "inv-1");
    expect(r).toEqual({ completed: true, jobId: JOB });
    expect(db.tables.jobs[0].status).toBe("complete");
    // The write was checked (.select("id") on the update, filtered to the started statuses).
    const write = db.log.find((l) => l.table === "jobs" && l.verb === "update");
    expect(write?.filters).toEqual(["eq:id", "in:status"]);
    expect(calls.pushed).toEqual([JOB]);
    expect(calls.revalidated).toEqual([`/jobs/${JOB}`, "/jobs", "/planner", "/billing"]);
    // Paused after starting counts as started too.
    const held = fakeDb({ invoices: [paidStandard()], jobs: [{ id: JOB, status: "on_hold" }] });
    expect((await completeJobWhenPaid(held, "inv-1")).completed).toBe(true);
    expect(held.tables.jobs[0].status).toBe("complete");
  });

  /**
   * THE HOLD DIES WITH THE JOB, THROUGH THIS DOOR TOO (the M1/M2 seam, fixed at the merge).
   *
   * M2 made Finish Job clear the hold reason (0234) and its comment said finishJob was now the only
   * door a held job could be finished through. It was not: this gate finishes a job on hold as well,
   * and M1 had just wired it to EVERY door that lands a payment — Record Payment, Settle Up, the
   * Stripe writer, and a deposit matched out of the bank file, which before M1 could not end a job at
   * all. So a job held on "waiting on the permit", paid off, went complete still carrying it: a
   * sentence Needs You reads out when the job comes back, about a job that is done. The whole patch
   * is lib/job-status's finishedJobFields now, written here and at finishJob, instead of resting on
   * migration 0366's trigger being applied.
   */
  it("a HELD job paid off comes out complete with its hold reason gone, not left for the database to tidy", async () => {
    const db = fakeDb({
      invoices: [paidStandard()],
      jobs: [{ id: JOB, status: "on_hold", hold_reason: "waiting on the permit" }],
    });
    expect((await completeJobWhenPaid(db, "inv-1")).completed).toBe(true);
    expect(db.tables.jobs[0].status).toBe("complete");
    expect(db.tables.jobs[0].hold_reason).toBeNull();
  });

  it("a job that hasn't started — booked for next Tuesday, its one standard bill paid by the link Monday night — stays on the schedule", async () => {
    for (const status of ["to_be_scheduled", "scheduled"]) {
      const db = fakeDb({ invoices: [paidStandard()], jobs: [{ id: JOB, status }] });
      const r = await completeJobWhenPaid(db, "inv-1");
      expect(r).toEqual({ completed: false, why: `the job hasn't started (it is ${status.replace(/_/g, " ")}) — a bill paid ahead of the visit doesn't end it` });
      expect(db.tables.jobs[0].status).toBe(status);
      expect(db.log.some((l) => l.table === "jobs" && l.verb === "update")).toBe(false);
    }
    // Nothing left Google, nothing was revalidated: the job is still Tuesday's.
    expect(calls.pushed).toEqual([]);
    expect(calls.revalidated).toEqual([]);
  });

  it("a paid DRAW (deposit / progress / final) is a stage of the job, not its end: no status write", async () => {
    for (const kind of ["deposit", "progress", "final"]) {
      const db = fakeDb({ invoices: [paidStandard({ invoice_kind: kind })], jobs: [{ id: JOB, status: "scheduled" }] });
      const r = await completeJobWhenPaid(db, "inv-1");
      expect(r.completed).toBe(false);
      expect((r as { why: string }).why).toContain(`${kind} draw`);
      expect(db.tables.jobs[0].status).toBe("scheduled");
      expect(db.log.some((l) => l.table === "jobs" && l.verb === "update")).toBe(false);
    }
    expect(calls.pushed).toEqual([]);
  });

  it("an invoice that is not paid (partial after a recalc) writes nothing", async () => {
    const db = fakeDb({ invoices: [paidStandard({ status: "partial" })], jobs: [{ id: JOB, status: "in_progress" }] });
    expect((await completeJobWhenPaid(db, "inv-1")).completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
  });

  it("a job that is already complete or cancelled is left exactly as it is", async () => {
    for (const status of ["complete", "cancelled"]) {
      const db = fakeDb({ invoices: [paidStandard()], jobs: [{ id: JOB, status }] });
      const r = await completeJobWhenPaid(db, "inv-1");
      expect(r).toEqual({ completed: false, why: `the job is already ${status}` });
      expect(db.tables.jobs[0].status).toBe(status);
    }
  });

  it("another open bill on the job (a draft still being built, a sent bill still owed) keeps the job open; void and paid don't count", async () => {
    const open = fakeDb({
      invoices: [paidStandard(), { id: "inv-2", job_id: JOB, invoice_kind: "standard", status: "sent" }],
      jobs: [{ id: JOB, status: "in_progress" }],
    });
    expect(await completeJobWhenPaid(open, "inv-1")).toEqual({ completed: false, why: "the job has 1 other open bill" });
    expect(open.tables.jobs[0].status).toBe("in_progress");

    const settled = fakeDb({
      invoices: [
        paidStandard(),
        { id: "inv-2", job_id: JOB, invoice_kind: "standard", status: "void" },
        { id: "inv-3", job_id: JOB, invoice_kind: "deposit", status: "paid" },
      ],
      jobs: [{ id: JOB, status: "in_progress" }],
    });
    expect((await completeJobWhenPaid(settled, "inv-1")).completed).toBe(true);
    expect(settled.tables.jobs[0].status).toBe("complete");
  });

  it("an invoice with no job, or a job that isn't there, writes nothing and says why", async () => {
    const noJob = fakeDb({ invoices: [paidStandard({ job_id: null })], jobs: [] });
    expect(await completeJobWhenPaid(noJob, "inv-1")).toEqual({ completed: false, why: "the invoice isn't on a job" });
    const gone = fakeDb({ invoices: [paidStandard()], jobs: [] });
    expect(await completeJobWhenPaid(gone, "inv-1")).toEqual({ completed: false, why: "job not found" });
    expect(calls.pushed).toEqual([]);
  });

  it("a database that fails mid-read is reported, never thrown at the money", async () => {
    const db = fakeDb({ invoices: [paidStandard()], jobs: [{ id: JOB, status: "in_progress" }] }, { failing: ["jobs"] });
    const r = await completeJobWhenPaid(db, "inv-1");
    expect(r.completed).toBe(false);
    expect(calls.reported).toEqual(["completeJobWhenPaid:read-job"]);
  });
});

/**
 * RULE 4: THE BILLING STEP, AT THIS DOOR TOO (M3, the money seam).
 *
 * WHAT WENT WRONG. cn-v1039 shipped lib/job-status saying a finishing status "may only be written by
 * finishing it (which bills first)" — and shipped this gate, wired by M1 to EVERY payment door (Stripe,
 * Tap to Pay, Record Payment, a deposit matched out of the bank file), writing the finish without ever
 * asking what the job had worked. So Erik bills part of a time-and-materials job, the customer taps Pay
 * on the emailed link, the job goes complete, and hours and receipts no bill claims are drafted nowhere
 * and named nowhere. Nor was there a net: migration 0371's Done, Not Billed pile excludes any job that
 * has a live bill, so a job with a PAID one can never land in it. That is the Tao J-002 failure (19.5 h
 * off every bill) reached from the customer's own Pay button.
 *
 * WHAT IT DOES NOW. It runs the same billing step Finish Job runs (lib/finish-bills-first) and acts on
 * the answer. It cannot BUILD the draft — the invoice builders are "use server" actions behind
 * requireStaff and the Stripe webhook has no staff session — and it must not, because a draft it built
 * would itself be the "other open bill" rule 3 refuses. So on a T&M job with work no bill claims it does
 * not finish the job, and it hands back the sentence a person reads.
 *
 * ON A FIXED-PRICE JOB NOTHING CHANGES. The price is the price, so hours there are not billed
 * separately: the step skips, the job finishes exactly as it did, and the two complete fixed jobs that
 * carry unclaimed hours today (6.7 h and 3.5 h) do not start appearing anywhere.
 */
describe("a paid bill never ends a job with its work off every bill", () => {
  beforeEach(() => {
    calls.pushed.length = 0;
    calls.revalidated.length = 0;
    calls.reported.length = 0;
    work.rows = null;
    work.throws = false;
    work.lump = 0;
  });

  /** Tao's shape: 19.5 h and 2 receipts that no invoice line claims, $2,911.12 of work. */
  const taoShape = () =>
    nothingUnbilled({ hours: 19.5, laborAmount: 2437.5, billsCount: 2, billsAmount: 400, billsBilled: 473.62, total: 2911.12 });

  const tmJob = (over: Record<string, unknown> = {}) => ({
    id: JOB,
    status: "in_progress",
    billing_type: "tm",
    job_number: "J-002",
    name: "41 Larkspur",
    customers: { name: "Marla Finch" },
    ...over,
  });

  it("THE DEFECT: a T&M job whose last bill the customer paid is NOT finished while 19.5 h and 2 receipts are on no bill", async () => {
    work.rows = taoShape();
    const db = fakeDb({ invoices: [paidStandard()], jobs: [tmJob()] });
    const r = await completeJobWhenPaid(db, "inv-1");

    expect(r.completed).toBe(false);
    // The job is exactly as the tech left it — nothing was written, nothing left Google, no page moved.
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect(db.log.some((l) => l.table === "jobs" && l.verb === "update")).toBe(false);
    expect(calls.pushed).toEqual([]);
    expect(calls.revalidated).toEqual([]);

    // NOTHING SILENT: the sentence names the hours, the receipts, the money, the job the way Erik reads
    // it (never a bare number), and the one door that bills it.
    const say = (r as { say?: string }).say ?? "";
    expect(say).toContain("19.5 h and 2 bills ($2,911.12)");
    expect(say).toContain("41 Larkspur");
    expect(say).toContain("J-002");
    expect(say).toContain("Marla Finch");
    expect(say).toContain("NOT finished yet");
    expect(say).toContain("This Is The Last Bill");
  });

  it("every hour and receipt already on a bill: the paid bill finishes the T&M job, and says nothing extra", async () => {
    work.rows = nothingUnbilled({ claimedCount: 7, claimedOn: ["INV-00028"] });
    const db = fakeDb({ invoices: [paidStandard()], jobs: [tmJob()] });
    const r = await completeJobWhenPaid(db, "inv-1");
    expect(r).toEqual({ completed: true, jobId: JOB });
    expect(db.tables.jobs[0].status).toBe("complete");
    expect(calls.pushed).toEqual([JOB]);
  });

  /**
   * THE FIXED-PRICE CASE MUST NOT MOVE. On a fixed job the extension IS the price, so unclaimed hours
   * are normal, not lost money — J-054 (6.7 h) and J-006 (3.5 h) are exactly this and are already
   * complete. Billing type absent reads the same way: only "tm" bills its actuals.
   */
  it("a FIXED-price job with unclaimed hours still finishes on its paid bill, with nothing new said", async () => {
    for (const billing_type of ["fixed", null, undefined]) {
      work.rows = taoShape();
      const db = fakeDb({ invoices: [paidStandard()], jobs: [tmJob({ billing_type })] });
      const r = await completeJobWhenPaid(db, "inv-1");
      expect(r, String(billing_type)).toEqual({ completed: true, jobId: JOB });
      expect(db.tables.jobs[0].status).toBe("complete");
      expect((r as { say?: string }).say).toBeUndefined();
    }
  });

  it("a T&M job on a payment schedule is billed by its milestones, so the step skips and it finishes", async () => {
    work.rows = taoShape();
    const db = fakeDb({
      invoices: [paidStandard()],
      jobs: [tmJob()],
      payment_milestones: [{ id: "m1", job_id: JOB }],
    });
    expect((await completeJobWhenPaid(db, "inv-1")).completed).toBe(true);
    expect(db.tables.jobs[0].status).toBe("complete");
  });

  /**
   * A DEPOSIT THAT COVERS THE WORK IS THE ONE CASE THAT FINISHES *AND* SPEAKS. No bill will ever be
   * built for it (the draw door refuses one whose net is $0) and the job is ending, so the figures are
   * said here or nowhere — money to settle with the customer, exactly as Finish Job says it.
   */
  it("a deposit not yet taken off a bill that covers the work: the job finishes, and the figures are said", async () => {
    work.rows = nothingUnbilled({ hours: 4, laborAmount: 500, total: 500 });
    work.lump = 5000;
    const db = fakeDb({
      invoices: [paidStandard(), { id: "inv-dep", job_id: JOB, invoice_kind: "deposit", status: "paid" }],
      jobs: [tmJob()],
    });
    const r = await completeJobWhenPaid(db, "inv-1");
    expect(r.completed).toBe(true);
    expect(db.tables.jobs[0].status).toBe("complete");
    const say = (r as { say?: string }).say ?? "";
    expect(say).toContain("41 Larkspur");
    expect(say).toContain("$5,000.00");
    expect(say).toContain("$500.00");
    expect(say).toContain("settle the difference with the customer");
  });

  /**
   * A READ THAT FAILED IS NOT "NOTHING TO BILL". It is the error the whole class of bug lives in, so the
   * job is left exactly as it was and the person is told. A tile that reads "in progress" for one more
   * press is recoverable; 19.5 unbilled hours are not.
   */
  it("the hours couldn't be read: the job is NOT finished, and that is said rather than assumed away", async () => {
    work.throws = true;
    const db = fakeDb({ invoices: [paidStandard()], jobs: [tmJob()] });
    const r = await completeJobWhenPaid(db, "inv-1");
    expect(r.completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect((r as { say?: string }).say).toContain("41 Larkspur");
    expect((r as { say?: string }).say).toContain("wasn't finished");
    expect(calls.reported).toContain("finishBillingStep.read");
  });

  it("the paid invoice is still the ONLY gate on the other rules — a draw, an unstarted job, a second open bill still refuse before the step runs", async () => {
    work.rows = taoShape();
    // A job that hasn't started: refused on rule 2, so the billing step is never even asked.
    const early = fakeDb({ invoices: [paidStandard()], jobs: [tmJob({ status: "scheduled" })] });
    expect((await completeJobWhenPaid(early, "inv-1")).completed).toBe(false);
    expect(early.log.some((l) => l.table === "payment_milestones")).toBe(false);
  });
});
