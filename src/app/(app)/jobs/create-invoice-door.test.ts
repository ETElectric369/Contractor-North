import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CARD'S DOOR (J-011). The Overview card's "Add to INV-078 ($1,572.27)" calls
 * createInvoiceForJob, which looked only for a STANDARD draft, found none, tried to mint a standard
 * invoice and was refused by H4 ("Draft INV-078 is still open on this job — send or delete that
 * draw..."). Pinned: an open draw is handed to the draw's own door, whose answer comes back in this
 * door's shape — the sentence as the note, a named document as `billedOn` — and a standard draft
 * is still handled here, untouched.
 */

const state = vi.hoisted(() => ({ client: null as any, drawDoor: vi.fn(), taxRate: vi.fn(async () => ({ ok: true })) }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn() }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("../billing/actions", () => ({
  createInvoiceFromQuote: vi.fn(),
  createBlankInvoice: vi.fn(async () => ({ ok: false, error: "should not mint a standard invoice" })),
  importLaborIntoInvoice: vi.fn(async () => ({ ok: false, empty: true })),
  importCostsIntoInvoice: vi.fn(async () => ({ ok: false, empty: true })),
  importChangeOrdersIntoInvoice: vi.fn(async () => ({ ok: false, empty: true })),
  createProgressReportInvoice: state.drawDoor,
  emailInvoice: vi.fn(),
  setInvoiceTaxRate: state.taxRate,
}));

import { createInvoiceForJob } from "./actions";
import {
  invoicePresetFromParam,
  newInvoiceChoices,
  newInvoicePageFacts,
  newInvoiceRoute,
  newInvoiceSaveLabel,
  workSoFarDoor,
} from "@/lib/actuals-draw";
import { createParamClaim } from "@/lib/param-claim";
import { formatCurrency } from "@/lib/utils";

const JOB = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";

/** A minimal PostgREST fake: `answer(table, cols)` decides every read. */
function fake(answer: (table: string, cols: string, single: boolean) => any) {
  return {
    from(table: string) {
      let cols = "";
      let single = false;
      const chain: any = {
        select(c?: string) { cols = c ?? ""; return chain; },
        maybeSingle() { single = true; return Promise.resolve({ data: answer(table, cols, true), error: null }); },
        single() { single = true; return Promise.resolve({ data: answer(table, cols, true), error: null }); },
        then(res: any) { res({ data: answer(table, cols, single), error: null }); },
      };
      for (const m of ["eq", "neq", "in", "is", "order", "limit", "not"]) chain[m] = () => chain;
      return chain;
    },
  };
}

function jobWithDraft(draft: { id: string; number: string; kind: string; sources: (string | null)[] }, liveDraw = false) {
  return fake((table, cols, single) => {
    if (table === "payment_milestones") return single ? null : [];
    // Any non-void draw on the job (openDraftOnJob beside a standard draft; the draw-job route).
    if (table === "invoices" && (cols === "id" || cols === "id, invoice_number")) {
      return liveDraw || draft.kind !== "standard" ? [{ id: "inv-077", invoice_number: "INV-077" }] : [];
    }
    if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) {
      return [{ id: draft.id, invoice_number: draft.number, invoice_kind: draft.kind, dismissed_import_keys: [] }];
    }
    if (table === "invoice_items" && cols === "import_source") return draft.sources.map((s) => ({ import_source: s }));
    if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) {
      return draft.kind === "standard" ? [{ id: draft.id, invoice_number: draft.number, status: "draft", quote_id: null }] : [];
    }
    if (table === "quotes") return [];
    if (table === "organizations") return { settings: {} };
    if (table === "jobs") return null;
    throw new Error(`unrouted ${table} [${cols}]`);
  });
}

beforeEach(() => state.drawDoor.mockReset());

