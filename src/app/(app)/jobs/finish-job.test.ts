import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dict } from "@/lib/i18n";

/**
 * FINISH JOB SAYS THE TRUTH, AND ON A T&M JOB IT BUILDS THE FINAL.
 *
 * Tess Zane's J-002 is Time & Material, billed with progress payments (a paid deposit and a paid T&M
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
  /** The materials import, so a test can hand back the money warning a real one raises. */
  importCosts: vi.fn(),
  /** The job's tasks the deed checks off (cn-v1174): the rows the close writes, or its refusal. */
  tasksClosed: [] as { id: string }[],
  tasksCloseFails: false,
  /** The open-task head count the Finish window reads (cn-v1174); null = the read fails. */
  openTaskCount: 0 as number | null,
  /** The job's payment requests (cn-v1177), read by lib/payment-request through this fake, and the
   *  person's language (profiles.language). */
  requests: [] as Record<string, unknown>[],
  requestLines: [] as Record<string, unknown>[],
  /** The prepaid_credit lines on the job's bills, and those bills' statuses (cn-v1177). */
  creditLines: [] as Record<string, unknown>[],
  carriers: [] as Record<string, unknown>[],
  lang: null as string | null,
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
  importCostsIntoInvoice: state.importCosts,
  importChangeOrdersIntoInvoice: vi.fn(async () => ({ ok: false, empty: true })),
  createProgressReportInvoice: state.drawDoor,
  emailInvoice: state.emailInvoice,
}));

import { finishJob, finishJobPreview, setJobStatus } from "./actions";

const JOB = "tess-j-002";

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
          if (table === "tasks" && verb === "update") return state.tasksClosed;
          return [];
        }
        if (table === "jobs" && cols === "billing_type") return { billing_type: state.billingType };
        if (table === "jobs" && cols === "customer_id, name, description") return { customer_id: "cust-1", name: "Tess Zane", description: null };
        if (table === "jobs") return null; // pricing levels: none
        if (table === "invoices" && cols === "invoice_number, total, invoice_kind") return state.made;
        // THE PAYMENT REQUESTS' READS (lib/payment-request readPrepaymentStates, cn-v1177): routed by
        // their own columns, so the real reader runs and sees what the books hold, never an error.
        if (table === "invoices" && cols === "id, invoice_number, status, title, created_at, amount_paid") return state.requests;
        if (table === "invoice_items" && cols === "invoice_id, line_total") return state.requestLines;
        if (table === "invoice_items" && cols === "invoice_id, line_total, prepaid_invoice_id") return state.creditLines;
        if (table === "invoices" && cols === "id, status") return state.carriers;
        if (table === "customer_credits") return [];
        if (table === "profiles" && cols === "language") return { language: state.lang };
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
        then(res: any) {
          // The deed's close (cn-v1174): the rows it checked off, or a refusal.
          if (table === "tasks" && verb === "update" && state.tasksCloseFails) {
            state.writes.push({ table, payload });
            return res({ data: null, error: { message: "permission denied for table tasks" } });
          }
          // The Finish window's open-task head count.
          if (table === "tasks" && verb === "select") {
            return res(state.openTaskCount === null ? { data: null, count: null, error: { message: "read failed" } } : { data: null, count: state.openTaskCount, error: null });
          }
          return res({ data: answer(false), error: null });
        },
      };
      for (const m of ["eq", "neq", "in", "is", "order", "limit", "not"]) chain[m] = () => chain;
      return chain;
    },
  };
}

const TESS_SEPT = { schemaReady: true, hours: 19.5, laborAmount: 2437.5, billsCount: 0, billsBilled: 0, stockCount: 0, stockBilled: 0, total: 2437.5, returnsCount: 0 };
const NOTHING = { schemaReady: true, hours: 0, laborAmount: 0, billsCount: 0, billsBilled: 0, stockCount: 0, stockBilled: 0, total: 0, returnsCount: 0 };

