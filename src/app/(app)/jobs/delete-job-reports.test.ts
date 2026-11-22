import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A DAILY REPORT STAYS WITH ITS JOB (0411; skeptic, cn-v1174). daily_reports.job_id is a plain
 * reference with no on-delete action: nulling a deleted job's reports would collide with the same
 * person's no-job report that day under the key that counts no job as one value. So deleteJob refuses
 * first, in one sentence naming one action, and a database without 0411's column reads as none.
 * Unscripted tables throw, so every read is counted.
 */
const state = vi.hoisted(() => ({ client: null as any, reportError: vi.fn() }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-a", orgId: "org-a" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: state.reportError }));

import { deleteJob } from "./actions";

const JOB = "22222222-2222-4222-8222-222222222900";
const COUNTED = ["contracts", "insurance_claims", "payment_milestones", "documents", "permits", "change_orders"];

function fake(reports: { count?: number; error?: unknown }, requests: { count?: number; error?: unknown } = {}, lang: string | null = null) {
  const deletes: string[] = [];
  const client = {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        limit: () => chain,
        delete: () => {
          deletes.push(table);
          return chain;
        },
        maybeSingle: async () =>
          table === "jobs" ? { data: { id: JOB, inquiry_id: null }, error: null } : table === "profiles" ? { data: { language: lang }, error: null } : { data: null, error: null },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          let v: unknown;
          if (table === "daily_reports") v = { count: reports.count ?? null, error: reports.error ?? null };
          // The job's payment requests (cn-v1177), counted by kind.
          else if (table === "invoices") v = { count: requests.count ?? 0, error: requests.error ?? null };
          else if (table === "profiles") v = { data: { language: lang }, error: null };
          else if (COUNTED.includes(table)) v = { count: 0, error: null };
          else if (table === "jobs" && deletes.includes("jobs")) v = { error: null };
          else return Promise.reject(new Error(`unscripted table: ${table}`)).then(res, rej);
          return Promise.resolve(v).then(res, rej);
        },
      };
      if (table === "lien_records" || table === "jobs" || table === "daily_reports" || table === "invoices" || table === "profiles" || COUNTED.includes(table)) return chain;
      throw new Error(`unscripted table: ${table}`);
    },
  };
  return { client, deletes };
}

describe("deleteJob: a job with daily reports filed on it is not deleted", () => {
  beforeEach(() => state.reportError.mockClear());

  it("refuses with reports, in one sentence naming one action, and deletes nothing", async () => {
    const f = fake({ count: 2 });
    state.client = f.client;
    const r = await deleteJob(JOB, { confirmDestructive: true });
    expect(r).toEqual({ ok: false, error: "This job has 2 daily reports filed on it, and a report stays with its job, so set the job to Cancelled instead of deleting it." });
    expect(r.error!.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length).toBe(1);
    expect(f.deletes).toEqual([]);
  });

  it("is not refused with none", async () => {
    const f = fake({ count: 0 });
    state.client = f.client;
    const r = await deleteJob(JOB, { confirmDestructive: true });
    expect(r).toEqual({ ok: true });
    expect(f.deletes).toEqual(["jobs"]);
  });

  it("a database without 0411's column reads as none: no refusal, no throw, nothing reported", async () => {
    const f = fake({ error: { code: "42703", message: 'column daily_reports.job_id does not exist' } });
    state.client = f.client;
    const r = await deleteJob(JOB, { confirmDestructive: true });
    expect(r).toEqual({ ok: true });
    expect(f.deletes).toEqual(["jobs"]);
    expect(state.reportError).not.toHaveBeenCalled();
  });

  it("any other failed read is said, and nothing is deleted", async () => {
    const f = fake({ error: { code: "57014", message: "canceling statement due to statement timeout" } });
    state.client = f.client;
    const r = await deleteJob(JOB, { confirmDestructive: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Couldn't check this job's daily reports just now, so nothing was deleted. Try again.");
    expect(f.deletes).toEqual([]);
  });
});

describe("deleteJob: a job with payment requests is not deleted (cn-v1177, skeptic #80)", () => {
  beforeEach(() => state.reportError.mockClear());

  it("refuses in one sentence naming one action (Cancelled), before any delete, in English", async () => {
    const f = fake({ count: 0 }, { count: 1 });
    state.client = f.client;
    const r = await deleteJob(JOB, { confirmDestructive: true });
    expect(r).toEqual({ ok: false, error: "This job has payment requests on it, and a bill on the books stays with its job, so set the job to Cancelled instead of deleting it." });
    expect(r.error!.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length).toBe(1);
    expect(f.deletes).toEqual([]);
  });

  it("and in Spanish", async () => {
    const f = fake({ count: 0 }, { count: 2 }, "es");
    state.client = f.client;
    const r = await deleteJob(JOB, { confirmDestructive: true });
    expect(r.error).toBe("Este trabajo tiene solicitudes de pago, y una factura registrada se queda con su trabajo, así que cambia el trabajo a Cancelado en lugar de borrarlo.");
    expect(f.deletes).toEqual([]);
  });

  it("a failed count is never none: said, and nothing is deleted", async () => {
    const f = fake({ count: 0 }, { error: { code: "57014", message: "timeout" } });
    state.client = f.client;
    const r = await deleteJob(JOB, { confirmDestructive: true });
    expect(r).toEqual({ ok: false, error: "Couldn't check this job's payment requests just now, so nothing was deleted. Try again." });
    expect(f.deletes).toEqual([]);
  });
});
