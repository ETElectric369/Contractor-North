import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * WON · START THE JOB, THE SERVER'S DOORS AGAINST STAND-IN CLIENTS (cn-v1176, M3 + M4 + M7).
 *
 *   - the office only: a tech or crew lead is refused in one sentence and reads nothing priced;
 *   - the sheet's read answers the state the server decides (the builder's lines, an estimate that
 *     stands, finish, has_job, plain, Not Sold);
 *   - approve saves once (under the sheet's own id, the visit's capture link, lead and customer, the
 *     document word the billing kind asks for), accepts once (in person, the billing kind carried),
 *     marks a booked inspection done through its own door, answers with the STORED total and the job;
 *   - a second call is harmless; an estimate that stands is the one approved, never a second; a stale
 *     stamp, a hole, a bad number refuse before anything is written; an accept that fails after a good
 *     save says so and asks for a fresh read.
 *
 * The estimate doors (saveQuote, updateQuoteStatus) and Mark Inspection Done's door are mocked at their
 * seams: their own rules are pinned in their own files (quotes/accepted-how.test.ts for the acceptance).
 */
const ORG = "org-1";
const state = vi.hoisted(() => ({ staff: true, lang: "en" as "en" | "es", db: null as any, acceptFails: false, estimatesOn: true }));
const spies = vi.hoisted(() => ({ save: vi.fn(), accept: vi.fn(), done: vi.fn() }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: state.db.sb, userId: "u-office", orgId: ORG, role: "office" } : { error: "This action is staff-only." })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.db.sb) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/lang-of", () => ({ callerLang: vi.fn(async () => state.lang) }));
vi.mock("@/lib/schedule-options", async (importOriginal) => ({ ...(await importOriginal<object>()), readUsualBillingKind: vi.fn(async () => "tm") }));
vi.mock("@/lib/estimate/revision", async (importOriginal) => ({ ...(await importOriginal<object>()), revisionOf: vi.fn(async () => null) }));
vi.mock("@/lib/estimate/task-kits", async (importOriginal) => ({ ...(await importOriginal<object>()), readTaskKits: vi.fn(async () => ({ kits: [], rows: [], rung: 0, state: "ok" })) }));
vi.mock("../quotes/actions", () => ({ saveQuote: spies.save, updateQuoteStatus: spies.accept }));
vi.mock("./actions", () => ({ setAppointmentStatus: spies.done }));
vi.mock("@/lib/estimate/visit-lines", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/estimate/visit-lines")>();
  return {
    ...real,
    // The visit-side read, from the stand-in's own visit row (so what the doors write is read back).
    readVisitEstimateSeed: vi.fn(async (_sb: unknown, id: string) => {
      const visit = state.db.tables.appointments.find((a: any) => a.id === id);
      if (!visit) return null;
      const lead = visit.inquiry_id ? (state.db.tables.inquiries.find((l: any) => l.id === visit.inquiry_id) ?? null) : null;
      return {
        visit,
        pb: { needs: [] },
        answers: {},
        lead,
        typed: { items: visit.typed ?? [], measures: [] },
        scopes: visit.scopes ?? [],
        tasks: [],
        scopeWord: null,
        pricingCustomerId: real.pricingCustomerId(visit.customer_id, lead?.customer_id),
      };
    }),
    readPriceBook: vi.fn(async () => ({ data: [{ id: "b1", code: "S1", description: "Service upgrade, 200A", unit: "EA", buy_price: 100, markup_pct: null }], error: null })),
    readPricingLevel: vi.fn(async () => null),
  };
});

const { fakeDb } = await import("@/test/fake-supabase");
const { readWonSheet, approveVisitEstimate } = await import("./won-actions");

const VISIT = "11111111-1111-4111-8111-111111111111";
const QID = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

