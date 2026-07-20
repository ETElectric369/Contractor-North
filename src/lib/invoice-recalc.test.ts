import { describe, it, expect } from "vitest";
import { recalcInvoice } from "@/lib/invoice-recalc";

/** A minimal PostgREST-shaped fake: every builder is thenable (so `await from().select().eq()`
 *  yields { data }), `.single()/.maybeSingle()` yield the first row, and `.update()` records the
 *  patch so a test can assert what was written. Filters are no-ops — each table's rows are
 *  supplied pre-filtered, which is exactly the set the real query would return. */
function fakeDb(tables: Record<string, any[]>) {
  const writes: Record<string, any> = {};
  const client = {
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
        update: (patch: any) => {
          writes[table] = patch;
          return { eq: async () => ({ error: null }) };
        },
        then: (onOk: any, onErr?: any) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(onOk, onErr),
      };
      return builder;
    },
  };
  return { client, writes };
}

const invoiceWrite = (writes: Record<string, any>) => writes["invoices"];

describe("recalcInvoice — THE amount_paid definition (payments + open account credits)", () => {
  it("an $800 card payment ON TOP of a $200 posted credit settles a $1,000 invoice", async () => {
    // The Stripe-webhook regression: the webhook used to sum payments ONLY and blind-write
    // amount_paid, erasing the credit — the invoice came back $800 paid / "partial", kept a
    // phantom $200 balance, got dunned, and was payable a second time on the public page.
    const { client, writes } = fakeDb({
      invoice_items: [{ line_total: 1000 }],
      payments: [{ amount: 800 }],
      customer_credits: [{ amount: 200 }],
      invoices: [{ tax_rate: 0, status: "sent" }],
    });
    await recalcInvoice(client, "inv-1");
    expect(invoiceWrite(writes)).toMatchObject({ total: 1000, amount_paid: 1000, status: "paid" });
  });

  it("the credit alone leaves the invoice partial (balance reduced, not settled)", async () => {
    const { client, writes } = fakeDb({
      invoice_items: [{ line_total: 1000 }],
      payments: [],
      customer_credits: [{ amount: 200 }],
      invoices: [{ tax_rate: 0, status: "sent" }],
    });
    await recalcInvoice(client, "inv-1");
    expect(invoiceWrite(writes)).toMatchObject({ amount_paid: 200, status: "partial" });
  });

  it("cash alone still settles (no credits on the invoice)", async () => {
    const { client, writes } = fakeDb({
      invoice_items: [{ line_total: 500 }],
      payments: [{ amount: 500 }],
      customer_credits: [],
      invoices: [{ tax_rate: 0, status: "sent" }],
    });
    await recalcInvoice(client, "inv-1");
    expect(invoiceWrite(writes)).toMatchObject({ amount_paid: 500, status: "paid" });
  });

  it("recomputes totals from line items + tax, not from the stored header", async () => {
    const { client, writes } = fakeDb({
      invoice_items: [{ line_total: 100 }, { line_total: 49.99 }],
      payments: [],
      customer_credits: [],
      invoices: [{ tax_rate: 0.0725, status: "draft" }],
    });
    await recalcInvoice(client, "inv-1");
    expect(invoiceWrite(writes)).toMatchObject({ subtotal: 149.99, tax: 10.87, total: 160.86 });
  });

  it("never resurrects a voided invoice", async () => {
    const { client, writes } = fakeDb({
      invoice_items: [{ line_total: 1000 }],
      payments: [{ amount: 1000 }],
      customer_credits: [],
      invoices: [{ tax_rate: 0, status: "void" }],
    });
    await recalcInvoice(client, "inv-1");
    expect(invoiceWrite(writes).status).toBe("void");
  });
});
