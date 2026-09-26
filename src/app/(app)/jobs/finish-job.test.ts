import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FINISH JOB SAYS THE TRUTH, AND ON A T&M JOB IT BUILDS THE FINAL.
 *
 * Tao Zhu's J-002 is Time & Material, billed with progress payments (a paid deposit and a paid T&M
 * report); Sept 8-9 was on no bill: 19.5 h. Finish marked it complete, billed nothing and said "It
 * bills with progress payments" - and the hours dropped off every screen. Connected North Phase 1
 * made it NAME the work (still pinned below, for a fixed-price job billed with draws). Erik, 2026-
 * 09-26: on a T&M job the Final is BUILT - a draft, through the Overview card's own door (the draw
 * door as the Final on a job with draws; a standard invoice on a plain T&M job) - and the job is
 * complete only when that draft exists. Nothing is ever sent. A door that refuses, or a read that
 * fails, leaves the job as it was and says why.
 */

const state = vi.hoisted(() => ({
  client: null as any,
  billingType: null as string | null,
  draws: [{ id: "inv-00028", invoice_number: "INV-00028" }] as { id: string; invoice_number: string }[],
  unbilled: null as any,
  unbilledFails: false,
  lump: 0,
  openDraft: null as any,
  made: null as any,
  writes: [] as { table: string; payload: any }[],
  drawDoor: vi.fn(),
  blankInvoice: vi.fn(),
  emailInvoice: vi.fn(),
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
  unbilledWorkForJob: vi.fn(async () => {
    if (state.unbilledFails) throw new Error("bills read failed");
    return state.unbilled;
  }),
  fixedBillingsNotYetNetted: vi.fn(async () => state.lump),
  claimedSourcesOnJob: vi.fn(),
}));
// The real door rule (unbilledCardDoor): Finish must pick exactly what the card's button picks.
vi.mock("@/lib/actuals-draw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/actuals-draw")>()),
  openDraftOnJob: vi.fn(async () => state.openDraft),
}));
vi.mock("../billing/actions", () => ({
  createInvoiceFromQuote: vi.fn(),
  createBlankInvoice: state.blankInvoice,
  importLaborIntoInvoice: vi.fn(async () => ({ ok: false, empty: true })),
  importCostsIntoInvoice: vi.fn(async () => ({ ok: false, empty: true })),
  importChangeOrdersIntoInvoice: vi.fn(async () => ({ ok: false, empty: true })),
  createProgressReportInvoice: state.drawDoor,
  emailInvoice: state.emailInvoice,
}));

import { finishJob, finishJobPreview } from "./actions";

const JOB = "tao-j-002";

/** A PostgREST fake: every read answered by table + columns, every write recorded. */
function fake() {
  return {
    from(table: string) {
      let verb = "select";
      let cols = "";
      let payload: any = null;
      const answer = (single: boolean) => {
        if (verb !== "select") {
          state.writes.push({ table, payload });
          if (table === "jobs" && verb === "update") return [{ id: JOB }];
          return [];
        }
        if (table === "jobs" && cols === "billing_type") return { billing_type: state.billingType };
        if (table === "jobs" && cols === "customer_id, name, description") return { customer_id: "cust-1", name: "Tao Zhu", description: null };
        if (table === "jobs") return null; // pricing levels: none
        if (table === "invoices" && cols === "invoice_number, total, invoice_kind") return state.made;
        if (table === "invoices" && (cols === "id" || cols === "id, invoice_number")) return state.draws; // the live draws
        if (table === "invoices") return single ? null : [];
        if (table === "payment_milestones") return single ? null : [];
        if (table === "quotes") return [];
        if (table === "organizations") return { settings: {} };
        return single ? null : [];
      };
      const chain: any = {
        select(c?: string) { if (verb === "select") cols = c ?? ""; return chain; },
        update(p: any) { verb = "update"; payload = p; return chain; },
        insert(p: any) { verb = "insert"; payload = p; return chain; },
        maybeSingle() { return Promise.resolve({ data: answer(true), error: null }); },
        single() { return Promise.resolve({ data: answer(true), error: null }); },
        then(res: any) { return res({ data: answer(false), error: null }); },
      };
      for (const m of ["eq", "neq", "in", "is", "order", "limit", "not"]) chain[m] = () => chain;
      return chain;
    },
  };
}

const TAO_SEPT = { schemaReady: true, hours: 19.5, laborAmount: 2437.5, billsCount: 0, billsBilled: 0, stockCount: 0, stockBilled: 0, total: 2437.5, returnsCount: 0 };
const NOTHING = { schemaReady: true, hours: 0, laborAmount: 0, billsCount: 0, billsBilled: 0, stockCount: 0, stockBilled: 0, total: 0, returnsCount: 0 };

beforeEach(() => {
  state.client = fake();
  state.writes = [];
  state.billingType = null;
  state.draws = [{ id: "inv-00028", invoice_number: "INV-00028" }];
  state.openDraft = null;
  state.unbilled = { ...TAO_SEPT };
  state.unbilledFails = false;
  state.lump = 0;
  state.made = null;
  state.drawDoor.mockReset();
  state.blankInvoice.mockReset();
  state.emailInvoice.mockReset();
});

