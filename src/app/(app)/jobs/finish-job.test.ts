import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FINISH JOB SAYS THE TRUTH (Connected North Phase 1; Tao Zhu, J-002). Tao's job bills with
 * progress payments (a paid deposit and a paid T&M report); Sept 8-9 is on no bill: 19.5 h. Finish
 * marked it complete, billed nothing and said "It bills with progress payments" - and the hours
 * dropped off every screen. Pinned: the draw branch with no open draft NAMES the work off a bill,
 * in the warning every surface relays, and the modal's preview says it before the press.
 */

const state = vi.hoisted(() => ({
  client: null as any,
  unbilled: { schemaReady: true, hours: 19.5, laborAmount: 2437.5, billsCount: 0, billsBilled: 0 } as any,
  openDraft: null as any,
  writes: [] as { table: string; payload: any }[],
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn() }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/unbilled-work", () => ({
  unbilledWorkForJob: vi.fn(async () => state.unbilled),
  claimedSourcesOnJob: vi.fn(),
}));
vi.mock("@/lib/actuals-draw", () => ({ openDraftOnJob: vi.fn(async () => state.openDraft) }));
vi.mock("../billing/actions", () => ({
  createInvoiceFromQuote: vi.fn(),
  createBlankInvoice: vi.fn(),
  importLaborIntoInvoice: vi.fn(),
  importCostsIntoInvoice: vi.fn(),
  importChangeOrdersIntoInvoice: vi.fn(),
  createProgressReportInvoice: vi.fn(),
  emailInvoice: vi.fn(),
}));

import { finishJob, finishJobPreview } from "./actions";

const JOB = "tao-j-002";

function fake() {
  return {
    from(table: string) {
      let verb = "select";
      let payload: any = null;
      const chain: any = {
        select() { return chain; },
        update(p: any) { verb = "update"; payload = p; return chain; },
        insert(p: any) { verb = "insert"; payload = p; return chain; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(res: any) {
          if (verb !== "select") state.writes.push({ table, payload });
          if (table === "jobs" && verb === "update") return res({ data: [{ id: JOB }], error: null });
          if (table === "invoices") return res({ data: [{ id: "inv-00028" }], error: null }); // a live draw
          if (table === "payment_milestones") return res({ data: [], error: null });
          return res({ data: [], error: null });
        },
      };
      for (const m of ["eq", "neq", "in", "is", "order", "limit", "not"]) chain[m] = () => chain;
      return chain;
    },
  };
}

beforeEach(() => {
  state.client = fake();
  state.writes = [];
  state.openDraft = null;
  state.unbilled = { schemaReady: true, hours: 19.5, laborAmount: 2437.5, billsCount: 0, billsBilled: 0 };
});

describe("finishJob on a job billed with progress payments", () => {
  it("Tao J-002: finishes, bills nothing, and NAMES the 19.5 h off a bill as a warning", async () => {
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(res.warning).toBe(
      "19.5 h ($2,437.50) of work on this job is not on a bill yet. Finishing didn't bill it - bill it with Progress Payment → Final on the job's Invoices tab.",
    );
    expect(res.speak).toMatch(/^Job finished\. 19\.5 h/);
    // The only write is the job's status: no invoice is written, sent or promoted.
    expect(state.writes.map((w) => w.table)).toEqual(["jobs"]);
    expect(state.writes[0].payload).toEqual({ status: "complete" });
  });

  it("everything billed → says so, no warning", async () => {
    state.unbilled = { schemaReady: true, hours: 0, laborAmount: 0, billsCount: 0, billsBilled: 0 };
    const res = await finishJob(JOB, {});
    expect(res.warning).toBeUndefined();
    expect(res.speak).toMatch(/already on a progress payment/);
  });
});

describe("finishJobPreview — the truth at the button", () => {
  it("names the work finishing would leave off a bill, before the press", async () => {
    const p = await finishJobPreview(JOB);
    expect(p).toMatchObject({ ok: true, drawBilled: true, schedule: false, openDraft: null });
    expect(p.offBill).toMatch(/^Not billed yet: 19\.5 h \(\$2,437\.50\)/);
    expect(state.writes).toEqual([]); // read-only
  });

  it("an open actuals report takes the work, so nothing is said to be left off", async () => {
    state.openDraft = { id: "inv-078", number: "INV-078", kind: "progress", refreshable: true };
    const p = await finishJobPreview(JOB);
    expect(p.openDraft).toEqual({ number: "INV-078", refreshable: true });
    expect(p.offBill).toBeNull();
  });
});
