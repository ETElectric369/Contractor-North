import { CreditCard } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { FactsGrid, StatTile } from "@/components/ui/stat-tile";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { invoiceBalance } from "@/lib/invoice-math";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { RecordPaymentButton } from "./record-payment-button";

export const dynamic = "force-dynamic";

/** All payments received across every invoice — the money actually collected,
 *  which previously lived only inside each invoice. */
export default async function PaymentsPage() {
  const supabase = await createClient();
  const [{ data }, { data: refunds }, { data: allInv }, { data: orgRow }, { data: openInv }] = await Promise.all([
    supabase
      .from("payments")
      .select("id, amount, method, note, paid_at, invoices(id, invoice_number, status, customers(name))")
      .order("paid_at", { ascending: false })
      .limit(500),
    supabase.from("customer_credits").select("amount, created_at").eq("disposition", "refund"),
    // All-time collected comes from invoices.amount_paid (unlimited) — the SAME definition
    // as /billing's "Collected" tile. Summing the 500-row payments page undercounts the
    // headline the moment there are more than 500 payments.
    supabase.from("invoices").select("amount_paid, status"),
    supabase.from("organizations").select("settings").maybeSingle(),
    // Invoices the Record-payment picker may offer: billed (non-draft, non-void)
    // and still carrying a balance — the same set recordPayment will accept.
    supabase
      .from("invoices")
      .select("id, invoice_number, total, amount_paid, customers(name)")
      .in("status", ["sent", "partial", "overdue"])
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  // A voided invoice means the money was reversed (Erik's rule), so drop its
  // payments from the ledger. Keep payments with no invoice link.
  const payments = ((data ?? []) as any[]).filter((p) => (p.invoices?.status ?? "") !== "void");
  const refundList = (refunds ?? []) as any[];

  // This-month + all-time totals — net of refunds (money actually kept). The month
  // boundary is midnight on the 1st in the ORG's timezone — a server-local (UTC on
  // Vercel) boundary shifts late-month evening payments into the wrong month tile.
  const orgSettings = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings);
  const tz = orgSettings.timezone;
  // Belt-and-suspenders: recalcInvoice flips status on full payment, but a $0
  // balance under a stale status must still not be offered to the picker.
  const openInvoices = ((openInv ?? []) as any[]).filter(
    (i) => invoiceBalance(i.total, i.amount_paid) > 0,
  );
  const monthStart = tzDayStartUtc(`${todayStrInTz(tz).slice(0, 7)}-01`, tz);
  const refundTotal = refundList.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const refundMonth = refundList
    .filter((r) => new Date(r.created_at) >= monthStart)
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const total =
    ((allInv ?? []) as any[])
      .filter((i) => i.status !== "void")
      .reduce((s, i) => s + Number(i.amount_paid ?? 0), 0) - refundTotal;
  const monthTotal =
    payments.filter((p) => new Date(p.paid_at) >= monthStart).reduce((s, p) => s + Number(p.amount ?? 0), 0) -
    refundMonth;

  return (
    <div>
      <PageHeader title="Payments" description="Every payment collected, newest first.">
        <RecordPaymentButton invoices={openInvoices} paymentMethods={orgSettings.payment_methods} />
      </PageHeader>

      {payments.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No payments yet"
          description="Record a payment here or on any invoice — either way it shows up in this ledger."
        >
          <RecordPaymentButton invoices={openInvoices} paymentMethods={orgSettings.payment_methods} />
        </EmptyState>
      ) : (
        <>
          <FactsGrid cols={2} className="mb-4 sm:max-w-md">
            <StatTile label="This month" value={formatCurrency(monthTotal)} tone="accent" />
            <StatTile label="Total collected" value={formatCurrency(total)} />
          </FactsGrid>

          <Card className="overflow-hidden">
            <DataTable<any>
              rows={payments}
              rowKey={(p) => p.id}
              rowHref={(p) => (p.invoices ? `/billing/${p.invoices.id}` : "/billing")}
              mobileCols={2}
              columns={[
                { header: "Date", span: 3, className: "text-sm text-slate-600", cell: (p) => formatDate(p.paid_at) },
                { header: "Customer", span: 4, className: "text-sm font-medium text-slate-900", cell: (p) => p.invoices?.customers?.name ?? "—" },
                { header: "Invoice", span: 2, className: "text-sm text-slate-500", cell: (p) => p.invoices?.invoice_number ?? "—" },
                { header: "Method", span: 1, className: "text-xs capitalize text-slate-500", cell: (p) => p.method },
                { header: "Amount", span: 2, align: "right", className: "text-sm font-semibold text-green-700", cell: (p) => formatCurrency(p.amount) },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