function world(over: { visit?: Record<string, unknown>; quotes?: Record<string, unknown>[]; items?: Record<string, unknown>[] } = {}) {
  state.db = fakeDb({
    appointments: [
      {
        id: VISIT,
        org_id: ORG,
        type: "inspection",
        status: "scheduled",
        outcome: null,
        job_id: null,
        inquiry_id: "lead-1",
        customer_id: null,
        capture: {},
        scopes: [{ key: "q_scopes", label: "Scopes", picks: [{ code: "S1", qty: 2, price: 150 }] }],
        typed: [{ id: "c1", description: "Weatherhead", quantity: 1, unit: "ea" }],
        ...over.visit,
      },
    ],
    inquiries: [{ id: "lead-1", org_id: ORG, customer_id: "c-lead", name: "Casey Loam", company_name: null }],
    organizations: [{ id: ORG, settings: { features: { sales_tax: false, ...(state.estimatesOn ? {} : { estimates: false }) } } }],
    quotes: over.quotes ?? [],
    quote_line_items: over.items ?? [],
    jobs: [],
    tax_rates: [],
  });
}
const visitRow = () => state.db.tables.appointments[0];
const quoteRow = (id: string) => state.db.tables.quotes.find((q: any) => q.id === id);

beforeEach(() => {
  state.staff = true;
  state.lang = "en";
  state.acceptFails = false;
  state.estimatesOn = true;
  spies.save.mockReset();
  spies.accept.mockReset();
  spies.done.mockReset();
  // saveQuote, as the door behaves: one row per id (draft), the visit's backlink stamped, the stored total.
  spies.save.mockImplementation(async (input: any) => {
    let q = quoteRow(input.id);
    const total = input.items.reduce((s: number, i: any) => s + Math.round(i.quantity * i.unit_price * 100) / 100, 0);
    if (!q) {
      q = { id: input.id, org_id: ORG, quote_number: "E-900", status: "draft", job_id: null };
      state.db.tables.quotes.push(q);
    }
    Object.assign(q, { inquiry_id: input.inquiry_id, customer_id: input.customer_id, doc_type: input.doc_type, total, subtotal: total, tax: 0, tax_rate: 0 });
    visitRow().capture = { ...visitRow().capture, quote_id: input.id };
    return { ok: true, id: input.id, quote_number: "E-900", subtotal: total, tax: 0, total };
  });
  // updateQuoteStatus, as the door behaves: accepted, the job made once (createJobFromQuote's claim), the
  // visits behind it Won and tied to the job (closeVisitsBehindQuote).
  spies.accept.mockImplementation(async (id: string) => {
    if (state.acceptFails) return { ok: false, error: "the network dropped" };
    const q = quoteRow(id);
    q.status = "accepted";
    if (!q.job_id) {
      state.db.tables.jobs.push({ id: "job-900", org_id: ORG, job_number: "J-900" });
      q.job_id = "job-900";
    }
    if (!visitRow().job_id) visitRow().job_id = q.job_id;
    if (!visitRow().outcome) visitRow().outcome = "won";
    return { ok: true, jobId: q.job_id };
  });
  spies.done.mockImplementation(async (_id: string, status: string) => {
    visitRow().status = status;
    return { ok: true, previousStatus: "scheduled" };
  });
});

describe("the office only", () => {
  it("a tech or crew lead is refused in one sentence; nothing is read, saved or accepted", async () => {
    world();
    state.staff = false;
    expect(await readWonSheet(VISIT)).toEqual({ ok: false, error: "Only the office can start a job from a sale." });
    state.lang = "es";
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: QID, stamp: "x", overrides: [], billingType: "tm" })).toEqual({
      ok: false,
      error: "Solo la oficina puede empezar un trabajo desde una venta.",
      reread: false,
    });
    expect(spies.save).not.toHaveBeenCalled();
    expect(spies.accept).not.toHaveBeenCalled();
  });
});