beforeEach(() => {
  state.client = fake();
  state.writes = [];
  state.billingType = null;
  state.draws = [{ id: "inv-00028", invoice_number: "INV-00028" }];
  state.openDraft = null;
  state.unbilled = { ...TESS_SEPT };
  state.unbilledFails = false;
  state.lump = 0;
  state.made = null;
  state.drawDoor.mockReset();
  state.blankInvoice.mockReset();
  state.emailInvoice.mockReset();
  state.importCosts.mockReset();
  state.importCosts.mockResolvedValue({ ok: false, empty: true });
  state.tasksClosed = [];
  state.tasksCloseFails = false;
  state.openTaskCount = 0;
  state.requests = [];
  state.requestLines = [];
  state.creditLines = [];
  state.carriers = [];
  state.lang = null;
});

describe("Finish and a payment request (cn-v1177; re-pinned on purpose after skeptic #80)", () => {
  // A paid $3,000 request on a plain T&M job with $2,437.50 of work not on a bill. A request never
  // "covers" work: the bill is BUILT for the work, its sync takes the request off (down to $0.00, the
  // line naming the request), and what was paid that no bill used is said after it with its refund door.
  const paidRequest = () => {
    state.billingType = "tm";
    state.draws = [];
    state.requests = [{ id: "req-1", invoice_number: "INV-900", status: "paid", title: "Deposit", created_at: "2026-11-01T17:00:00Z", amount_paid: 3000 }];
    state.requestLines = [{ invoice_id: "req-1", line_total: 3000 }];
    state.blankInvoice.mockImplementation(async () => {
      // The built bill's sync took the request off, capped at the bill's own lines.
      state.creditLines = [{ invoice_id: "inv-083", line_total: -2437.5, prepaid_invoice_id: "req-1" }];
      state.carriers = [{ id: "inv-083", status: "draft" }];
      return { ok: true, id: "inv-083" };
    });
    state.made = { invoice_number: "INV-083", total: 0 };
  };
  it("English: the bill is built for the work, the job finishes, and the $562.50 no bill used is said with its refund door", async () => {
    paidRequest();
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(state.blankInvoice).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ id: "inv-083", final: true });
    expect(res.speak).not.toContain("covers");
    expect(res.speak).toContain("Started INV-083");
    expect(res.speak).toContain("$562.50 was paid ahead and no bill used it. Refund it from INV-900.");
    expect(res.warning).toBe("$562.50 was paid ahead and no bill used it. Refund it from INV-900.");
  });
  it("Spanish: the unused money is said in Spanish", async () => {
    paidRequest();
    state.lang = "es";
    const res = await finishJob(JOB, {});
    expect(res.warning).toBe("$562.50 se pagó por adelantado y ninguna factura lo usó. Reembólsalo desde INV-900.");
  });
  it("the Finish window says a bill is started for the whole work, never that the request covers it", async () => {
    paidRequest();
    const pre = await finishJobPreview(JOB);
    expect(pre).toMatchObject({ ok: true, finalBuilds: true, finalDoc: "invoice" });
    expect((pre as { final?: string }).final).toContain("Finishing starts an invoice for $2,437.50 of work not yet billed");
    expect((pre as { final?: string }).final).not.toContain("asked for ahead");
  });
});

/** The deed's write (cn-v1174): the job's open tasks checked off, by the person who finished it. */
const CLOSE_TASKS = { table: "tasks", payload: { status: "done", completed_at: expect.any(String), done_by: "user-1" } };

