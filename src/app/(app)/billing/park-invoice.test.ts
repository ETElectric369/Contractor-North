import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SET ASIDE UNTIL… ON A DRAFT WHOSE JOB IS OVER (Wave 1 seam fix). Needs You puts a set-aside draft
 * on a finished or cancelled job straight back on top as "Honeysuckle · J-011 Finished · Send
 * INV-081", and Nort's invoice.setAside refused it in words, but the invoice page's ⋯ Set Aside
 * Until… called parkInvoice, which wrote the day and let the page promise "It comes back on your
 * list that day". The rule now lives in parkInvoice, so every door refuses it with the same words,
 * and Put Back (no day) still works there.
 */
const state = vi.hoisted(() => ({
  job: null as { job_number: string; name: string; status: string } | null,
  status: "draft",
  updates: [] as unknown[],
}));

function fakeClient() {
  return {
    from(table: string) {
      let cols = "";
      let update: unknown = null;
      const q: any = {
        select(c: string) {
          cols = c;
          return q;
        },
        update(v: unknown) {
          update = v;
          return q;
        },
        eq: () => q,
        maybeSingle: async () => {
          if (table === "invoices" && cols === "status") return { data: { status: state.status }, error: null };
          if (table === "invoices" && cols.startsWith("jobs:job_id")) return { data: { jobs: state.job }, error: null };
          return { data: null, error: null };
        },
        then: (ok: any, err: any) => {
          if (update) state.updates.push(update);
          return Promise.resolve({ data: update ? [{ id: "inv-81" }] : [], error: null }).then(ok, err);
        },
      };
      return q;
    },
  };
}

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: fakeClient(), userId: "u1", orgId: "org-1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fakeClient()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { parkInvoice } from "./actions";

beforeEach(() => {
  state.job = null;
  state.status = "draft";
  state.updates = [];
});

describe("parkInvoice on a draft whose job is over", () => {
  it("refuses a day in the same words as Nort, and writes nothing", async () => {
    state.job = { job_number: "J-011", name: "Honeysuckle", status: "complete" };
    const r = await parkInvoice("inv-81", "2026-10-10", "Waiting on the inspection");
    expect(r).toEqual({
      ok: false,
      error: "Honeysuckle · J-011 is finished, so this draft has nothing left to wait for and stays on Needs You. Send it, or void it if it won't be billed.",
    });
    state.job = { job_number: "J-011", name: "Honeysuckle", status: "cancelled" };
    expect((await parkInvoice("inv-81", "2026-10-10")).ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it("Put Back (no day) still works there, so an old day can always be taken off", async () => {
    state.job = { job_number: "J-011", name: "Honeysuckle", status: "complete" };
    expect(await parkInvoice("inv-81", null)).toEqual({ ok: true });
    expect(state.updates).toEqual([{ hold_until: null, hold_reason: null }]);
  });

  it("a draft on a job still going, or on no job, is set aside as before", async () => {
    state.job = { job_number: "J-048", name: "Tupelo Panel", status: "in_progress" };
    expect(await parkInvoice("inv-81", "2026-10-10", " Waiting on the change order ")).toEqual({ ok: true });
    state.job = null;
    expect(await parkInvoice("inv-81", "2026-10-10")).toEqual({ ok: true });
    expect(state.updates).toEqual([
      { hold_until: "2026-10-10", hold_reason: "Waiting on the change order" },
      { hold_until: "2026-10-10", hold_reason: null },
    ]);
  });
});

describe("the invoice page's door", () => {
  it("reads its job's status and draws ⋯ Set Aside Until… only while the job is still going", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/page.tsx"), "utf8");
    expect(src).toContain("jobs:job_id(status)");
    expect(src).toMatch(/\{isDraft && !jobIsOver && \(\s*<SetAsideButton/);
  });
});