describe("the read: the server decides", () => {
  it("the builder's lines, each hole named, the totals, the company's usual kind, a customer from the lead", async () => {
    world();
    const s = await readWonSheet(VISIT);
    expect(s).toMatchObject({ ok: true, state: "estimate", source: "visit", quote: null, billingKind: "tm", noCustomer: false, taxRate: 0, subtotal: 300, total: 300 });
    if (!s.ok || s.state !== "estimate") throw new Error("not an estimate");
    expect(s.lines.map((l) => [l.key, l.amount, l.hole?.kind ?? null])).toEqual([
      ["scope:q_scopes:S1", 300, null],
      ["typed:c1", 0, "zero"],
    ]);
    expect(s.stamp).toMatch(/^[0-9a-f]{8}$/);
  });
  it("nothing priced and no hole: plain; Estimates off: plain", async () => {
    world({ visit: { scopes: [], typed: [] } });
    expect(await readWonSheet(VISIT)).toMatchObject({ ok: true, state: "plain", why: "nothing_priced" });
    state.estimatesOn = false;
    world();
    expect(await readWonSheet(VISIT)).toMatchObject({ ok: true, state: "plain", why: "estimates_off" });
  });
  it("Not Sold names its one way back; a cancelled one is refused; a work visit is no sale", async () => {
    world({ visit: { outcome: "lost" } });
    expect(await readWonSheet(VISIT)).toEqual({ ok: false, error: "This inspection is marked Not Sold. Tap Change on it and Clear the Answer first." });
    world({ visit: { status: "cancelled" } });
    expect(await readWonSheet(VISIT)).toMatchObject({ ok: false });
    world({ visit: { type: "job" } });
    // cn-v1176 fix F2 (re-worded): the estimate visit is a sale the sheet takes too.
    expect(await readWonSheet(VISIT)).toEqual({ ok: false, error: "Only an inspection or an estimate visit can be won here." });
  });
  it("an estimate behind the visit shows its OWN stored lines and totals; a $0 line on it is a hole", async () => {
    world({
      visit: { capture: { quote_id: OTHER } },
      quotes: [{ id: OTHER, org_id: ORG, quote_number: "E-901", status: "sent", job_id: null, total: 525, subtotal: 500, tax: 25, tax_rate: 0.05, doc_type: "quote", inquiry_id: "lead-1", customer_id: "c-lead" }],
      items: [
        { id: "l1", org_id: ORG, quote_id: OTHER, description: "Panel swap", quantity: 1, unit: "ea", unit_price: 500, line_total: 500, sort_order: 0 },
        { id: "l2", org_id: ORG, quote_id: OTHER, description: "Permit", quantity: 1, unit: "ea", unit_price: 0, line_total: 0, sort_order: 1 },
      ],
    });
    const s = await readWonSheet(VISIT);
    expect(s).toMatchObject({ ok: true, state: "estimate", source: "existing", quote: { id: OTHER, number: "E-901" }, total: 525, tax: 25, taxRate: 0.05, billingKind: "fixed" });
    if (!s.ok || s.state !== "estimate") throw new Error("not an estimate");
    expect(s.lines.map((l) => [l.key, l.hole?.kind ?? null])).toEqual([["line:l1", null], ["line:l2", "zero"]]);
  });
  it("the reads name their columns (projection law)", () => {
    const src = readFileSync("src/app/(app)/appointments/won-actions.ts", "utf8");
    expect(src).toContain('const QUOTE_FACT_COLS = "id, quote_number, status, job_id, total, subtotal, tax, tax_rate, doc_type, customer_id, inquiry_id, created_at" as const;');
    expect(src).toContain('.select("id, description, quantity, unit, unit_price, line_total, sort_order")');
    expect(src).not.toMatch(/\.select\("\*/);
    // a "use server" file exports only async functions
    expect(src.match(/^export (?!async function|type )/gm)).toBeNull();
  });
});

describe("approve: the visit's lines", () => {
  async function shown() {
    const s = await readWonSheet(VISIT);
    if (!s.ok || s.state !== "estimate") throw new Error("not an estimate");
    return s;
  }
  it("saves once, accepts once in person with the billing kind, marks the booked inspection done, answers the stored total and the job", async () => {
    world();
    const s = await shown();
    const res = await approveVisitEstimate({ appointmentId: VISIT, quoteId: QID, stamp: s.stamp, overrides: [{ key: "typed:c1", unitPrice: 85 }], billingType: "fixed" });
    expect(res).toEqual({ ok: true, quote: { id: QID, number: "E-900" }, total: 385, job: { id: "job-900", number: "J-900" }, warnings: [] });
    expect(spies.save).toHaveBeenCalledTimes(1);
    const input = spies.save.mock.calls[0][0];
    expect(input).toMatchObject({ id: QID, capture_appointment_id: VISIT, inquiry_id: "lead-1", customer_id: "c-lead", doc_type: "quote", tax_rate: 0 });
    expect(input.items.map((i: any) => [i.description, i.quantity, i.unit_price])).toEqual([
      ["Service upgrade, 200A", 2, 150],
      ["Weatherhead", 1, 85],
    ]);
    expect(spies.accept).toHaveBeenCalledTimes(1);
    expect(spies.accept).toHaveBeenCalledWith(QID, "accepted", { billingType: "fixed", inPerson: true });
    expect(spies.done).toHaveBeenCalledWith(VISIT, "completed");
    expect(visitRow()).toMatchObject({ status: "completed", outcome: "won", job_id: "job-900" });
  });
  it("a second call is harmless: no second estimate, no second acceptance, the same job", async () => {
    world();
    const s = await shown();
    const input = { appointmentId: VISIT, quoteId: QID, stamp: s.stamp, overrides: [{ key: "typed:c1", remove: true }], billingType: "tm" as const };
    const first = await approveVisitEstimate(input);
    const second = await approveVisitEstimate(input);
    expect(second).toEqual(first);
    expect(spies.save).toHaveBeenCalledTimes(1);
    expect(spies.accept).toHaveBeenCalledTimes(1);
    expect(state.db.tables.quotes).toHaveLength(1);
    expect(state.db.tables.jobs).toHaveLength(1);
  });
  it("a stale stamp asks for a fresh read; a hole left, a bad number, every line removed refuse; nothing is written", async () => {
    world();
    const s = await shown();
    const base = { appointmentId: VISIT, quoteId: QID, billingType: "tm" as const };
    expect(await approveVisitEstimate({ ...base, stamp: "deadbeef", overrides: [{ key: "typed:c1", remove: true }] })).toEqual({
      ok: false,
      error: "The inspection changed since this was shown. Look again.",
      reread: true,
    });
    expect(await approveVisitEstimate({ ...base, stamp: s.stamp, overrides: [] })).toEqual({ ok: false, error: "Give every line a price or remove it first.", reread: false });
    expect(await approveVisitEstimate({ ...base, stamp: s.stamp, overrides: [{ key: "typed:c1", unitPrice: -4 }] })).toMatchObject({ ok: false, reread: false });
    expect(await approveVisitEstimate({ ...base, stamp: s.stamp, overrides: [{ key: "typed:c1", quantity: Number.POSITIVE_INFINITY, unitPrice: 4 }] })).toMatchObject({ ok: false });
    // cn-v1176 fix F5 (re-pinned): a priced line is read-only, so removing it is a sheet out of date.
    expect(
      await approveVisitEstimate({ ...base, stamp: s.stamp, overrides: [{ key: "typed:c1", remove: true }, { key: "scope:q_scopes:S1", remove: true }] }),
    ).toEqual({ ok: false, error: "The inspection changed since this was shown. Look again.", reread: true });
    expect(spies.save).not.toHaveBeenCalled();
    expect(spies.accept).not.toHaveBeenCalled();
    // Every hole row removed where nothing was priced: no line is left to approve.
    world({ visit: { scopes: [] } });
    const holesOnly = await shown();
    expect(await approveVisitEstimate({ ...base, stamp: holesOnly.stamp, overrides: [{ key: "typed:c1", remove: true }] })).toEqual({
      ok: false,
      error: "Keep at least one priced line.",
      reread: false,
    });
    expect(spies.save).not.toHaveBeenCalled();
  });
  it("cn-v1176 fix F4 (re-pinned): a row under the sent id that the visit's backlink does not name is never accepted or written over; another row's id is never written over", async () => {
    // Was: an accepted lead-less row under the id was accepted again. With a lead-less visit any
    // lead-less estimate of the company passed; only the visit's own capture backlink names its row now.
    world({ visit: { inquiry_id: null }, quotes: [{ id: QID, org_id: ORG, quote_number: "E-900", status: "accepted", job_id: null, inquiry_id: null, total: 300 }] });
    const s = await shown();
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: QID, stamp: s.stamp, overrides: [{ key: "typed:c1", remove: true }], billingType: "tm" })).toEqual({
      ok: false,
      error: "This sheet is out of date. Close it and open it again.",
      reread: true,
    });
    expect(spies.save).not.toHaveBeenCalled();
    expect(spies.accept).not.toHaveBeenCalled();
    // A lead-less DRAFT of the same company under the sent id: never overwritten.
    world({ visit: { inquiry_id: null }, quotes: [{ id: OTHER, org_id: ORG, quote_number: "E-778", status: "draft", job_id: null, inquiry_id: null, total: 10 }] });
    const s1 = await shown();
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: s1.stamp, overrides: [{ key: "typed:c1", remove: true }], billingType: "tm" })).toMatchObject({
      ok: false,
      error: "This sheet is out of date. Close it and open it again.",
      reread: true,
    });
    expect(quoteRow(OTHER)).toMatchObject({ status: "draft", total: 10 });
    expect(spies.save).not.toHaveBeenCalled();
    expect(spies.accept).not.toHaveBeenCalled();

    world({ quotes: [{ id: OTHER, org_id: ORG, quote_number: "E-777", status: "sent", job_id: null, inquiry_id: "lead-other", total: 10 }] });
    const s2 = await shown();
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: s2.stamp, overrides: [{ key: "typed:c1", remove: true }], billingType: "tm" })).toMatchObject({
      ok: false,
      reread: true,
    });
    expect(spies.save).not.toHaveBeenCalled();
  });
  it("a save that worked and an acceptance that failed: said, and the next read shows that draft as the estimate that stands", async () => {
    world();
    const s = await shown();
    state.acceptFails = true;
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: QID, stamp: s.stamp, overrides: [{ key: "typed:c1", remove: true }], billingType: "tm" })).toEqual({
      ok: false,
      error: "The estimate is saved as a draft, but it wasn't approved: the network dropped",
      reread: true,
    });
    expect(await readWonSheet(VISIT)).toMatchObject({ ok: true, state: "estimate", source: "existing", quote: { id: QID } });
  });
});

