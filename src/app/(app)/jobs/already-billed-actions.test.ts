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
 *     draft instead of offering it, leaves the deposit out, and refuses a fixed-price job.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "u-erik", orgId: "org-et" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { alreadyBilledSheet, markAlreadyBilled, unmarkAlreadyBilled } from "./already-billed-actions";
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

function sheetRoute(o: { billing?: string; invoicesError?: any } = {}) {
  return (table: string, cols: string): Reply => {
    if (table === "jobs") return { data: { id: J010, job_number: "J-010", name: "11301 Purple Sage", customer_id: "c0000000-0000-4000-8000-000000000001", billing_type: o.billing ?? "tm" } };
    if (table === "payment_milestones") return { data: [] };
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles", features: { shop_stock: true } } } };
    if (table === "invoices") return o.invoicesError ? { error: o.invoicesError } : { data: INVOICES };
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
    expect(res.undo).toEqual({ jobId: J010, lineId: "li-mat", ids: ["bill-ps"], what: "Consolidated Electrical Distributors 8802-1101475" });
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
  });

  it("Purple Sage's sheet: INV-00023's typed Materials line, picked; the draft said, the deposit left out; the bill at what it cost this job", async () => {
    state.client = fake(sheetRoute(), calls);
    const res = await alreadyBilledSheet(J010, { kind: "bill", ids: ["bill-ps"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.invoices.map((i) => i.invoice.invoice_number)).toEqual(["INV-00023"]);
    expect(res.data.invoices[0].preselect).toBe("li-mat");
    expect(res.data.drafts).toEqual(["INV-081 is still a draft: Add To INV-081 puts it there."]);
    // $186.93 less the GFCIs the shelf took ($134.64 - $84.15 = $50.49), with its tax share.
    expect(res.data.target.cost).toBeLessThan(186.93);
    expect(res.data.target.billHasLines).toBe(true);
    expect(res.data.shopStock).toBe(true);
    expect(res.data.target.words).toBe("Consolidated Electrical Distributors 8802-1101475");
  });

  it("a fixed-price job is refused in words: nothing on it is marked line by line", async () => {
    state.client = fake(sheetRoute({ billing: "fixed" }), calls);
    const res = await alreadyBilledSheet("j-003", { kind: "bill", ids: ["bill-ps"] });
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/billed by its contract/);
  });
});