describe("finishJob on a FIXED-PRICE job billed with progress payments (unchanged)", () => {
  it("finishes, bills nothing, and NAMES the 19.5 h off a bill as a warning", async () => {
    state.billingType = "fixed";
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(res.warning).toBe(
      "19.5 h ($2,437.50) of work on this job is not on a bill yet. Finishing didn't bill it - bill it with Progress Payment → Final on the job's Invoices tab.",
    );
    expect(res.speak).toMatch(/^Job finished\. 19\.5 h/);
    // The only write is the job's status: no invoice is written, sent or promoted.
    expect(state.writes.map((w) => w.table)).toEqual(["jobs"]);
    expect(state.writes[0].payload).toEqual({ status: "complete" });
    expect(state.drawDoor).not.toHaveBeenCalled();
  });

  it("everything billed → says so, no warning", async () => {
    state.billingType = "fixed";
    state.unbilled = { ...NOTHING };
    const res = await finishJob(JOB, {});
    expect(res.warning).toBeUndefined();
    expect(res.speak).toMatch(/already on a progress payment/);
  });
});

describe("finishJob on a TIME & MATERIAL job: the Final is built as a draft, nothing is sent", () => {
  beforeEach(() => {
    state.billingType = "tm";
  });

  it("Tao J-002: builds the Final through the draw door, completes the job, and says what was built", async () => {
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-080", note: "Started INV-080 for the work not yet billed - its total is that work." });
    state.made = { invoice_number: "INV-080", total: 2437.5 };
    const res = await finishJob(JOB, { sendInvoice: true });
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "final");
    expect(res).toEqual({
      ok: true,
      id: "inv-080",
      sent: false,
      final: true,
      speak: "Job finished. Started INV-080 for $2,437.50 of work not yet billed. Review it, then Send.",
    });
    // Nothing is sent, even when asked: a draft goes out only when a person sends it.
    expect(state.emailInvoice).not.toHaveBeenCalled();
    // This action's own writes: the job's status, after the draft existed.
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "complete" } }]);
  });

  it("the draft can't be built → the job is NOT marked complete, and the reason is said", async () => {
    state.drawDoor.mockResolvedValue({ ok: false, error: "Couldn't pull this job's hours onto the draw just now, so nothing was billed. Nothing was billed and the draft was removed, so you can try again." });
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Couldn't pull this job's hours/);
    expect(res.error).toMatch(/The job was not marked complete\.$/);
    expect(state.writes).toEqual([]);
  });

  it("a lost read of the work is not 'nothing to bill': nothing is finished, nothing is built", async () => {
    state.unbilledFails = true;
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wasn't finished and nothing was billed/);
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("no unbilled work → finishes as it always has (J-002 today: everything on a bill)", async () => {
    state.unbilled = { ...NOTHING };
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(res.final).toBeUndefined();
    expect(res.speak).toMatch(/already on a progress payment/);
    expect(state.drawDoor).not.toHaveBeenCalled();
  });

  it("Herringbone: an open actuals report takes the work and becomes the Final", async () => {
    state.openDraft = { id: "inv-078", number: "INV-078", kind: "progress", refreshable: true };
    state.draws = [{ id: "inv-078", invoice_number: "INV-078" }];
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-078", note: "Pulled 2.71 hours and 2 bills into INV-078. INV-078 is now the final payment." });
    state.made = { invoice_number: "INV-078", total: 9505.83, invoice_kind: "final" };
    const res = await finishJob(JOB, {});
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "final");
    expect(res.speak).toBe("Job finished. Added the work not yet billed to INV-078, now the Final: $9,505.83. Review it, then Send.");
    expect(res.final).toBe(true);
  });

  it("the flip to Final failed: the sentence doesn't call it the Final, and the warning says why", async () => {
    state.openDraft = { id: "inv-078", number: "INV-078", kind: "progress", refreshable: true };
    state.draws = [{ id: "inv-078", invoice_number: "INV-078" }];
    const note = "Pulled 2.71 hours into INV-078. But INV-078 couldn't be marked as the final payment just now - it is still a progress payment.";
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-078", partial: true, note });
    state.made = { invoice_number: "INV-078", total: 9505.83, invoice_kind: "progress" };
    const res = await finishJob(JOB, {});
    expect(res.speak).toBe("Job finished. Added the work not yet billed to INV-078: $9,505.83. Review it, then Send.");
    expect(res.warning).toBe(note);
  });

  it("an open contract draft can't take the work → refused before anything is written", async () => {
    state.openDraft = { id: "inv-090", number: "INV-090", kind: "progress", refreshable: false };
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^INV-090 is still a draft for set amounts/);
    expect(res.error).toMatch(/The job was not marked complete\.$/);
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("Finish Without Billing past a draft for set amounts: completes, bills nothing, and the work left off is a warning with the draft to open", async () => {
    state.openDraft = { id: "inv-090", number: "INV-090", kind: "progress", refreshable: false };
    const res = await finishJob(JOB, { withoutBilling: true });
    expect(res).toMatchObject({ ok: true, id: "inv-090", sent: false });
    expect(res.final).toBeUndefined();
    expect(res.warning).toBe("$2,437.50 of work is not on a bill. INV-090 is still a draft for set amounts: send it (or delete it), then bill the work.");
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "complete" } }]);
  });

  it("Finish Without Billing when the draft is no longer in the way: nothing is done, never a bill that wasn't asked for", async () => {
    const res = await finishJob(JOB, { withoutBilling: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/bills changed since the Finish window opened/);
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("a T&M job's estimate copied onto a standard draft: Finish never adds the actuals to it", async () => {
    state.draws = [];
    state.openDraft = { id: "inv-070", number: "INV-070", kind: "standard", refreshable: false };
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^INV-070 is still a draft for set amounts/);
    expect(state.blankInvoice).not.toHaveBeenCalled();
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("a deposit that still covers the work: finishes, builds nothing, says so", async () => {
    state.lump = 10000;
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(res.final).toBeUndefined();
    // A finished job has no later bill: the figures are said, and the deposit over the work is a warning.
    expect(res.speak).toBe(
      "Job finished. The $10,000.00 deposit not yet taken off a bill covers the $2,437.50 of work not on a bill, so no bill is built. The deposit is $7,562.50 more than the work: settle the difference with the customer.",
    );
    expect(res.warning).toMatch(/\$7,562\.50 more than the work/);
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "complete" } }]);
  });

  it("a plain T&M job (no draws) keeps the standard invoice - the card's Create Invoice - never a draw", async () => {
    state.draws = [];
    state.blankInvoice.mockResolvedValue({ ok: true, id: "inv-083" });
    state.made = { invoice_number: "INV-083", total: 2437.5 };
    const res = await finishJob(JOB, { importLabor: false, importCosts: false, sendInvoice: true });
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(state.blankInvoice).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, id: "inv-083", sent: false, final: true });
    expect(res.speak).toBe("Job finished. Started INV-083 for $2,437.50 of work not yet billed. Review it, then Send.");
    expect(state.emailInvoice).not.toHaveBeenCalled();
  });
});

