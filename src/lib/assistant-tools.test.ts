import { describe, it, expect } from "vitest";
import { runDataTool } from "@/lib/assistant-tools";

/**
 * WHAT NORT IS ALLOWED TO SAY A RECEIPT COST THE CUSTOMER (cn-v967).
 *
 * Migrations 0268, 0271 and 0272 gave a supplier bill three new facts — a line the company eats, a
 * container billed in part, and a counter-ticket copy a real invoice later replaced — and every
 * cost reader in the app learned them except the two tools Erik actually asks questions of. So the
 * screens said one thing and Nort, who he trusts more because it answers in sentences, said the
 * pre-0268 thing: the Kettle Chips and the ice cream bar reported as the customer's cost, and the
 * superseded $95.27 CED ticket counted beside the bill that replaced it.
 *
 * The fixtures are his own rows, read out of the live database on 2026-09-20 (the OSH - Cupertino
 * run for Jason Waldow, bill 905c9f3d, and the IDEAL Twister box on CED bill c0535cdb), with the
 * numerics as strings because that is how PostgREST hands them back.
 */

/** Enough of the PostgREST builder for these two tools, recording the select list and the filters
 *  so a projection can be asserted on directly — the missing column IS the bug here. */
function fakeDb(result: { data: any; error?: any }) {
  const calls: { table: string | null; select: string | null; filters: string[] } = {
    table: null,
    select: null,
    filters: [],
  };
  const builder: any = {
    select(cols: string) {
      calls.select = cols;
      return builder;
    },
    is(col: string, val: unknown) {
      calls.filters.push(`is:${col}:${String(val)}`);
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.filters.push(`eq:${col}:${String(val)}`);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({
      data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
      error: result.error ?? null,
    }),
    // A query with no .maybeSingle() is awaited directly, so the builder itself is thenable.
    then: (ok: any, err: any) =>
      Promise.resolve({ data: result.data, error: result.error ?? null }).then(ok, err),
  };
  return {
    calls,
    client: {
      from(table: string) {
        calls.table = table;
        return builder;
      },
    },
  };
}

/** The OSH - Cupertino receipt, exactly as it sits in his books: $16.28, three of five lines his. */
const oshBill = {
  id: "905c9f3d-43c7-4895-abd6-5ad6e48b463b",
  supplier: "OSH - Cupertino",
  bill_number: null,
  amount: "16.28",
  status: "paid",
  category: "Materials",
  bill_date: "2026-09-18",
  notes: null,
  pricing_provisional: false,
  superseded_by_bill_id: null,
  jobs: { name: "Waldow" },
  bill_line_items: [
    { id: "30874f02", description: "Kettle Chips Salt/Pepper", quantity: "1.00", unit_price: "2.09", amount: "2.09", category: "Other", billable: false, billed_amount: null, is_stock: false },
    { id: "3646c450", description: "Kettle Chip Honey Dijon", quantity: "1.00", unit_price: "2.09", amount: "2.09", category: "Other", billable: false, billed_amount: null, is_stock: false },
    { id: "3bc58c22", description: "Bulk Fastener", quantity: "10.00", unit_price: "0.61", amount: "6.10", category: "Fasteners", billable: true, billed_amount: null, is_stock: false },
    { id: "7ca6a8e7", description: "Tax", quantity: "1.00", unit_price: "1.01", amount: "1.01", category: "Tax", billable: true, billed_amount: null, is_stock: false },
    { id: "d6715569", description: "Ice Cream Bar Choc Almond", quantity: "1.00", unit_price: "4.99", amount: "4.99", category: "Other", billable: false, billed_amount: null, is_stock: false },
  ],
};

const parse = async (tool: string, input: any, db: any) => JSON.parse(await runDataTool(tool, input, db));

describe("get_bill — the three states of a receipt line reach Nort", () => {
  it("selects the columns 0268 and 0272 added (a missing field is a missing select list)", async () => {
    const { calls, client } = fakeDb({ data: oshBill });
    await runDataTool("get_bill", { bill_id: oshBill.id }, client);
    expect(calls.table).toBe("bills");
    for (const col of ["billable", "billed_amount", "is_stock", "pricing_provisional", "superseded_by_bill_id"]) {
      expect(calls.select).toContain(col);
    }
  });

  it("does not report the snacks as the customer's cost", async () => {
    const { client } = fakeDb({ data: oshBill });
    const out = await parse("get_bill", { bill_id: oshBill.id }, client);
    const byDesc = Object.fromEntries(out.items.map((i: any) => [i.description, i]));
    expect(byDesc["Kettle Chips Salt/Pepper"]).toMatchObject({ billable: false, billed_to_customer: 0 });
    expect(byDesc["Ice Cream Bar Choc Almond"]).toMatchObject({ billable: false, billed_to_customer: 0 });
    // The fastener is the customer's, unchanged — the two states that already worked do not move.
    expect(byDesc["Bulk Fastener"]).toMatchObject({ billable: true, billed_to_customer: 6.1, is_stock: false });
  });

  it("answers 'what did that run cost the customer' with $6.50, not the $16.28 receipt", async () => {
    const { client } = fakeDb({ data: oshBill });
    const out = await parse("get_bill", { bill_id: oshBill.id }, client);
    // $6.50 at cost is the $8.13 the Bill It button writes with his 25% on it. Both numbers stay:
    // the receipt total is still what the job's cost eats, and Nort needs to be able to say which
    // is which rather than picking one.
    expect(out.billable_amount).toBe(6.5);
    expect(out.amount).toBe(16.28);
    expect(out.money_note).toContain("billable_amount");
  });

  it("warns the model off summing the lines, because the tax is shared", async () => {
    const { client } = fakeDb({ data: oshBill });
    const out = await parse("get_bill", { bill_id: oshBill.id }, client);
    const summed = out.items.reduce((s: number, i: any) => s + i.billed_to_customer, 0);
    // 6.10 + 1.01 of tax = 7.11 against a real 6.50: only the materials' share of untouched sales
    // tax reaches the customer. The gap is exactly why the note is in the payload.
    expect(summed).toBeCloseTo(7.11, 2);
    expect(out.billable_amount).toBeLessThan(summed);
    expect(out.money_note).toContain("do not add the line figures up");
  });

  it("bills the sixty wire nuts and calls the rest of the box shop stock", async () => {
    // His real CED line: a 500 count box of IDEAL 30641 Twisters at $108.36, of which this job used
    // $13.00 worth. He used to fix this by retyping the invoice by hand.
    const split = {
      ...oshBill,
      id: "c0535cdb",
      supplier: "Contractors Electrical Distributors",
      amount: "139.65",
      bill_line_items: [
        { id: "t1", description: "IDEAL 30641 500/5000 Twister 341-Tan", quantity: "500.00", unit_price: "108.36", amount: "108.36", category: "Electrical", billable: true, billed_amount: "13.00", is_stock: true },
        { id: "t2", description: "Noalox Anti-Oxidant 8 oz", quantity: "1.00", unit_price: "20.65", amount: "20.65", category: "Electrical", billable: true, billed_amount: null, is_stock: false },
        { id: "t3", description: "Sales Tax", quantity: "1.00", unit_price: "10.64", amount: "10.64", category: "Sales Tax", billable: true, billed_amount: null, is_stock: false },
      ],
    };
    const { client } = fakeDb({ data: split });
    const out = await parse("get_bill", { bill_id: split.id }, client);
    expect(out.items[0]).toMatchObject({ billable: true, billed_to_customer: 13, is_stock: true });
    // The shelf's 95.36 of the box, and its share of the tax, come off the customer's figure.
    expect(out.billable_amount).toBeLessThan(139.65 - 95.36 + 0.01);
    expect(out.amount).toBe(139.65);
  });

  it("says out loud when a receipt was replaced, or priced off a counter ticket", async () => {
    const { client } = fakeDb({
      data: { ...oshBill, pricing_provisional: true, superseded_by_bill_id: "31b489e4-743b-4208-9742-7fb4005c642c" },
    });
    const out = await parse("get_bill", { bill_id: oshBill.id }, client);
    expect(out.superseded).toBe(true);
    expect(out.pricing_provisional).toBe(true);
    expect(out.money_note).toContain("REPLACED");
    expect(out.money_note).toContain("PROVISIONAL");
  });

  it("leaves a hand-entered bill (no lines read off it) as its own lump", async () => {
    const { client } = fakeDb({ data: { ...oshBill, bill_line_items: [] } });
    const out = await parse("get_bill", { bill_id: oshBill.id }, client);
    expect(out.billable_amount).toBe(16.28);
    expect(out.items).toEqual([]);
  });

  it("still says 'Bill not found' rather than inventing one", async () => {
    const { client } = fakeDb({ data: null });
    const out = await parse("get_bill", { bill_id: "nope" }, client);
    expect(out).toEqual({ found: false, message: "Bill not found." });
  });
});

describe("list_bills — a replaced copy is not a second debt", () => {
  const rows = [
    { id: "8ce93d0a", supplier: "CED", bill_number: null, amount: "95.27", status: "unpaid", pricing_provisional: true, superseded_by_bill_id: null, jobs: { name: "Whitney" } },
  ];

  it("filters out the superseded copy the way every other cost reader does (0271)", async () => {
    const { calls, client } = fakeDb({ data: rows });
    await runDataTool("list_bills", { status: "unpaid" }, client);
    expect(calls.filters).toContain("is:superseded_by_bill_id:null");
    expect(calls.filters).toContain("eq:status:unpaid");
    expect(calls.select).toContain("pricing_provisional");
  });

  it("flags provisional pricing instead of reading a counter ticket back as his price", async () => {
    const { client } = fakeDb({ data: rows });
    const out = await parse("list_bills", {}, client);
    expect(out.bills[0].pricing_provisional).toBe(true);
    expect(out.note).toContain("provisional");
  });

  it("stays quiet when there is nothing provisional to warn about", async () => {
    const { client } = fakeDb({ data: [{ ...rows[0], pricing_provisional: false }] });
    const out = await parse("list_bills", {}, client);
    expect(out.bills[0].pricing_provisional).toBe(false);
    expect(out.note).toBeUndefined();
  });
});