describe("cn-v1176 fixes on the approve door", () => {
  async function shown() {
    const s = await readWonSheet(VISIT);
    if (!s.ok || s.state !== "estimate") throw new Error("not an estimate");
    return s;
  }
  it("F4: a retry of the same opening lands on its own row (the first save made the row and the backlink together): never a second estimate", async () => {
    world();
    const s = await shown();
    const input = { appointmentId: VISIT, quoteId: QID, stamp: s.stamp, overrides: [{ key: "typed:c1", remove: true }], billingType: "tm" as const };
    state.acceptFails = true;
    expect(await approveVisitEstimate(input)).toMatchObject({ ok: false, reread: true });
    expect(visitRow().capture).toMatchObject({ quote_id: QID });
    // The stand-in save keeps no lines; the real one stores what it was handed.
    state.db.tables.quote_line_items.push({ id: "l-s1", org_id: ORG, quote_id: QID, description: "Service upgrade, 200A", quantity: 2, unit: "EA", unit_price: 150, line_total: 300, sort_order: 0 });
    state.acceptFails = false;
    // The same tap again: the sheet is told to read again (the draft now stands behind the visit), nothing saved twice.
    expect(await approveVisitEstimate(input)).toEqual({ ok: false, error: "The inspection changed since this was shown. Look again.", reread: true });
    const again = await readWonSheet(VISIT);
    expect(again).toMatchObject({ ok: true, state: "estimate", source: "existing", quote: { id: QID } });
    if (!again.ok || again.state !== "estimate") throw new Error("not an estimate");
    const last = await approveVisitEstimate({ ...input, stamp: again.stamp, overrides: [] });
    expect(last, JSON.stringify(last)).toMatchObject({ ok: true, quote: { id: QID }, job: { id: "job-900" } });
    expect(spies.save).toHaveBeenCalledTimes(1);
    expect(state.db.tables.quotes).toHaveLength(1);
    expect(state.db.tables.jobs).toHaveLength(1);
  });
  it("F5: an override on a PRICED line (shown read-only) is refused; nothing is written", async () => {
    world();
    const s = await shown();
    for (const o of [{ key: "scope:q_scopes:S1", quantity: 3 }, { key: "scope:q_scopes:S1", unitPrice: 1 }, { key: "scope:q_scopes:S1", remove: true }, { key: "made:up", unitPrice: 5 }]) {
      expect(
        await approveVisitEstimate({ appointmentId: VISIT, quoteId: QID, stamp: s.stamp, overrides: [{ key: "typed:c1", unitPrice: 85 }, o], billingType: "tm" }),
        JSON.stringify(o),
      ).toEqual({ ok: false, error: "The inspection changed since this was shown. Look again.", reread: true });
    }
    expect(spies.save).not.toHaveBeenCalled();
    expect(spies.accept).not.toHaveBeenCalled();
  });
  it("F3: a typed row with a price but a 0 quantity is still a hole: refused until its quantity is given", async () => {
    world({ visit: { typed: [{ id: "c1", description: "Weatherhead", quantity: 0, unit: "ea" }] } });
    const s = await shown();
    expect(s.lines.find((l) => l.key === "typed:c1")?.hole).toEqual({ kind: "zero", flag: null });
    const base = { appointmentId: VISIT, quoteId: QID, stamp: s.stamp, billingType: "tm" as const };
    expect(await approveVisitEstimate({ ...base, overrides: [{ key: "typed:c1", unitPrice: 50 }] })).toEqual({ ok: false, error: "Give every line a price or remove it first.", reread: false });
    expect(spies.save).not.toHaveBeenCalled();
    expect(await approveVisitEstimate({ ...base, overrides: [{ key: "typed:c1", quantity: 2, unitPrice: 50 }] })).toMatchObject({ ok: true, total: 400 });
  });
  it("F7: an estimate that stands with NO lines is a hole, naming one action on it; nothing is accepted", async () => {
    world({
      visit: { capture: { quote_id: OTHER } },
      quotes: [{ id: OTHER, org_id: ORG, quote_number: "E-901", status: "sent", job_id: null, total: 0, subtotal: 0, tax: 0, tax_rate: 0, doc_type: "estimate", inquiry_id: "lead-1", customer_id: "c-lead" }],
      items: [],
    });
    const s = await shown();
    expect(s.lines).toEqual([]);
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: s.stamp, overrides: [], billingType: "tm" })).toEqual({
      ok: false,
      error: "E-901 has no lines. Open E-901 and add them first.",
      reread: false,
    });
    expect(spies.accept).not.toHaveBeenCalled();
  });
  it("U1: two office people on one visit: a job made, or another estimate tied, since the decision stops before the acceptance", async () => {
    world();
    let s = await shown();
    const base = { appointmentId: VISIT, quoteId: QID, overrides: [{ key: "typed:c1", remove: true }], billingType: "tm" as const };
    const save = spies.save.getMockImplementation()!;
    spies.save.mockImplementationOnce(async (input: any) => {
      const r = await save(input);
      visitRow().job_id = "job-other"; // the other person's job lands between the save and the acceptance
      return r;
    });
    expect(await approveVisitEstimate({ ...base, stamp: s.stamp })).toEqual({ ok: false, error: "This inspection already has its job.", reread: true });
    expect(spies.accept).not.toHaveBeenCalled();

    world();
    s = await shown();
    spies.save.mockImplementationOnce(async (input: any) => {
      const r = await save(input);
      visitRow().capture = { ...visitRow().capture, quote_id: OTHER }; // the other person's estimate took the backlink
      return r;
    });
    expect(await approveVisitEstimate({ ...base, stamp: s.stamp })).toEqual({ ok: false, error: "This inspection's estimate is a different one now. Look again.", reread: true });
    expect(spies.accept).not.toHaveBeenCalled();
  });
  it("U2: an estimate that stands says no customer when ITS job will have none (the estimate's customer, else its lead's), whatever the visit has", async () => {
    const standing = (quote: Record<string, unknown>) => ({
      visit: { customer_id: "c-visit", capture: { quote_id: OTHER } },
      quotes: [{ id: OTHER, org_id: ORG, quote_number: "E-901", status: "sent", job_id: null, total: 500, subtotal: 500, tax: 0, tax_rate: 0, doc_type: "estimate", ...quote }],
      items: [{ id: "l1", org_id: ORG, quote_id: OTHER, description: "Panel swap", quantity: 1, unit: "ea", unit_price: 500, line_total: 500, sort_order: 0 }],
    });
    world(standing({ customer_id: null, inquiry_id: null }));
    expect(await readWonSheet(VISIT)).toMatchObject({ state: "estimate", source: "existing", noCustomer: true });
    world(standing({ customer_id: null, inquiry_id: "lead-1" }));
    expect(await readWonSheet(VISIT)).toMatchObject({ state: "estimate", source: "existing", noCustomer: false });
    world(standing({ customer_id: "c-quote", inquiry_id: null }));
    expect(await readWonSheet(VISIT)).toMatchObject({ state: "estimate", source: "existing", noCustomer: false });
    // Another lead with nothing to make a customer from.
    world(standing({ customer_id: null, inquiry_id: "lead-2" }));
    state.db.tables.inquiries.push({ id: "lead-2", org_id: ORG, customer_id: null, name: " ", company_name: null });
    expect(await readWonSheet(VISIT)).toMatchObject({ state: "estimate", source: "existing", noCustomer: true });
  });
  it("F9: a stale approve on the refer state reads again, naming the Tie button by its exact words", async () => {
    world({ quotes: [{ id: OTHER, org_id: ORG, quote_number: "E-901", status: "accepted", job_id: "job-777", total: 500, inquiry_id: "lead-1", customer_id: "c-lead", created_at: "2026-11-20T00:00:00.000Z" }] });
    state.db.tables.jobs.push({ id: "job-777", org_id: ORG, job_number: "J-900" });
    expect(await readWonSheet(VISIT)).toMatchObject({ ok: true, state: "refer", job: { id: "job-777", number: "J-900" } });
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: "", overrides: [], billingType: "tm" })).toEqual({
      ok: false,
      error: "E-901 is already accepted and has its job, J-900: tap Tie This Inspection to J-900.",
      reread: true,
    });
    state.lang = "es";
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: "", overrides: [], billingType: "tm" })).toMatchObject({
      error: "E-901 ya está aceptado y tiene su trabajo, J-900: toca Unir Esta Inspección a J-900.",
    });
    expect(spies.accept).not.toHaveBeenCalled();
  });
});