describe("createInvoiceForJob — the open draft is the door, whatever its kind", () => {
  it("J-011: an open T&M progress report is brought up to date through the draw's door, and says what it pulled", async () => {
    state.client = jobWithDraft({ id: "inv-078", number: "INV-078", kind: "progress", sources: ["costs", "labor"] });
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-078", note: "Pulled 12 hours and 1 bill into INV-078." });
    const res = await createInvoiceForJob(JOB);
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "progress");
    expect(res).toEqual({ ok: true, id: "inv-078", importWarning: "Pulled 12 hours and 1 bill into INV-078." });
  });

  it("an open contract draw comes back as a refusal carrying its door (Open INV-080), never H4's dead end", async () => {
    state.client = jobWithDraft({ id: "inv-080", number: "INV-080", kind: "progress", sources: [null] });
    state.drawDoor.mockResolvedValue({ ok: false, error: "INV-080 is still open…", openDraft: { id: "inv-080", number: "INV-080" } });
    const res = await createInvoiceForJob(JOB);
    expect(res.ok).toBe(false);
    expect(res.billedOn).toEqual({ id: "inv-080", number: "INV-080" });
    expect(res.error).not.toMatch(/instead of billing on a standard invoice/);
  });

  it("a partial refresh keeps its heads-up tone", async () => {
    state.client = jobWithDraft({ id: "inv-078", number: "INV-078", kind: "progress", sources: ["labor"] });
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-078", partial: true, note: "Pulled 1 bill into INV-078. But the hours (…) couldn't be pulled in" });
    const res = await createInvoiceForJob(JOB);
    expect(res.partial).toBe(true);
  });

  it("an EMPTY standard draft beside a sent draw is not the door (every importer refuses it): the draw door bills the work", async () => {
    state.client = jobWithDraft({ id: "inv-079", number: "INV-079", kind: "standard", sources: [] }, true);
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-081", note: "Started INV-081 for the work not yet billed - its total is that work." });
    const res = await createInvoiceForJob(JOB);
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "progress");
    expect(res).toMatchObject({ ok: true, id: "inv-081" });
  });

  it("a FIXED-PRICE quoted job whose paid deposit came from the estimate and whose draws bill actuals goes to the progress report — the paid deposit is never reopened", async () => {
    const createInvoiceFromQuote = (await import("../billing/actions")).createInvoiceFromQuote as unknown as ReturnType<typeof vi.fn>;
    createInvoiceFromQuote.mockReset();
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "fixed" };
      if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) return []; // no open draft
      if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) return []; // no standard invoices
      if (table === "quotes") return [{ id: "q-tao", status: "accepted" }];
      if (table === "invoices" && cols === "id") return [{ id: "inv-00006" }]; // the deposit carries the quote_id
      if (table === "invoices" && cols === "id, invoice_number") return [{ id: "inv-00028", invoice_number: "INV-00028" }, { id: "inv-00006", invoice_number: "INV-00006" }];
      if (table === "invoice_items" && cols === "id") return [{ id: "li-labor" }]; // INV-00028 carries labor lines
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-new", note: "Started a progress payment for 19.5 hours." });
    const res = await createInvoiceForJob(JOB);
    expect(createInvoiceFromQuote).not.toHaveBeenCalled();
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "progress");
    expect(res).toMatchObject({ ok: true, id: "inv-new" });
  });

  it("a FIXED-PRICE quoted job billed only by contract draws is told the door, with the latest draw — never a reopened bill, never actuals behind its back", async () => {
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "fixed" };
      if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) return [];
      if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) return [];
      if (table === "quotes") return [{ id: "q-1", status: "accepted" }];
      if (table === "invoices" && cols === "id") return [{ id: "dep-1" }];
      if (table === "invoices" && cols === "id, invoice_number") return [{ id: "dep-1", invoice_number: "INV-090" }];
      if (table === "invoice_items" && cols === "id") return []; // no labor/costs lines on any draw
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    const res = await createInvoiceForJob(JOB);
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.billedOn).toEqual({ id: "dep-1", number: "INV-090" });
    // THE REFUSAL IS A DOOR (W1-24): named by the job's New Invoice, never a tab, and carried as
    // `door` so the job's button opens its sheet on Part Of The Estimate and /billing links there.
    expect(res.error).toMatch(/the job's New Invoice → Part Of The Estimate/);
    expect(res.error).not.toMatch(/Progress Payment|Invoices tab/);
    expect(res.door).toBe("part-of-estimate");
  });

  it("Tao J-002 (T&M): the estimate is a guide - with only the estimate's deposit out, the next bill is still the progress report of the actuals", async () => {
    const createInvoiceFromQuote = (await import("../billing/actions")).createInvoiceFromQuote as unknown as ReturnType<typeof vi.fn>;
    createInvoiceFromQuote.mockReset();
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "tm" };
      if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) return [];
      if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) return [];
      if (table === "quotes") return [{ id: "q-tao", status: "accepted" }];
      // Only the deposit, made from the estimate, and no labor/costs line on any draw yet.
      if (table === "invoices" && cols === "id, invoice_number") return [{ id: "inv-00006", invoice_number: "INV-00006" }];
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-new", note: "Started INV-082 for the work not yet billed, less the $10,000.00 deposit not yet taken off a bill." });
    const res = await createInvoiceForJob(JOB);
    expect(createInvoiceFromQuote).not.toHaveBeenCalled();
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "progress");
    expect(res).toMatchObject({ ok: true, id: "inv-new" });
  });

  it("a T&M job with an accepted estimate and no bills yet: a blank invoice with the actuals pulled in, never the estimate's lines", async () => {
    const billing = await import("../billing/actions");
    const createInvoiceFromQuote = billing.createInvoiceFromQuote as unknown as ReturnType<typeof vi.fn>;
    const createBlankInvoice = billing.createBlankInvoice as unknown as ReturnType<typeof vi.fn>;
    const importLabor = billing.importLaborIntoInvoice as unknown as ReturnType<typeof vi.fn>;
    const importCosts = billing.importCostsIntoInvoice as unknown as ReturnType<typeof vi.fn>;
    createInvoiceFromQuote.mockReset();
    importLabor.mockClear();
    importCosts.mockClear();
    createBlankInvoice.mockResolvedValueOnce({ ok: true, id: "inv-first" });
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "tm" };
      if (table === "jobs") return { customer_id: "c-1", name: "Schaffer", description: null };
      if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) return [];
      if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) return [];
      if (table === "invoices" && cols === "id, invoice_number") return [];
      if (table === "quotes") return [{ id: "q-010", status: "accepted" }];
      if (table === "organizations") return { settings: {} };
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    const res = await createInvoiceForJob(JOB);
    expect(createInvoiceFromQuote).not.toHaveBeenCalled();
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(importLabor).toHaveBeenCalledWith("inv-first");
    expect(importCosts).toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, id: "inv-first" });
  });

  it("a T&M job whose open standard draft was copied from the estimate: the hours never go on it (estimate + actuals on one bill)", async () => {
    const billing = await import("../billing/actions");
    const importLabor = billing.importLaborIntoInvoice as unknown as ReturnType<typeof vi.fn>;
    const importCosts = billing.importCostsIntoInvoice as unknown as ReturnType<typeof vi.fn>;
    importLabor.mockClear();
    importCosts.mockClear();
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "tm" };
      if (table === "jobs") return null;
      if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) {
        return [{ id: "inv-070", invoice_number: "INV-070", invoice_kind: "standard", dismissed_import_keys: [], quote_id: "q-1" }];
      }
      if (table === "invoices" && (cols === "id" || cols === "id, invoice_number")) return []; // no draws
      if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) {
        return [{ id: "inv-070", invoice_number: "INV-070", status: "draft", quote_id: "q-1" }];
      }
      if (table === "quotes") return [{ id: "q-1", status: "accepted" }];
      if (table === "organizations") return { settings: {} };
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    // The card's rule: that draft takes no new work, so the button opens it.
    const { openDraftOnJob, unbilledCardDoor } = await import("@/lib/actuals-draw");
    const draft = await openDraftOnJob(state.client, JOB);
    expect(draft).toMatchObject({ id: "inv-070", refreshable: false });
    expect(unbilledCardDoor({ openDraft: draft, workPending: true, returns: 0, total: 900, newWork: 900, money: (n) => String(n) })?.kind).toBe("open");
    // The New Invoice door agrees: it opens the draft and pulls nothing onto it.
    const res = await createInvoiceForJob(JOB);
    expect(importLabor).not.toHaveBeenCalled();
    expect(importCosts).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, id: "inv-070", partial: true });
    expect(res.importWarning).toMatch(/carries the estimate's lines, so the hours and receipts weren't added/);
  });

  it("an open STANDARD draft stays this door's business, as before", async () => {
    state.client = jobWithDraft({ id: "inv-062", number: "INV-062", kind: "standard", sources: ["labor"] });
    const res = await createInvoiceForJob(JOB);
    expect(state.drawDoor).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.id).toBe("inv-062");
  });
});

