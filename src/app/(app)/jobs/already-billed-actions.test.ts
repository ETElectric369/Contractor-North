import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ALREADY BILLED'S SERVER HALF (0357): safe before the migration, plain words after it.
 *
 *   - a database without 0357 (no hand_claims column, no function) says "needs an update" and
 *     writes nothing, never a crash;
 *   - a mark that lands is read back from the function's own answer and said with its Undo; one that
 *     comes back empty is "didn't save", never a quiet success;
 *   - the function's own refusal reaches the office in its own words;
 *   - the sheet offers Purple Sage's paid INV-00023 with its typed Materials line picked, says the
 *     draft instead of offering it, leaves the deposit out; J-010 is fixed-price with no estimate,
 *     so New Invoice bills its actuals and the sheet opens there, and it refuses a job whose live
 *     estimate is the contract (New Invoice's own rule).
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "u-erik", orgId: "org-et" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { alreadyBilledSheet, markAlreadyBilled, noJobHoursSheet, unmarkAlreadyBilled } from "./already-billed-actions";
import { revalidatePath } from "next/cache";
import { NEEDS_UPDATE } from "@/lib/already-billed";

type Reply = { data?: any; error?: any };
function fake(route: (table: string, cols: string, rpcArgs?: any) => Reply, calls: { table: string; cols: string; args?: any }[] = []) {
  return {
    rpc(fn: string, args: any) {
      calls.push({ table: `rpc:${fn}`, cols: "", args });
      const r = route(`rpc:${fn}`, "", args);
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
    from(table: string) {
      let cols = "";
      const answer = () => {
        calls.push({ table, cols });
        const r = route(table, cols);
        return { data: r.data ?? null, error: r.error ?? null };
      };
      const chain: any = {
        select(c?: string) {
          cols = c ?? "";
          return chain;
        },
        maybeSingle: () => Promise.resolve(answer()),
        single: () => Promise.resolve(answer()),
        then: (res: any, rej: any) => {
          try {
            res(answer());
          } catch (e) {
            rej?.(e);
          }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "or", "order", "limit", "overlaps", "contains"]) chain[m] = () => chain;
      return chain;
    },
  };
}

/** J-010, 11301 Purple Sage (ids are uuids: they go into the invoices filter). */
const J010 = "0100aaaa-0000-4000-8000-000000000010";

const PS_BILL = {
  id: "bill-ps",
  supplier: "Consolidated Electrical Distributors",
  bill_number: "8802-1101475",
  supplier_invoice_number: "8802-1101475",
  amount: 186.93,
  bill_date: "2026-06-16",
  job_id: J010,
  bill_line_items: [
    { id: "l1", description: "15A 125V GFCI RCPT (1597TRW)", quantity: 8, unit_price: 16.83, amount: 134.64, category: "Materials", billable: true, billed_amount: 84.15 },
    { id: "l2", description: "Everything else", quantity: 1, unit_price: 36.86, amount: 36.86, category: "Materials", billable: true, billed_amount: null },
    { id: "l3", description: "Sales Tax", quantity: 1, unit_price: 15.43, amount: 15.43, category: "Tax", billable: true, billed_amount: null },
  ],
};
const line = (id: string, description: string, line_total: number, o: Record<string, unknown> = {}) => ({
  id,
  description,
  quantity: 1,
  unit: "ea",
  unit_price: line_total,
  line_total,
  import_source: null,
  import_key: null,
  edited: false,
  line_kind: null,
  sort_order: 0,
  hand_claims: [],
  ...o,
});
const INVOICES = [
  { id: "inv-23", invoice_number: "INV-00023", status: "paid", invoice_kind: "standard", job_id: J010, created_at: "2026-06-22T04:57:19Z", invoice_items: [line("li-mat", "Materials", 110)] },
  { id: "inv-81", invoice_number: "INV-081", status: "draft", invoice_kind: "standard", job_id: J010, created_at: "2026-09-25T00:00:00Z", invoice_items: [line("li-d", "Materials", 50)] },
  { id: "inv-dep", invoice_number: "INV-00020", status: "paid", invoice_kind: "deposit", job_id: J010, created_at: "2026-06-01T00:00:00Z", invoice_items: [line("li-dep", "Deposit", 500)] },
];

/** J-010 as it stands on production: fixed price, no estimate, no schedule, billed from its actuals. */
function sheetRoute(
  o: { billing?: string; invoicesError?: any; quotes?: { id: string; status: string }[]; milestones?: number; invoices?: any[]; drawLines?: { import_source: string | null }[] } = {},
) {
  return (table: string, cols: string): Reply => {
    if (table === "jobs") return { data: { id: J010, job_number: "J-010", name: "11301 Purple Sage", customer_id: "c0000000-0000-4000-8000-000000000001", billing_type: o.billing ?? "fixed" } };
    if (table === "payment_milestones") return { data: Array.from({ length: o.milestones ?? 0 }, (_, i) => ({ id: `m${i}` })) };
    if (table === "quotes") return { data: o.quotes ?? [] };
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles", features: { shop_stock: true } } } };
    if (table === "invoices") {
      if (o.invoicesError) return { error: o.invoicesError };
      // openDraftOnJob: the job's drafts, then (for a standard one) whether a draw is live beside it.
      if (cols.includes("dismissed_import_keys")) return { data: (o.invoices ?? INVOICES).filter((i) => i.status === "draft") };
      if (cols === "id") return { data: (o.invoices ?? INVOICES).filter((i) => i.status !== "void" && i.invoice_kind !== "standard") };
      return { data: o.invoices ?? INVOICES };
    }
    if (table === "invoice_items" && cols === "import_source") return { data: o.drawLines ?? [] };
    if (table === "bills") return { data: PS_BILL };
    throw new Error(`unrouted ${table} [${cols}]`);
  };
}

let calls: { table: string; cols: string; args?: any }[];
beforeEach(() => {
  calls = [];
});

describe("before 0357 is applied", () => {
  it("Mark says it needs an update and writes nothing", async () => {
    state.client = fake(() => ({ error: { code: "PGRST202", message: "Could not find the function public.mark_already_billed(p_ids, p_line) in the schema cache" } }), calls);
    const res = await markAlreadyBilled({ jobId: J010, lineId: "li-mat", ids: ["bill-ps"], what: "CED 8802-1101475" });
    expect(res).toMatchObject({ ok: false, error: NEEDS_UPDATE, needsUpdate: true });
  });

  it("Not Billed After All says the same", async () => {
    state.client = fake(() => ({ error: { code: "42883", message: "function public.unmark_already_billed(uuid, uuid[]) does not exist" } }), calls);
    expect(await unmarkAlreadyBilled({ jobId: J010, lineId: "li-mat", ids: ["bill-ps"], what: "x" })).toMatchObject({ ok: false, error: NEEDS_UPDATE });
  });

  it("the sheet says it needs an update (no hand_claims column), with nothing offered", async () => {
    state.client = fake(sheetRoute({ invoicesError: { code: "42703", message: "column invoice_items_1.hand_claims does not exist" } }), calls);
    expect(await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] })).toEqual({ ok: false, error: NEEDS_UPDATE, needsUpdate: true });
  });
});