describe("approve: an estimate that stands, and finish", () => {
  const standing = (status: string, price = 500) => ({
    visit: { capture: { quote_id: OTHER } },
    quotes: [{ id: OTHER, org_id: ORG, quote_number: "E-901", status, job_id: null, total: price, subtotal: price, tax: 0, tax_rate: 0, doc_type: "estimate", inquiry_id: "lead-1", customer_id: "c-lead" }],
    items: [{ id: "l1", org_id: ORG, quote_id: OTHER, description: "Panel swap", quantity: 1, unit: "ea", unit_price: price, line_total: price, sort_order: 0 }],
  });
  it("the estimate that stands is the one approved: nothing saved, accepted once, never a second estimate", async () => {
    world(standing("sent"));
    const s = await readWonSheet(VISIT);
    if (!s.ok || s.state !== "estimate") throw new Error("not an estimate");
    const res = await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: s.stamp, overrides: [], billingType: "tm" });
    expect(res).toMatchObject({ ok: true, quote: { id: OTHER, number: "E-901" }, total: 500, job: { number: "J-900" } });
    expect(spies.save).not.toHaveBeenCalled();
    expect(spies.accept).toHaveBeenCalledWith(OTHER, "accepted", { billingType: "tm", inPerson: true });
    expect(state.db.tables.quotes).toHaveLength(1);
  });
  it("a $0 line on it refuses, naming one action on that estimate", async () => {
    world(standing("draft", 0));
    const s = await readWonSheet(VISIT);
    if (!s.ok || s.state !== "estimate") throw new Error("not an estimate");
    expect(await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: s.stamp, overrides: [], billingType: "tm" })).toEqual({
      ok: false,
      error: "E-901 has a line with no price. Open E-901 and price it.",
      reread: false,
    });
    expect(spies.accept).not.toHaveBeenCalled();
  });
  it("accepted with no job: finish accepts it again (the job is made once); a visit with a job answers has_job", async () => {
    world(standing("accepted"));
    // The billing kind the accepted estimate's own word says (doc_type "estimate" = time and material).
    expect(await readWonSheet(VISIT)).toEqual({ ok: true, state: "finish", quote: { id: OTHER, number: "E-901" }, total: 500, billingKind: "tm" });
    const res = await approveVisitEstimate({ appointmentId: VISIT, quoteId: OTHER, stamp: "", overrides: [], billingType: "tm" });
    expect(res).toMatchObject({ ok: true, job: { id: "job-900" } });
    expect(await readWonSheet(VISIT)).toEqual({ ok: true, state: "has_job", job: { id: "job-900", number: "J-900" } });
  });
  it("finish on a Quote says fixed: the kind its own document type says", async () => {
    const w = standing("accepted");
    w.quotes[0].doc_type = "quote";
    world(w);
    expect(await readWonSheet(VISIT)).toMatchObject({ ok: true, state: "finish", billingKind: "fixed" });
  });
});