/**
 * ONE NEW INVOICE ON THE JOB (W1-24): THE BUTTON GOES WHERE THE SERVER GOES.
 *
 * The job's New Invoice decides what one tap does from the facts its page already read
 * (newInvoicePageFacts → newInvoiceRoute → newInvoiceChoices). Each case below builds the page's
 * facts, asks the button what it would do, and asks the server (createInvoiceForJob) the same
 * question on the same job, so the button can never offer a door the server refuses.
 */
describe("the job's New Invoice routes like the server, case by case (W1-24)", () => {
  const money = formatCurrency;
  const TAO_WORK = { hours: 19.5, billsCount: 0, stockCount: 0, returnsCount: 0, total: 2437.5, laborAmount: 2437.5, billsBilled: 0, stockBilled: 0 };
  const facts = (f: { billingType: string; estimate?: number; quotes?: any[]; invoices?: any[]; milestones?: number }) =>
    newInvoicePageFacts({ billingType: f.billingType, estimate: f.estimate ?? 0, quotes: f.quotes ?? [], invoices: f.invoices ?? [], milestoneCount: f.milestones ?? 0 });

  it("an open draw draft that takes new work: no sheet, the draft (INV-078) is brought up to date", async () => {
    const f = facts({ billingType: "tm", invoices: [{ status: "draft", invoice_kind: "progress" }] });
    expect(newInvoiceRoute({ ...f, openDraft: { id: "inv-078", number: "INV-078", refreshable: true } })).toEqual({ kind: "draft", adds: true });
    state.client = jobWithDraft({ id: "inv-078", number: "INV-078", kind: "progress", sources: ["labor"] });
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-078", note: "Pulled 6 hours and 1 bill into INV-078." });
    expect(await createInvoiceForJob(JOB)).toEqual({ ok: true, id: "inv-078", importWarning: "Pulled 6 hours and 1 bill into INV-078." });
  });

  it("an open draft for set amounts: no sheet, it opens (the server would only refuse new work on it)", async () => {
    const f = facts({ billingType: "fixed", estimate: 12000, quotes: [{ status: "accepted", total: 12000 }], invoices: [{ status: "draft", invoice_kind: "progress" }] });
    expect(newInvoiceRoute({ ...f, openDraft: { id: "inv-080", number: "INV-080", refreshable: false } })).toEqual({ kind: "draft", adds: false });
    // A preset never opens a sheet the server would refuse while that draft is open.
    expect(newInvoiceRoute({ ...f, openDraft: { id: "inv-080", number: "INV-080", refreshable: false } }, "part").kind).toBe("draft");
  });

  it("draws that bill actuals (Tao J-002, T&M): the sheet, and Bill The Work So Far is the card's own progress-payment door, the default", async () => {
    const f = facts({ billingType: "tm", estimate: 17325, quotes: [{ status: "accepted", total: 17325 }], invoices: [{ status: "paid", invoice_kind: "deposit" }, { status: "paid", invoice_kind: "progress" }] });
    expect(f).toMatchObject({ drawBilled: true, billsActuals: true, wholeEstimate: null, scheduleActive: false });
    expect(newInvoiceRoute({ ...f, openDraft: null })).toEqual({ kind: "sheet" });
    const workDoor = workSoFarDoor(TAO_WORK, 0, f.drawBilled, money);
    expect(workDoor).toEqual({ kind: "draw", label: "Create Progress Payment for $2,437.50", amount: 2437.5 });
    expect(newInvoiceChoices({ ...f, billingType: "tm", estimate: 17325, workDoor })).toEqual({ choices: ["deposit", "part", "work"], initial: "work" });
    // The server takes the same job to the same door.
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "tm" };
      if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) return [];
      if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) return [];
      if (table === "quotes") return [{ id: "q-tao", status: "accepted" }];
      if (table === "invoices" && cols === "id, invoice_number") return [{ id: "inv-00028", invoice_number: "INV-00028" }];
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-new", note: "Started INV-082 for the work not yet billed - its total is that work." });
    expect(await createInvoiceForJob(JOB)).toMatchObject({ ok: true, id: "inv-new" });
    expect(state.drawDoor).toHaveBeenCalledWith(JOB, "progress");
  });

  it("draws that are set parts of the estimate: the sheet offers Deposit and Part Of The Estimate only - never actuals behind a contract", async () => {
    const f = facts({ billingType: "fixed", estimate: 20000, quotes: [{ status: "accepted", total: 20000 }], invoices: [{ status: "paid", invoice_kind: "deposit" }] });
    expect(f).toMatchObject({ drawBilled: true, billsActuals: false, wholeEstimate: null });
    expect(newInvoiceRoute({ ...f, openDraft: null })).toEqual({ kind: "sheet" });
    expect(newInvoiceChoices({ ...f, billingType: "fixed", estimate: 20000, workDoor: null })).toEqual({ choices: ["deposit", "part"], initial: "part" });
    // …and a door that went to the server anyway comes back as the same choice (the `door`).
    expect(newInvoiceChoices({ ...f, billingType: "fixed", estimate: 20000, workDoor: null }, "part").initial).toBe("part");
  });

  it("a standard draft beside a live draw is no door: the sheet (openDraftOnJob reports none), and the server bills the work through the draw door", async () => {
    state.client = jobWithDraft({ id: "inv-079", number: "INV-079", kind: "standard", sources: [] }, true);
    const { openDraftOnJob } = await import("@/lib/actuals-draw");
    expect(await openDraftOnJob(state.client, JOB)).toBeNull();
    const f = facts({ billingType: "tm", invoices: [{ status: "draft", invoice_kind: "standard" }, { status: "sent", invoice_kind: "progress" }] });
    expect(newInvoiceRoute({ ...f, openDraft: null })).toEqual({ kind: "sheet" });
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-081", note: "Started INV-081 for the work not yet billed - its total is that work." });
    expect(await createInvoiceForJob(JOB)).toMatchObject({ ok: true, id: "inv-081" });
  });

  it("a payment schedule: no sheet, the schedule's own Request Next Payment (the server refuses any other bill)", async () => {
    const f = facts({ billingType: "fixed", estimate: 30000, quotes: [{ status: "accepted", total: 30000 }], milestones: 3 });
    expect(newInvoiceRoute({ ...f, openDraft: null })).toEqual({ kind: "schedule" });
    expect(newInvoiceRoute({ ...f, openDraft: null }, "deposit")).toEqual({ kind: "schedule" });
    state.client = fake((table, _cols, single) => {
      if (table === "payment_milestones") return single ? { id: "m-1" } : [{ id: "m-1" }];
      throw new Error(`unrouted ${table}`);
    });
    const res = await createInvoiceForJob(JOB);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/payment schedule/);
  });

  it("no estimate and no draw (a service call): one tap, createInvoiceForJob exactly as before; Take A Deposit Instead opens the sheet on Deposit", async () => {
    const f = facts({ billingType: "fixed", quotes: [{ status: "declined", total: 900 }] });
    expect(f).toMatchObject({ hasEstimate: false, drawBilled: false, billsActuals: true });
    expect(newInvoiceRoute({ ...f, openDraft: null })).toEqual({ kind: "direct" });
    expect(newInvoiceRoute({ ...f, openDraft: null }, "deposit")).toEqual({ kind: "sheet" });
    expect(newInvoiceChoices({ ...f, billingType: "fixed", estimate: 0, workDoor: workSoFarDoor(TAO_WORK, 0, false, money) }, "deposit")).toEqual({
      choices: ["deposit", "work"],
      initial: "deposit",
    });
    const billing = await import("../billing/actions");
    const createBlankInvoice = billing.createBlankInvoice as unknown as ReturnType<typeof vi.fn>;
    createBlankInvoice.mockClear();
    createBlankInvoice.mockResolvedValueOnce({ ok: true, id: "inv-svc" });
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "fixed" };
      if (table === "jobs") return { customer_id: "c-1", name: "Service call", description: null };
      if (table === "invoices") return [];
      if (table === "quotes") return [{ id: "q-no", status: "declined" }];
      if (table === "organizations") return { settings: {} };
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    expect(await createInvoiceForJob(JOB)).toMatchObject({ ok: true, id: "inv-svc" });
    // No rate asked: untaxed, exactly as the old button.
    expect(createBlankInvoice).toHaveBeenCalledWith(expect.objectContaining({ job_id: JOB, tax_rate: 0 }));
  });

  it("a fixed-price job with an estimate and nothing billed: Deposit, Part Of The Estimate, and The Whole Estimate at the figure New Invoice copies", async () => {
    const quotes = [
      { status: "declined", total: 9000, created_at: "2026-09-02" },
      { status: "accepted", total: 12400, created_at: "2026-09-01" },
    ];
    const f = facts({ billingType: "fixed", estimate: 12400, quotes });
    expect(f).toMatchObject({ hasEstimate: true, drawBilled: false, billsActuals: false, wholeEstimate: 12400 });
    expect(newInvoiceRoute({ ...f, openDraft: null })).toEqual({ kind: "sheet" });
    expect(newInvoiceChoices({ ...f, billingType: "fixed", estimate: 12400, workDoor: null })).toEqual({ choices: ["deposit", "part", "whole"], initial: "part" });
    // A bill that already went out may be the estimate's: The Whole Estimate isn't offered then.
    expect(facts({ billingType: "fixed", estimate: 12400, quotes, invoices: [{ status: "sent", invoice_kind: "standard" }] }).wholeEstimate).toBeNull();
    // A T&M job's estimate is a guide, never copied whole.
    expect(facts({ billingType: "tm", estimate: 12400, quotes }).wholeEstimate).toBeNull();
    // The server copies that estimate.
    const billing = await import("../billing/actions");
    const createInvoiceFromQuote = billing.createInvoiceFromQuote as unknown as ReturnType<typeof vi.fn>;
    createInvoiceFromQuote.mockReset();
    createInvoiceFromQuote.mockResolvedValueOnce({ ok: true, id: "inv-est" });
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "fixed" };
      if (table === "jobs") return null; // pricing levels: none
      if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) return [];
      if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) return [];
      if (table === "invoices" && cols === "id") return []; // nothing made from the estimate yet
      if (table === "invoices" && cols === "id, invoice_number") return []; // no draws
      if (table === "quotes") return [{ id: "q-acc", status: "accepted" }];
      if (table === "organizations") return { settings: {} };
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    expect(await createInvoiceForJob(JOB)).toMatchObject({ ok: true, id: "inv-est" });
    expect(createInvoiceFromQuote).toHaveBeenCalledWith("q-acc");
  });

  it("Save names what it makes, and The Rest is the last part", () => {
    expect(newInvoiceSaveLabel("deposit", false, 500, formatCurrency)).toBe("Create Deposit $500.00");
    expect(newInvoiceSaveLabel("part", false, 6000, formatCurrency)).toBe("Create Invoice $6,000.00");
    expect(newInvoiceSaveLabel("part", true, 6200, formatCurrency)).toBe("Create Final Invoice $6,200.00");
    expect(newInvoiceSaveLabel("deposit", false, 0, formatCurrency)).toBe("Create Deposit");
  });
});

