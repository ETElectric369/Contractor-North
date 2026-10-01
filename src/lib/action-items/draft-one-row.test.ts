import { describe, it, expect, vi } from "vitest";

/**
 * ONE FACT, ONE ROW: A FINISHED JOB WHOSE BILL IS A DRAFT (Wave 1 seam fix). Finish Job on J-011
 * completes the job and drafts INV-081. The draft feeder shows the draft ("Draft invoice INV-081",
 * or "Herringbone · J-011 Finished · Send INV-081" when it had been set aside), and the done-jobs
 * feeder skipped only jobs with a SENT bill, so the same job's one bill was a second row, "Herringbone
 * · J-011" under Done, Not Billed: two rows, two piles, 2 on the badge. The draft's row is the one.
 */

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const ahead = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);

const state = vi.hoisted(() => ({ drafts: [] as any[], doneJobs: [] as any[], before0371: false }));

/**
 * Every read answers empty, except the draft read and the done jobs, told apart by their select. The
 * done jobs come from needs_you_done_not_billed (0371) as its rows (a finished job with no real
 * invoice; the function asks that in SQL), or, before 0371 (the function missing), from the old
 * done-jobs read, filtered in code as it always was.
 */
function fakeClient() {
  const answer = (table: string, cols: string) => {
    if (table === "invoices" && cols.startsWith("id, invoice_number, total, amount_paid, status, created_at, hold_until")) return state.drafts;
    if (table === "jobs" && cols.startsWith("id, job_number, name, status, updated_at, customers(name)")) return state.doneJobs;
    if (table === "profiles") return { org_id: "org-1", role: "owner" };
    return [];
  };
  const chain = (table: string) => {
    let cols = "";
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const data = answer(table, cols);
            const rows = Array.isArray(data) ? data : [];
            return (ok: any, err: any) => Promise.resolve({ data: Array.isArray(data) ? rows : data, error: null, count: rows.length }).then(ok, err);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const data = answer(table, cols);
              return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
            };
          }
          if (prop === "select") {
            return (c?: string) => {
              cols = c ?? "";
              return q;
            };
          }
          return () => q;
        },
      },
    );
    return q;
  };
  const doneRows = () =>
    state.doneJobs.map((j) => ({
      src: "job",
      id: j.id,
      job_id: j.id,
      title: null,
      job_number: j.job_number,
      job_name: j.name,
      customer_name: j.customers?.name ?? null,
      at: j.updated_at,
      open_invoice_id: null,
      total_count: state.doneJobs.length,
    }));
  return {
    from: (table: string) => chain(table),
    rpc: (fn: string) => {
      if (fn !== "needs_you_done_not_billed") return chain("rpc");
      return Promise.resolve(
        state.before0371
          ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.needs_you_done_not_billed" } }
          : { data: doneRows(), error: null },
      );
    },
    auth: { getUser: async () => ({ data: { user: { id: "owner-1" } }, error: null }) },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { getActionItems } from "./query";

const J011 = { id: "job-11", job_number: "J-011", name: "Herringbone", status: "complete", updated_at: `${TODAY}T16:00:00Z`, customers: { name: "Andrew Cohen" } };
const draft = (over: Record<string, unknown> = {}) => ({
  id: "inv-81",
  invoice_number: "INV-081",
  total: 1200,
  amount_paid: 0,
  status: "draft",
  created_at: `${TODAY}T16:00:00Z`,
  hold_until: null,
  hold_reason: null,
  job_id: "job-11",
  customers: { name: "Andrew Cohen" },
  jobs: { job_number: "J-011", name: "Herringbone", status: "complete" },
  ...over,
});

const build = () => getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
const rowsFor = (r: any) => (r.now ?? []).flatMap((i: any) => i.children ?? [i]).filter((i: any) => i.id === "inv-81" || i.id === "jdone-job-11");

for (const [path, before0371] of [
  ["read whole (0371)", false],
  ["before 0371 (the two old reads)", true],
] as const) {
  describe(`a finished job whose bill is a draft is one row: ${path}`, () => {
    it("the draft's row, not a second Done, Not Billed row", async () => {
      state.before0371 = before0371;
      state.doneJobs = [J011];
      state.drafts = [draft()];
      const rows = rowsFor(await build());
      expect(rows.map((i: any) => i.id)).toEqual(["inv-81"]);
      expect(rows[0].title).toBe("Draft invoice INV-081 · $1,200.00");
    });

    it("set aside before the job finished: one row, Finished · Send", async () => {
      state.before0371 = before0371;
      state.doneJobs = [J011];
      state.drafts = [draft({ hold_until: ahead, hold_reason: "Waiting on the walk-through" })];
      const rows = rowsFor(await build());
      expect(rows.map((i: any) => i.id)).toEqual(["inv-81"]);
      expect(rows[0].title).toBe("Herringbone · J-011 Finished · Send INV-081");
    });

    it("a finished job with no bill at all still says Done, Not Billed", async () => {
      state.before0371 = before0371;
      state.doneJobs = [J011];
      state.drafts = [];
      const rows = rowsFor(await build());
      expect(rows.map((i: any) => i.id)).toEqual(["jdone-job-11"]);
      expect(rows[0].title).toBe("Herringbone · J-011");
      expect(rows[0].subtitle).toBe("Andrew Cohen");
    });
  });
}
