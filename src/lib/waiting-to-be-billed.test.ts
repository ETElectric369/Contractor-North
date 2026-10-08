import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WAITING TO BE BILLED (2026-10-07): the T&M jobs holding work no invoice claims, oldest first, each
 * answered by THE ONE FUNCTION (unbilledWorkForJob) and never by a claim read of this module's own.
 * Made-up jobs and figures.
 */

const work = vi.hoisted(() => ({ byJob: {} as Record<string, any> }));
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: vi.fn(async (_sb: unknown, jobId: string) => {
    const w = work.byJob[jobId];
    if (w instanceof Error) throw w;
    return w;
  }),
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { rankWaiting, readWaitingToBeBilled, WAITING_JOBS } from "./waiting-to-be-billed";

const job = (id: string, over: Record<string, unknown> = {}) => ({ id, job_number: `J-${id}`, name: `${id} Larkspur`, status: "in_progress", billing_type: "tm", customers: { name: "Pat Lee" }, ...over });
const done = (over: Record<string, unknown> = {}) => ({ schemaReady: true, hours: 0, billsCount: 0, stockCount: 0, billsBilled: 0, stockBilled: 0, total: 0, oldestAt: null, ...over });

function fakeDb(tables: Record<string, unknown[]>, fail: Record<string, string> = {}) {
  const asked: string[] = [];
  return {
    asked,
    from(table: string) {
      asked.push(table);
      const rows = tables[table] ?? [];
      const c: any = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) c[m] = () => c;
      c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve(fail[table] ? { data: null, error: { message: fail[table] } } : { data: rows, error: null }).then(ok, err);
      return c;
    },
  };
}

describe("Waiting To Be Billed", () => {
  it("lists the T&M jobs with open work, oldest work first, a complete job with an invoice among them; a job with nothing open is not on it", async () => {
    work.byJob = {
      a: done({ hours: 3.5, oldestAt: "2026-09-20T15:00:00Z", billsBilled: 120, total: 500 }),
      // Finished, already invoiced once, and two more weeks of hours: the J-013 hole.
      b: done({ hours: 12, billsCount: 1, oldestAt: "2026-09-02", billsBilled: 80, total: 1400 }),
      c: done(), // all claimed
      d: done({ stockCount: 1, stockBilled: 40, total: 40, oldestAt: "2026-09-25T10:00:00Z" }),
    };
    const db = fakeDb({ jobs: [job("a"), job("b", { status: "complete" }), job("c"), job("d")], payment_milestones: [] });
    const res = await readWaitingToBeBilled(db as any);
    expect(res.problem).toBeNull();
    expect(res.more).toBe(0);
    expect(res.rows.map((r) => [r.jobId, r.oldestAt, r.total, r.status])).toEqual([
      ["b", "2026-09-02", 1400, "complete"],
      ["a", "2026-09-20T15:00:00Z", 500, "in_progress"],
      ["d", "2026-09-25T10:00:00Z", 40, "in_progress"],
    ]);
    // Place, number AND who - never a bare number (Erik).
    expect(res.rows[0].label).toBe("b Larkspur · J-b — Pat Lee");
  });

  it("a job on a payment schedule bills by its milestones and is never here", async () => {
    work.byJob = { a: done({ hours: 2, total: 200, oldestAt: "2026-09-01" }), m: done({ hours: 9, total: 900, oldestAt: "2026-08-01" }) };
    const db = fakeDb({ jobs: [job("a"), job("m")], payment_milestones: [{ job_id: "m" }] });
    const res = await readWaitingToBeBilled(db as any);
    expect(res.rows.map((r) => r.jobId)).toEqual(["a"]);
  });

  it("one job whose work can't be read is listed as unread, never as $0, and the rest still list", async () => {
    work.byJob = { a: done({ hours: 2, total: 200, oldestAt: "2026-09-01" }), x: new Error("TEST: the receipts read failed") };
    const db = fakeDb({ jobs: [job("a"), job("x")], payment_milestones: [] });
    const res = await readWaitingToBeBilled(db as any);
    expect(res.rows.map((r) => [r.jobId, r.unread ?? false])).toEqual([
      ["a", false],
      ["x", true],
    ]);
    expect(res.rows[1].total).toBe(0);
  });

  it("before the claims schema nothing can say what is unclaimed: such a job is left off, as its card is", async () => {
    work.byJob = { a: done({ schemaReady: false, hours: 2, total: 200 }) };
    const res = await readWaitingToBeBilled(fakeDb({ jobs: [job("a")], payment_milestones: [] }) as any);
    expect(res.rows).toEqual([]);
  });

  it("a lost jobs read is a problem said, not an empty list", async () => {
    const res = await readWaitingToBeBilled(fakeDb({ jobs: [job("a")] }, { jobs: "TEST: refused" }) as any);
    expect(res.rows).toEqual([]);
    expect(res.problem).toMatch(/couldn't be read/);
  });

  it("past the cap the rest are counted, never cut quietly", async () => {
    work.byJob = {};
    const jobs = Array.from({ length: WAITING_JOBS + 1 }, (_, i) => job(`j${i}`));
    for (const j of jobs) work.byJob[j.id] = done();
    const res = await readWaitingToBeBilled(fakeDb({ jobs, payment_milestones: [] }) as any);
    expect(res.more).toBe(1);
  });

  it("ranks by the day of the oldest work: an ISO time and a bare day order together; no date last; unread after those", () => {
    const row = (jobId: string, oldestAt: string | null, unread = false) => ({ jobId, label: jobId, status: "in_progress", oldestAt, hours: 1, billsBilled: 0, stockBilled: 0, total: 1, unread });
    expect(rankWaiting([row("none", null), row("late", "2026-09-20"), row("early", "2026-09-02T18:00:00Z"), row("lost", null, true)]).map((r) => r.jobId)).toEqual(["early", "late", "none", "lost"]);
  });

  /**
   * THE CLAIM RULE CANNOT BE FORKED HERE (two-doors-one-thing): this module asks the one function and
   * reads no invoice_items of its own.
   */
  it("imports unbilledWorkForJob and reads no claims itself", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/waiting-to-be-billed.ts"), "utf8");
    expect(src).toContain('import { unbilledWorkForJob } from "@/lib/unbilled-work"');
    expect(src).not.toContain("source_ids");
    expect(src).not.toContain("invoice_items");
    expect(src).toContain("jobBillsItsActuals(");
  });
});