describe("?invoice=part opens the job's New Invoice sheet once (W1-24)", () => {
  it("only part and deposit are presets; anything else is none", () => {
    expect(invoicePresetFromParam("part")).toBe("part");
    expect(invoicePresetFromParam("deposit")).toBe("deposit");
    expect(invoicePresetFromParam("final")).toBeNull();
    expect(invoicePresetFromParam(null)).toBeNull();
  });

  it("the first New Invoice on the page answers the param; a second one never opens a second sheet, and the claim frees when its holder lets go", () => {
    const claim = createParamClaim();
    const answers = (id: string) => (invoicePresetFromParam("part") && claim.take(id) ? "opens" : "stays shut");
    expect(answers("overview-card")).toBe("opens");
    expect(answers("invoices-tab")).toBe("stays shut");
    // The same holder asking again (a re-render) doesn't re-open it either: the param is stripped
    // after the first answer, and the claim is still held.
    expect(claim.take("overview-card")).toBe(false);
    claim.release("invoices-tab"); // not the holder: nothing changes
    expect(claim.take("invoices-tab")).toBe(false);
    claim.release("overview-card");
    expect(claim.take("invoices-tab")).toBe(true);
  });

  it("the job's button reads the param through the one claim and strips it after answering", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/new-invoice-button.tsx"), "utf8");
    expect(src).toContain('invoicePresetFromParam(searchParams.get("invoice"))');
    expect(src).toContain("if (!presetParam.take(claimant)) return;");
    expect(src).toContain('params.delete("invoice");');
  });
});