describe("finishJob on a FIXED-PRICE job billed with progress payments (unchanged)", () => {
  it("finishes, bills nothing, and NAMES the 19.5 h off a bill as a warning", async () => {
    state.billingType = "fixed";
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(res.warning).toBe(
      "19.5 h ($2,437.50) of work on this job is not on a bill yet. Finishing didn't bill it - bill it with the job's New Invoice → This Is the Last Bill.",
    );
    expect(res.speak).toMatch(/^Job finished\. 19\.5 h/);
    // The only write is the job's status: no invoice is written, sent or promoted.
    // The job's status, then its open tasks checked off with it (cn-v1174).
    expect(state.writes.map((w) => w.table)).toEqual(["jobs", "tasks"]);
    expect(state.writes[0].payload).toEqual({ status: "complete", hold_reason: null });
    expect(state.drawDoor).not.toHaveBeenCalled();
  });

  it("everything billed → says so, no warning", async () => {
    state.billingType = "fixed";
    state.unbilled = { ...NOTHING };
    const res = await finishJob(JOB, {});
    expect(res.warning).toBeUndefined();
    expect(res.speak).toMatch(/already on a progress payment/);
  });

  it("the work couldn't be read: finishes, and the warning names the one door that bills the rest (W1-24) - never a tab, never Progress Payment", async () => {
    state.billingType = "fixed";
    state.unbilledFails = true;
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(res.warning).toBe("Couldn't check just now whether any hours or bills are still off a bill - bill what's left with the job's New Invoice → This Is the Last Bill.");
    expect(res.warning).not.toMatch(/Progress Payment|Invoices tab/);
  });
});

describe("finishJob on a TIME & MATERIAL job: the Final is built as a draft, nothing is sent", () => {
  beforeEach(() => {
    state.billingType = "tm";
  });

  it("Tess J-002: builds the Final through the draw door, completes the job, and says what was built", async () => {
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
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "complete", hold_reason: null } }, CLOSE_TASKS]);
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

  it("Honeysuckle: an open actuals report takes the work and becomes the Final", async () => {
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
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "complete", hold_reason: null } }, CLOSE_TASKS]);
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
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "complete", hold_reason: null } }, CLOSE_TASKS]);
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

/**
 * ── FINISH & SEND DOES NOT SEND OVER A MONEY QUESTION (review, 2026-10-03) ────────────────────
 *
 * The press emailed the invoice in the SAME server call that built it, and `inv.partial` — every money
 * warning the import raised — was first read AFTER the email had gone. So "pick which job it belongs
 * to on Reconcile before you send this" landed in the done panel about a bill already in the customer's
 * inbox. Do it on J-046 and again on J-102 and that is $221.43 collected for one $95.27 purchase, with
 * the new check computed and thrown away. This is the standard-invoice path: a T&M Final is never sent.
 */
