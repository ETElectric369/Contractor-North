import Link from "next/link";
import { CreditCard } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
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
          <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="rounded-xl bg-green-50 px-4 py-3">
              <div className="text-xs font-medium text-green-700">This month</div>
              <div className="text-2xl font-bold text-green-900">{formatCurrency(monthTotal)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 px-4 py-3">
              <div className="text-xs font-medium text-slate-500">Total collected</div>
              <div className="text-2xl font-bold text-slate-900">{formatCurrency(total)}</div>
            </div>
          </div>

          <Card className="overflow-hidden">
            <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
              <div className="col-span-3">Date</div>
              <div className="col-span-4">Customer</div>
              <div className="col-span-2">Invoice</div>
              <div className="col-span-1">Method</div>
              <div className="col-span-2 text-right">Amount</div>
            </div>
            <ul className="divide-y divide-slate-100">
              {payments.map((p) => {
                const inv = p.invoices;
                return (
                  <li key={p.id}>
                    <Link
                      href={inv ? `/billing/${inv.id}` : "/billing"}
                      className="grid grid-cols-2 gap-2 px-5 py-3 hover:bg-slate-50 md:grid-cols-12 md:items-center md:gap-4"
                    >
                      <div className="col-span-3 text-sm text-slate-600">{formatDate(p.paid_at)}</div>
                      <div className="col-span-4 text-sm font-medium text-slate-900">
                        {inv?.customers?.name ?? "—"}
                      </div>
                      <div className="col-span-2 text-sm text-slate-500">{inv?.invoice_number ?? "—"}</div>
                      <div className="col-span-1 text-xs capitalize text-slate-500">{p.method}</div>
                      <div className="col-span-2 text-right text-sm font-semibold text-green-700">
                        {formatCurrency(p.amount)}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