describe("a sales-tax rate asked for on a new invoice (W1-28)", () => {
  it("the blank invoice starts at it", async () => {
    const billing = await import("../billing/actions");
    const createBlankInvoice = billing.createBlankInvoice as unknown as ReturnType<typeof vi.fn>;
    createBlankInvoice.mockClear();
    createBlankInvoice.mockResolvedValueOnce({ ok: true, id: "inv-taxed" });
    state.client = fake((table, cols, single) => {
      if (table === "payment_milestones") return single ? null : [];
      if (table === "jobs" && cols === "billing_type") return { billing_type: "tm" };
      if (table === "jobs") return { customer_id: "c-1", name: "Deck", description: null };
      if (table === "invoices") return [];
      if (table === "quotes") return [];
      if (table === "organizations") return { settings: {} };
      throw new Error(`unrouted ${table} [${cols}]`);
    });
    expect(await createInvoiceForJob(JOB, { taxRate: 0.0825 })).toMatchObject({ ok: true, id: "inv-taxed" });
    expect(createBlankInvoice).toHaveBeenCalledWith(expect.objectContaining({ tax_rate: 0.0825 }));
  });

  it("landing on an open draft ignores it, and says the draft keeps its own tax", async () => {
    state.client = jobWithDraft({ id: "inv-062", number: "INV-062", kind: "standard", sources: ["labor"] });
    const res = await createInvoiceForJob(JOB, { taxRate: 0.0825 });
    expect(res).toMatchObject({ ok: true, id: "inv-062" });
    expect(res.importWarning).toMatch(/INV-062 keeps its own sales tax\./);
    state.drawDoor.mockResolvedValue({ ok: true, id: "inv-078", note: "Pulled 2 hours into INV-078." });
    state.client = jobWithDraft({ id: "inv-078", number: "INV-078", kind: "progress", sources: ["labor"] });
    expect((await createInvoiceForJob(JOB, { taxRate: 0.0825 })).importWarning).toBe("Pulled 2 hours into INV-078. INV-078 keeps its own sales tax.");
  });

  it("an estimate copy keeps the estimate's own tax; one with no tax takes the rate asked for", async () => {
    const billing = await import("../billing/actions");
    const createInvoiceFromQuote = billing.createInvoiceFromQuote as unknown as ReturnType<typeof vi.fn>;
    const route = (ownRate: number) =>
      fake((table, cols, single) => {
        if (table === "payment_milestones") return single ? null : [];
        if (table === "jobs" && cols === "billing_type") return { billing_type: "fixed" };
        if (table === "jobs") return null; // pricing levels: none
        if (table === "invoices" && cols.startsWith("id, invoice_number, invoice_kind, dismissed_import_keys")) return [];
        if (table === "invoices" && cols.startsWith("id, invoice_number, status, quote_id")) return [];
        if (table === "invoices" && (cols === "id" || cols === "id, invoice_number")) return [];
        if (table === "invoices" && cols === "tax_rate") return { tax_rate: ownRate };
        if (table === "quotes") return [{ id: "q-acc", status: "accepted" }];
        if (table === "organizations") return { settings: {} };
        throw new Error(`unrouted ${table} [${cols}]`);
      });
    state.taxRate.mockClear();
    createInvoiceFromQuote.mockReset();
    createInvoiceFromQuote.mockResolvedValue({ ok: true, id: "inv-est" });
    state.client = route(0.0725);
    const kept = await createInvoiceForJob(JOB, { taxRate: 0.0825 });
    expect(kept.importWarning).toBe("It keeps the estimate's own sales tax, 7.25%.");
    expect(state.taxRate).not.toHaveBeenCalled();
    state.client = route(0);
    const seeded = await createInvoiceForJob(JOB, { taxRate: 0.0825 });
    expect(seeded).toMatchObject({ ok: true, id: "inv-est" });
    expect(state.taxRate).toHaveBeenCalledWith("inv-est", 8.25);
  });
});