describe("Finish & Send Invoice on a plain fixed-price job", () => {
  beforeEach(() => {
    state.billingType = "fixed";
    state.draws = []; // no progress payments: finishing bills a standard invoice
    state.blankInvoice.mockResolvedValue({ ok: true, id: "inv-091" });
  });

  const TICKET_ON_TWO_JOBS =
    "The same $95.27 Halverson Electric Supply ticket is also on 4 Bramble Lane · J-102 — Remy Dunsmore. " +
    "If that was one trip, pick which job it belongs to on Reconcile before you send this";

  it("a ticket on two jobs: the draft is built, the job is finished, and NOTHING is emailed", async () => {
    state.importCosts.mockResolvedValue({ ok: true, stats: { pulled_in: 1, warnings: [TICKET_ON_TWO_JOBS] } });
    const res = await finishJob(JOB, { sendInvoice: true });
    expect(res.ok).toBe(true);
    expect(res.id).toBe("inv-091");
    // THE WHOLE POINT: the question is asked while it is still free to answer.
    expect(state.emailInvoice).not.toHaveBeenCalled();
    expect(res.sent).toBe(false);
    expect(res.warning).toContain("pick which job it belongs to on Reconcile before you send this");
    // The job is still finished and the draft still exists: nothing is lost, Send is one press away.
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "complete", hold_reason: null } }, CLOSE_TASKS]);
  });

  it("an import that could not be pulled in is not sent either — every money warning holds the send", async () => {
    state.importCosts.mockResolvedValue({ ok: false, error: "bills read failed" });
    const res = await finishJob(JOB, { sendInvoice: true });
    expect(res.ok).toBe(true);
    expect(state.emailInvoice).not.toHaveBeenCalled();
    expect(res.sent).toBe(false);
    expect(res.warning).toMatch(/review the line items before sending/);
  });

  it("nothing to look at: the press still sends, exactly as it always did", async () => {
    state.importCosts.mockResolvedValue({ ok: true, stats: { pulled_in: 2 } });
    state.emailInvoice.mockResolvedValue({ ok: true });
    const res = await finishJob(JOB, { sendInvoice: true });
    expect(res.ok).toBe(true);
    expect(state.emailInvoice).toHaveBeenCalledWith("inv-091");
    expect(res.sent).toBe(true);
    expect(res.warning).toBeUndefined();
  });

  it("the button blames the question, not the customer's email address", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/finish-job-button.tsx"), "utf8");
    expect(src).toContain('t("jb_notEmailedQuestion")');
    expect(dict("en").jb_notEmailedQuestion).toContain("there's a question above waiting on the draft");
    // The old copy is kept for the case it is actually about, and only then.
    expect(src).toContain('t("jb_notEmailedNoEmail")');
    expect(dict("en").jb_notEmailedNoEmail).toContain("the customer may have no email on file");
    expect(src).toContain("res.warning\n            ?");
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

/**
 * EVERY DOOR THAT FINISHES A JOB BILLS FIRST (M2, Tess J-002 again).
 *
 * setJobStatus took the word "complete" from anybody and wrote it alone: Nort's "mark it complete",
 * and whatever door is written next. The job page's own Complete had already been pointed at
 * finishJob (209451e1) — which is exactly how a rule written at one door drifts. The rule lives at
 * the WRITER now, off the one typed table that says which statuses end a job (lib/job-status
 * JOB_STATUS_DOOR), so finishing a job is the whole motion whichever door asks for it.
 *
 * (The status write clears the hold reason with it now — the payload assertions above say so: a
 * hold's reason lives and dies with the hold, 0234, and finishing is the only door to complete.)
 */
describe("setJobStatus — 'complete' is finishing, not a status write (M2)", () => {
  it("a fixed-price job with 19.5 h on no bill: finishing through the status writer NAMES the work, as the Finish button does", async () => {
    state.billingType = "fixed";
    const res = await setJobStatus(JOB, "complete");
    expect(res.ok).toBe(true);
    // The sentence and the warning finishJob gives, handed back out of the status writer so no
    // caller (Nort included) loses them.
    expect(res.warning).toBe(
      "19.5 h ($2,437.50) of work on this job is not on a bill yet. Finishing didn't bill it - bill it with the job's New Invoice → This Is the Last Bill.",
    );
    expect(res.speak).toMatch(/^Job finished\. 19\.5 h/);
    expect(res.id).toBe("inv-00028");
  });

  it("a Time & Material job: the status writer BUILDS the Final draft first, the way the Finish button does", async () => {
    state.billingType = "tm";
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-080", note: "Started INV-080 for the work not yet billed - its total is that work." });
    state.made = { invoice_number: "INV-080", total: 2437.5 };
    const res = await setJobStatus(JOB, "complete");
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "final");
    expect(res).toEqual({
      ok: true,
      id: "inv-080",
      final: true,
      sent: false, // nothing is emailed: a draft goes out only when a person sends it
      speak: "Job finished. Started INV-080 for $2,437.50 of work not yet billed. Review it, then Send.",
    });
  });

  it("a draft that can't be built → the job is NOT finished through this door either, and nothing is written", async () => {
    state.billingType = "tm";
    state.drawDoor.mockResolvedValue({ ok: false, error: "Couldn't start the Final." });
    const res = await setJobStatus(JOB, "complete");
    expect(res.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("every OTHER status is still the plain write, and nothing is billed", async () => {
    state.billingType = "tm";
    const res = await setJobStatus(JOB, "in_progress");
    expect(res).toEqual({ ok: true });
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "in_progress", hold_reason: null } }]);
    expect(state.drawDoor).not.toHaveBeenCalled();
  });
});

