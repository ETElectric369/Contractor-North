import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CARD'S DOOR (J-011). The Overview card's "Add to INV-078 ($1,572.27)" calls
 * createInvoiceForJob, which looked only for a STANDARD draft, found none, tried to mint a standard
 * invoice and was refused by H4 ("Draft INV-078 is still open on this job — send or delete that
 * draw..."). Pinned: an open draw is handed to the draw's own door, whose answer comes back in this
 * door's shape — the sentence as the note, a named document as `billedOn` — and a standard draft
 * is still handled here, untouched.
 */

const state = vi.hoisted(() => ({ client: null as any, drawDoor: vi.fn() }));

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
}));

import { createInvoiceForJob } from "./actions";

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
    expect(res.error).toMatch(/Progress Payment/);
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
