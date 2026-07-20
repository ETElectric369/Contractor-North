import { describe, it, expect } from "vitest";
import { runInvoiceTemplate } from "@/lib/recurring-engine";
import { dueDateIsoFromSettings } from "@/lib/invoice-due";

/** Fake PostgREST for the recurring-invoice cron path: captures the invoice insert so the
 *  test can assert what the UNATTENDED path writes. */
function fakeDb(orgs: { id: string; settings: unknown }[], claimWins = true) {
  const captured: { invoice?: any; items?: any[] } = {};
  const client = {
    from(table: string) {
      let orgFilter: string | undefined;
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (table === "organizations" && column === "id") orgFilter = value;
          return builder;
        },
        maybeSingle: async () => ({
          data: (orgFilter ? orgs.filter((o) => o.id === orgFilter) : orgs)[0] ?? null,
          error: null,
        }),
        single: async () => ({ data: { id: "inv-new" }, error: null }),
        insert: (payload: any) => {
          if (table === "invoices") captured.invoice = payload;
          if (table === "invoice_items") captured.items = payload;
          return builder;
        },
        update: () => builder,
        then: (onOk: any, onErr?: any) =>
          Promise.resolve(
            table === "recurring_templates"
              ? { data: claimWins ? [{ id: "tpl-1" }] : [], error: null }
              : { data: [], error: null },
          ).then(onOk, onErr),
      };
      return builder;
    },
  };
  return { client, captured };
}

const template = {
  id: "tpl-1",
  org_id: "org-b",
  kind: "invoice",
  customer_id: "cust-1",
  title: "Monthly service agreement",
  amount: 450,
  tax_rate: 0,
  frequency: "monthly",
  next_date: "2026-07-01",
  auto_send: false,
};

describe("recurring invoices carry a due date (the Overdue tracker needs one)", () => {
  it("stamps due_date from the TEMPLATE's org net terms", async () => {
    // Without this the invoice sits at due_date NULL: billing-pipeline, computeArAging and
    // the reminder cron all filter `due_date < today`, and SQL's `<` drops NULL entirely —
    // so three months of unpaid auto-sent invoices read as "Current — not yet due", $0
    // overdue, and the customer was never chased.
    const { client, captured } = fakeDb([
      { id: "org-a", settings: { timezone: "America/New_York", invoice_due_days: 45 } },
      { id: "org-b", settings: { timezone: "America/Los_Angeles", invoice_due_days: 15 } },
    ]);
    const made = await runInvoiceTemplate(client, template, "user-1", "2026-07-20");
    expect(made).toBe(true);
    expect(captured.invoice?.due_date).toBeTruthy();
    // The template's OWN org's terms — an unscoped settings read (service-role cron sees
    // every org) would have priced this off org-a's 45-day, New-York-noon date.
    expect(captured.invoice.due_date).toBe(
      dueDateIsoFromSettings({ timezone: "America/Los_Angeles", invoice_due_days: 15 }),
    );
  });

  it("still writes the shared rollup fields alongside it", async () => {
    const { client, captured } = fakeDb([{ id: "org-b", settings: { timezone: "America/Los_Angeles", invoice_due_days: 30 } }]);
    await runInvoiceTemplate(client, { ...template, tax_rate: 0.0725 }, "user-1", "2026-07-20");
    expect(captured.invoice).toMatchObject({ org_id: "org-b", status: "draft", subtotal: 450, tax: 32.63, total: 482.63 });
  });

  it("a lost claim creates nothing (no invoice, so no due date to stamp)", async () => {
    const { client, captured } = fakeDb([{ id: "org-b", settings: {} }], false);
    const made = await runInvoiceTemplate(client, template, "user-1", "2026-07-20");
    expect(made).toBe(false);
    expect(captured.invoice).toBeUndefined();
  });
});