describe("Finish & Send Invoice reads the review switch (cn-v1155)", () => {
  // The button's module pulls the send sheet and its actions behind it; transformed once here, with the
  // time a loaded machine needs (the first full-suite run of cn-v1156 saw 5 s on the import alone).
  let btn: typeof import("./[id]/finish-job-button");
  beforeAll(async () => {
    btn = await import("./[id]/finish-job-button");
  }, 60_000);
  const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/finish-job-button.tsx"), "utf8");

  it("review on (the default): the press mails nothing, so finishJob is called with sendInvoice false", async () => {
    const { pressSendsAtOnce } = btn;
    expect(pressSendsAtOnce(true, false)).toBe(false);
    expect(src).toContain("sendInvoice: pressSendsAtOnce(wantSend, sendWithoutReview)");
  });

  it("review off (Send Without Review on): today's one-shot call, sendInvoice true", async () => {
    const { pressSendsAtOnce } = btn;
    expect(pressSendsAtOnce(true, true)).toBe(true);
    expect(pressSendsAtOnce(false, true)).toBe(false); // an unchecked box never sends
  });

  it("the sheet opens on the draft's id; a partial import (finishJob's warning) opens none", async () => {
    const { opensReviewSheet } = btn;
    expect(opensReviewSheet({ id: "inv-091" }, true)).toBe(true);
    expect(opensReviewSheet({ id: "inv-091", warning: "review the line items before sending" }, true)).toBe(false);
    expect(opensReviewSheet({ id: "inv-091" }, false)).toBe(false); // one-shot path: no sheet
    expect(opensReviewSheet({}, true)).toBe(false);
    expect(src).toContain('<SendSheet kind="invoice" id={done.id}');
  });

  it("the checkbox says the review under review, and the old words when the switch is on", () => {
    expect(src).toContain('sendWithoutReview ? t("jb_emailInvoiceNow") : t("jb_emailInvoiceReview")');
    expect(dict("en").jb_emailInvoiceReview).toBe("Send the invoice now (you review it first)");
    expect(dict("es").jb_emailInvoiceReview).toBe("Enviar la factura ahora (tú la revisas primero)");
    expect(dict("en").jb_reviewsOnFinish).not.toMatch(/as soon as you finish/);
  });

  it("the page reads the setting and hands it through the dock", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    const dock = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-action-dock.tsx"), "utf8");
    expect(page).toContain("sendWithoutReview={getOrgSettings((org as any)?.settings).send_without_review}");
    expect(dock).toContain("sendWithoutReview={sendWithoutReview}");
  });
});

/**
 * THE DEED CLOSES THE JOB'S TASKS (cn-v1174; Erik, 2026-11-21: "ones that close out with the job should
 * already be closed out right?"). Finishing and cancelling check the job's open tasks off and say how
 * many; on hold does not; a close that fails is said and the finish stands. The Finish window says the
 * count before the press.
 */