describe("after it", () => {
  it("a mark that lands is said with what, where, that nothing changed, and its Undo", async () => {
    state.client = fake(
      () => ({ data: { line_id: "li-mat", invoice_id: "inv-23", invoice_number: "INV-00023", description: "Materials", line_total: "110.00", added: ["bill-ps"] } }),
      calls,
    );
    const res = await markAlreadyBilled({ jobId: J010, lineId: "li-mat", ids: ["bill-ps"], what: "Consolidated Electrical Distributors 8802-1101475" });
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Consolidated Electrical Distributors 8802-1101475 is billed on INV-00023 (Materials $110.00). Nothing on INV-00023 changed.");
    // Its Undo takes off exactly what it added (whole: false), never an earlier mark of the same shift.
    expect(res.undo).toEqual({ jobId: J010, lineId: "li-mat", ids: ["bill-ps"], what: "Consolidated Electrical Distributors 8802-1101475", whole: false });
    expect(calls.find((c) => c.table === "rpc:mark_already_billed")?.args).toEqual({ p_line: "li-mat", p_ids: ["bill-ps"] });
  });

  it("an empty answer is 'didn't save', never a quiet success", async () => {
    state.client = fake(() => ({ data: null }), calls);
    const res = await markAlreadyBilled({ jobId: J010, lineId: "li-mat", ids: ["bill-ps"], what: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/didn't save/);
  });

  it("the function's refusal is the office's sentence", async () => {
    state.client = fake(() => ({ error: { code: "P0001", message: "INV-081 is still a draft: Add To INV-081 puts it there. Nothing was changed." } }), calls);
    expect((await markAlreadyBilled({ jobId: J010, lineId: "li-d", ids: ["bill-ps"], what: "x" })).error).toBe(
      "INV-081 is still a draft: Add To INV-081 puts it there. Nothing was changed.",
    );
  });

  it("Undo is only what a person added, said as back in Not Billed Yet", async () => {
    state.client = fake(() => ({ data: { line_id: "li-mat", invoice_id: "inv-23", invoice_number: "INV-00023", removed: ["bill-ps"] } }), calls);
    const res = await unmarkAlreadyBilled({ jobId: J010, lineId: "li-mat", ids: ["bill-ps"], what: "CED 8802-1101475" });
    expect(res.message).toBe("CED 8802-1101475 is off INV-00023 and back in Not Billed Yet. Nothing on INV-00023 changed.");
    // Not Billed After All takes a split shift off whole (p_whole true)...
    expect(calls.find((c) => c.table === "rpc:unmark_already_billed")?.args).toEqual({ p_line: "li-mat", p_ids: ["bill-ps"], p_whole: true });
  });

  it("a mark's own Undo asks for exactly what it added (p_whole false)", async () => {
    state.client = fake(() => ({ data: { line_id: "li-b", invoice_id: "inv-59", invoice_number: "INV-059", removed: ["t2"] } }), calls);
    await unmarkAlreadyBilled({ jobId: J010, lineId: "li-b", ids: ["t2"], what: "3 h of Brian Taylor's time", whole: false });
    expect(calls.find((c) => c.table === "rpc:unmark_already_billed")?.args).toEqual({ p_line: "li-b", p_ids: ["t2"], p_whole: false });
  });

  it("when more came off than was named (the rest of a split shift), the sentence names what came off", async () => {
    state.client = fake(
      (table) =>
        table === "time_entries"
          ? {
              data: [
                { id: "t1", clock_in: "2026-08-10T15:00:00Z", clock_out: "2026-08-10T19:00:00Z", lunch_minutes: 0, profiles: { full_name: "Brian Taylor" } },
                { id: "t2", clock_in: "2026-08-10T19:00:00Z", clock_out: "2026-08-10T21:30:00Z", lunch_minutes: 0, profiles: { full_name: "Brian Taylor" } },
              ],
            }
          : { data: { line_id: "li-b", invoice_id: "inv-59", invoice_number: "INV-059", removed: ["t2", "t1"] } },
      calls,
    );
    const res = await unmarkAlreadyBilled({ jobId: J010, lineId: "li-b", ids: ["t2"], what: "2.5 h of Brian Taylor's time" });
    expect(res.message).toBe("6.5 h of Brian Taylor's time is off INV-059 and back in Not Billed Yet. Nothing on INV-059 changed.");
    expect(res.undo).toEqual({ jobId: J010, lineId: "li-b", ids: ["t2", "t1"], what: "6.5 h of Brian Taylor's time" });
  });

  it("Purple Sage's sheet: INV-00023's typed Materials line, picked; the draft said, the deposit left out; the bill at what it cost this job", async () => {
    state.client = fake(sheetRoute(), calls);
    const res = await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.invoices.map((i) => i.invoice.invoice_number)).toEqual(["INV-00023"]);
    expect(res.data.invoices[0].preselect).toBe("li-mat");
    // A live deposit sits beside the standard draft, so New Invoice would bill a progress report,
    // not that draft (H4): the sheet names no Add To button there.
    expect(res.data.drafts).toEqual(["INV-081 is still a draft: open it to add this there."]);
    // $186.93 less the GFCIs the shelf took ($134.64 - $84.15 = $50.49), with its tax share.
    expect(res.data.target.cost).toBeLessThan(186.93);
    expect(res.data.target.billHasLines).toBe(true);
    expect(res.data.shopStock).toBe(true);
    expect(res.data.target.words).toBe("Consolidated Electrical Distributors 8802-1101475");
  });

  it("hours: each line carries the hours of the job's shifts it already holds, and only open shifts are listed", async () => {
    const withLabor = [
      {
        ...INVOICES[0],
        invoice_items: [
          ...INVOICES[0].invoice_items,
          line("li-erik", "Labor — Erik", 950, { quantity: 10, unit: "hr", unit_price: 95, import_source: "labor", import_key: "labor:p-erik", edited: true, source_ids: ["t-held"] }),
        ],
      },
    ];
    const shift = (id: string, from: string, to: string) => ({ id, clock_in: from, clock_out: to, lunch_minutes: 0, job_code: null, split_from: null, profiles: { id: "p-erik", full_name: "Erik Taylor" } });
    const base = sheetRoute();
    state.client = fake((table, cols) => {
      if (table === "invoices") return { data: withLabor };
      if (table === "time_entries") return { data: [shift("t-held", "2026-06-16T15:00:00Z", "2026-06-16T23:00:00Z"), shift("t-free", "2026-06-17T15:00:00Z", "2026-06-17T19:00:00Z")] };
      if (table === "job_codes" || table === "profile_pay" || table === "invoice_items") return { data: [] };
      return base(table, cols);
    }, calls);
    const res = await alreadyBilledSheet(J010, { kind: "time", ids: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const erik = res.data.invoices.flatMap((i) => i.invoice.lines).find((l) => l.id === "li-erik");
    expect(erik?.heldHours).toBe(8);
    expect(res.data.entries.map((e) => e.id)).toEqual(["t-free"]);
    expect(res.data.entries[0].family).toBe("t-free");
  });

  it("a draft is said with the door that is there: Add To only where New Invoice lands, never on a deposit", async () => {
    state.client = fake(sheetRoute({ invoices: [INVOICES[0], { ...INVOICES[1], dismissed_import_keys: null, quote_id: null }] }), calls);
    const plain = await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] });
    expect(plain.ok && plain.data.drafts).toEqual(["INV-081 is still a draft: Add To INV-081 puts it there."]);
    const deposit = { id: "inv-dep-d", invoice_number: "INV-090", status: "draft", invoice_kind: "deposit", job_id: J010, created_at: "2026-09-25T00:00:00Z", dismissed_import_keys: null, quote_id: null, invoice_items: [line("li-dd", "Deposit", 1000)] };
    state.client = fake(sheetRoute({ invoices: [INVOICES[0], deposit] }), calls);
    let res = await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] });
    expect(res.ok && res.data.drafts).toEqual(["INV-090 is a set amount, so this goes on the next bill."]);
    // A T&M draft with the estimate copied onto it takes no new work: open it, never Add To.
    const fromQuote = { ...INVOICES[1], quote_id: "q1", dismissed_import_keys: null };
    state.client = fake((table, cols) => (table === "jobs" && cols === "billing_type" ? { data: { billing_type: "tm" } } : sheetRoute({ billing: "tm", invoices: [INVOICES[0], fromQuote] })(table, cols)), calls);
    res = await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] });
    expect(res.ok && res.data.drafts).toEqual(["INV-081 is still a draft: open it to add this there."]);
  });

  it("a fixed-price job whose live estimate is the contract, or a job on a schedule, is refused in words", async () => {
    state.client = fake(sheetRoute({ quotes: [{ id: "q1", status: "accepted" }] }), calls);
    const res = await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] });
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/billed by its contract/);
    state.client = fake(sheetRoute({ billing: "tm", milestones: 2 }), calls);
    expect(await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] })).toMatchObject({ ok: false });
  });

  it("a declined estimate is no contract, and on T&M an accepted one is a guide: the sheet opens", async () => {
    state.client = fake(sheetRoute({ quotes: [{ id: "q1", status: "declined" }] }), calls);
    expect((await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] })).ok).toBe(true);
    state.client = fake(sheetRoute({ billing: "tm", quotes: [{ id: "q1", status: "accepted" }] }), calls);
    expect((await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] })).ok).toBe(true);
  });
});

