import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A CATEGORY EDIT ON A BILL WITH NO JOB LANDS IN A BUCKET, even when the edit leaves job_id out.
 *
 * Nort's bill.update can send a category alone. updateBill used to store it as typed unless the
 * same patch also said the bill has no job, so a "gas" typed on a no-job bill stayed "gas": the
 * Owner's Draw card counted it as Fuel through bucketOf, and the Fuel card, which asked for
 * "Fuel", never saw it. The stored job now decides when the patch doesn't.
 */

const state = vi.hoisted(() => ({
  client: null as any,
  stored: null as { job_id: string | null; amount: number } | null,
  wrote: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/stock-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stock-ledger")>()),
  restampLotsForBill: vi.fn(async () => ({ ok: true, restamped: 0, unshelved: 0 })),
}));

const { updateBill } = await import("./actions");

function client() {
  return {
    from(table: string) {
      let payload: Record<string, unknown> | null = null;
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        // The claim read (a patch that moves the bill's job): nothing bills this one.
        neq: () => chain,
        contains: () => chain,
        limit: () => chain,
        then: (res: any) => Promise.resolve({ data: [], error: null }).then(res),
        update: (p: Record<string, unknown>) => ((payload = p), chain),
        maybeSingle: async () => {
          if (table !== "bills") return { data: null, error: null };
          if (payload) {
            state.wrote.push(payload);
            return { data: { job_id: "job_id" in payload ? payload.job_id : (state.stored?.job_id ?? null) }, error: null };
          }
          return { data: state.stored, error: null };
        },
      };
      return chain;
    },
  };
}

beforeEach(() => {
  state.client = client();
  state.wrote = [];
});

describe("updateBill: a no-job bill's category is a bucket", () => {
  it("a category sent alone on a stored no-job bill is put in its bucket", async () => {
    state.stored = { job_id: null, amount: 50 };
    expect(await updateBill("bill-1", { category: "gas" })).toEqual({ ok: true });
    expect(state.wrote).toEqual([{ category: "Fuel" }]);
  });

  it("a category sent alone on a job's bill is stored as sent", async () => {
    state.stored = { job_id: "job-1", amount: 50 };
    expect(await updateBill("bill-1", { category: "Materials" })).toEqual({ ok: true });
    expect(state.wrote).toEqual([{ category: "Materials" }]);
  });

  it("the patch's own job decides over the stored one", async () => {
    state.stored = { job_id: "job-1", amount: 50 };
    await updateBill("bill-1", { category: "diesel", job_id: null });
    expect(state.wrote).toEqual([{ category: "Fuel", job_id: null }]);
    state.wrote = [];
    state.stored = { job_id: null, amount: 50 };
    await updateBill("bill-1", { category: "Materials", job_id: "job-2" });
    expect(state.wrote).toEqual([{ category: "Materials", job_id: "job-2" }]);
  });
});