describe("a job's tasks close with it (cn-v1174)", () => {
  it("finishing checks the open tasks off and the answer says how many, after what the billing said", async () => {
    state.billingType = "fixed";
    state.tasksClosed = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(state.writes.at(-1)).toEqual(CLOSE_TASKS);
    expect(res.speak).toMatch(/^Job finished\. .* The job's 3 open tasks are checked off\.$/);
  });

  it("one task: the sentence for one; none: nothing is added to the answer", async () => {
    state.billingType = "fixed";
    state.tasksClosed = [{ id: "t1" }];
    expect((await finishJob(JOB, {})).speak).toMatch(/The job's open task is checked off\.$/);
    state.tasksClosed = [];
    expect((await finishJob(JOB, {})).speak).not.toContain("checked off");
  });

  it("a close that fails is said as a warning, and the job stays finished", async () => {
    state.billingType = "fixed";
    state.tasksCloseFails = true;
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(true);
    expect(state.writes[0]).toEqual({ table: "jobs", payload: { status: "complete", hold_reason: null } });
    expect(res.warning).toContain(dict("en").jb_tasksNotClosed);
    expect(state.writes.filter((w) => w.table === "jobs")).toHaveLength(1); // nothing undone
  });

  it("a finish that never marks the job complete closes nothing", async () => {
    state.billingType = "tm";
    state.drawDoor.mockResolvedValue({ ok: false, error: "Couldn't start the Final." });
    state.tasksClosed = [{ id: "t1" }];
    const res = await finishJob(JOB, {});
    expect(res.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("cancelling checks them off and says how many; on hold and every other status touch no task", async () => {
    state.tasksClosed = [{ id: "t1" }, { id: "t2" }];
    const res = await setJobStatus(JOB, "cancelled");
    expect(res).toEqual({ ok: true, speak: "The job's 2 open tasks are checked off." });
    expect(state.writes).toEqual([{ table: "jobs", payload: { status: "cancelled", hold_reason: null } }, CLOSE_TASKS]);
    state.writes = [];
    expect(await setJobStatus(JOB, "on_hold", "waiting on the permit")).toEqual({ ok: true });
    expect(state.writes.map((w) => w.table)).toEqual(["jobs"]);
    state.writes = [];
    expect(await setJobStatus(JOB, "in_progress")).toEqual({ ok: true });
    expect(state.writes.map((w) => w.table)).toEqual(["jobs"]);
  });

  it("a cancel whose close fails: ok, with the failure as a warning", async () => {
    state.tasksCloseFails = true;
    const res = await setJobStatus(JOB, "cancelled");
    expect(res).toEqual({ ok: true, warning: dict("en").jb_tasksNotClosed });
  });

  it("the Finish window counts the open tasks before the press, and says when it couldn't", async () => {
    state.billingType = "fixed";
    state.openTaskCount = 4;
    expect((await finishJobPreview(JOB)).openTasks).toBe(4);
    state.openTaskCount = null;
    expect((await finishJobPreview(JOB)).openTasks).toBeNull();
    expect(state.writes).toEqual([]); // read-only
  });

  it("source: one close, at the one place a finish writes the status, and on cancel only; the reopen comment", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/actions.ts"), "utf8");
    expect(src.match(/closeJobTasks\(/g)).toHaveLength(1);
    expect(src.match(/tasksClosedSaid\(supabase, /g)).toHaveLength(2);
    expect(src).toContain('const said = status === "cancelled" ? await tasksClosedSaid(supabase, id, ctx.userId) : {};');
    expect(src).toContain("REOPENING A JOB DOES NOT REOPEN ITS TASKS.");
    const button = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/finish-job-button.tsx"), "utf8");
    expect(button).toContain('t("jb_finishTasksUnread")');
    expect(button).toContain('fillText(t("jb_finishClosesTasksMany"), { n: String(preview.openTasks) })');
  });

  it("the words, in both languages", () => {
    expect(dict("en").jb_finishClosesTasksMany).toBe("{n} tasks are still open on this job. Finishing checks them off.");
    expect(dict("es").jb_finishClosesTasksMany).toBe("{n} tareas siguen abiertas en este trabajo. Al terminarlo, quedan marcadas como hechas.");
    expect(dict("es").jb_tasksClosedMany).toBe("Las {n} tareas abiertas del trabajo quedaron marcadas como hechas.");
    expect(dict("es").jb_tasksNotClosed).toContain("Tareas");
  });
});