/**
 * HOURS ON NO JOB (TTUSD on INV-055): the same two writes with no job behind them. They refresh
 * Timecards (the hours' home) and the invoice, never a job page; the way back says the hours are
 * back with the other hours on no job.
 */
describe("hours on no job", () => {
  it("a mark with no job lands and is said the same way; Timecards and the invoice refresh, no job page", async () => {
    const paths = revalidatePath as unknown as { mock: { calls: unknown[][] }; mockClear: () => void };
    paths.mockClear();
    state.client = fake(
      () => ({ data: { line_id: "li-jp", invoice_id: "inv-55", invoice_number: "INV-055", description: "Labor - JP Prince", line_total: "2185.00", added: ["t6"] } }),
      calls,
    );
    const res = await markAlreadyBilled({ jobId: null, lineId: "li-jp", ids: ["t6"], what: "11.5 h of JP Prince's time" });
    expect(res.ok).toBe(true);
    expect(res.message).toBe("11.5 h of JP Prince's time is billed on INV-055 (Labor - JP Prince $2,185.00). Nothing on INV-055 changed.");
    expect(res.undo).toMatchObject({ jobId: "", lineId: "li-jp", ids: ["t6"], whole: false });
    const refreshed = paths.mock.calls.map((c) => c[0]);
    expect(refreshed).toEqual(expect.arrayContaining(["/timecards", "/billing/inv-55"]));
    expect(refreshed.some((x) => String(x).startsWith("/jobs/"))).toBe(false);
  });

  it("its way back says the hours are back with the hours on no job", async () => {
    state.client = fake(() => ({ data: { line_id: "li-jp", invoice_id: "inv-55", invoice_number: "INV-055", removed: ["t6"] } }), calls);
    const res = await unmarkAlreadyBilled({ jobId: "", lineId: "li-jp", ids: ["t6"], what: "11.5 h of JP Prince's time" });
    expect(res.message).toBe("11.5 h of JP Prince's time is off INV-055 and back with the hours on no job. Nothing on INV-055 changed.");
  });

  it("the sheet is the office's: a lost read is said, never a crash", async () => {
    state.client = fake((table) => {
      if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } } };
      throw new Error("boom");
    }, calls);
    const res = await noJobHoursSheet(["t6"]);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/Couldn't open that just now|Couldn't read/);
  });
});
