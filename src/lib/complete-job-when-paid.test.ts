import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";

/**
 * PAID COMPLETES THE JOB (209451e1, the money half) — the gate, without a database.
 *
 * A standard invoice paid in full on an active job with no other open bill marks the job
 * complete. A paid draw never does; a job already complete or cancelled is left alone; a second
 * open bill on the job keeps it open. The write is checked, and the touches a finish makes (the
 * calendar push, the revalidates) run only after a row moved.
 */
const calls = vi.hoisted(() => ({ pushed: [] as string[], revalidated: [] as string[], reported: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => calls.revalidated.push(p) }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: async (_k: string, id: string) => void calls.pushed.push(id) }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void calls.reported.push(where) }));

import { completeJobWhenPaid } from "./complete-job-when-paid";

const JOB = "job-5659";
const paidStandard = (over: Record<string, unknown> = {}) => ({ id: "inv-1", job_id: JOB, invoice_kind: "standard", status: "paid", ...over });

describe("completeJobWhenPaid — the gate", () => {
  beforeEach(() => {
    calls.pushed.length = 0;
    calls.revalidated.length = 0;
    calls.reported.length = 0;
  });

  it("an active job, a standard invoice, fully paid: the job is complete, Google and the pages hear it", async () => {
    const db = fakeDb({ invoices: [paidStandard()], jobs: [{ id: JOB, status: "in_progress" }] });
    const r = await completeJobWhenPaid(db, "inv-1");
    expect(r).toEqual({ completed: true, jobId: JOB });
    expect(db.tables.jobs[0].status).toBe("complete");
    // The write was checked (.select("id") on the update, filtered to the live statuses).
    const write = db.log.find((l) => l.table === "jobs" && l.verb === "update");
    expect(write?.filters).toEqual(["eq:id", "in:status"]);
    expect(calls.pushed).toEqual([JOB]);
    expect(calls.revalidated).toEqual([`/jobs/${JOB}`, "/jobs", "/planner", "/billing"]);
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
      jobs: [{ id: JOB, status: "to_be_scheduled" }],
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
