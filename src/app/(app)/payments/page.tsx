import { CreditCard } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { FactsGrid, StatTile } from "@/components/ui/stat-tile";
import { formatCurrency, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** All payments received across every invoice — the money actually collected,
 *  which previously lived only inside each invoice. */
export default async function PaymentsPage() {
  const supabase = await createClient();
  const [{ data }, { data: refunds }] = await Promise.all([
    supabase
      .from("payments")
      .select("id, amount, method, note, paid_at, invoices(id, invoice_number, status, customers(name))")
      .order("paid_at", { ascending: false })
      .limit(500),
    supabase.from("customer_credits").select("amount, created_at").eq("disposition", "refund"),
  ]);

  // A voided invoice means the money was reversed (Erik's rule), so drop its
  // payments from the ledger. Keep payments with no invoice link.
  const payments = ((data ?? []) as any[]).filter((p) => (p.invoices?.status ?? "") !== "void");
  const refundList = (refunds ?? []) as any[];

  // This-month + all-time totals — net of refunds (money actually kept).
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const refundTotal = refundList.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const refundMonth = refundList
    .filter((r) => new Date(r.created_at) >= monthStart)
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const total = payments.reduce((s, p) => s + Number(p.amount ?? 0), 0) - refundTotal;
  const monthTotal =
    payments.filter((p) => new Date(p.paid_at) >= monthStart).reduce((s, p) => s + Number(p.amount ?? 0), 0) -
    refundMonth;

  return (
    <div>
      <PageHeader title="Payments" description="Every payment collected, newest first." />

      {payments.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No payments yet"
          description="Payments you record on an invoice show up here."
        />
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