describe("finishJobPreview — the truth at the button", () => {
  it("fixed price with draws: names the work finishing would leave off a bill, before the press", async () => {
    state.billingType = "fixed";
    const p = await finishJobPreview(JOB);
    expect(p).toMatchObject({ ok: true, drawBilled: true, schedule: false, openDraft: null });
    expect(p.offBill).toMatch(/^Not billed yet: 19\.5 h \(\$2,437\.50\)/);
    expect(state.writes).toEqual([]); // read-only
  });

  it("an open actuals report takes the work, so nothing is said to be left off", async () => {
    state.billingType = "fixed";
    state.openDraft = { id: "inv-078", number: "INV-078", kind: "progress", refreshable: true };
    const p = await finishJobPreview(JOB);
    expect(p.openDraft).toEqual({ number: "INV-078", refreshable: true });
    expect(p.offBill).toBeNull();
  });

  it("T&M: says the Final it will build, for how much, and that nothing is sent", async () => {
    state.billingType = "tm";
    const p = await finishJobPreview(JOB);
    expect(p).toMatchObject({ ok: true, drawBilled: true, offBill: null, finalBuilds: true, finalBlocked: false, finalDoc: "final", finalDraft: null });
    expect(p.final).toBe("Finishing starts the Final for $2,437.50 of work not yet billed, as a draft, and marks the job complete. Nothing is sent.");
    expect(state.writes).toEqual([]);
    expect(state.drawDoor).not.toHaveBeenCalled();
  });

  it("a plain T&M job (no draws): it drafts an invoice, and says so - not 'the Final'", async () => {
    state.billingType = "tm";
    state.draws = [];
    const p = await finishJobPreview(JOB);
    expect(p).toMatchObject({ ok: true, finalBuilds: true, finalDoc: "invoice" });
    expect(p.final).toBe("Finishing starts an invoice for $2,437.50 of work not yet billed, as a draft, and marks the job complete. Nothing is sent.");
  });

  it("a draft for set amounts in the way: the preview names it, so the modal can open it", async () => {
    state.billingType = "tm";
    state.openDraft = { id: "inv-090", number: "INV-090", kind: "progress", refreshable: false };
    const p = await finishJobPreview(JOB);
    expect(p).toMatchObject({ finalBlocked: true, finalBuilds: false, finalDraft: { id: "inv-090", number: "INV-090" } });
  });

  it("T&M with nothing unbilled: no Final line, the ordinary preview", async () => {
    state.billingType = "tm";
    state.unbilled = { ...NOTHING };
    const p = await finishJobPreview(JOB);
    expect(p.final).toBeUndefined();
    expect(p.drawBilled).toBe(true);
  });
});
