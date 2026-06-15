import Link from "next/link";
import { Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { NewInvoiceButton } from "./new-invoice-button";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const supabase = await createClient();

  const [{ data: invoices }, { data: quotes }, { data: customers }, { data: jobs }] =
    await Promise.all([
      supabase
        .from("invoices")
        .select("*, customers(name)")
        .order("created_at", { ascending: false }),
      supabase
        .from("quotes")
        .select("id, quote_number, total, customers(name)")
        .in("status", ["sent", "accepted"])
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("customers").select("id, name").order("name"),
      supabase
        .from("jobs")
        .select("id, name, job_number, customer_id")
        .not("status", "in", "(cancelled)")
        .order("created_at", { ascending: false })
        .limit(300),
    ]);

  const list = invoices ?? [];
  const outstanding = list
    .filter((i: any) => !["paid", "void"].includes(i.status))
    .reduce((s: number, i: any) => s + (Number(i.total) - Number(i.amount_paid)), 0);
  const collected = list.reduce(
    (s: number, i: any) => s + Number(i.amount_paid ?? 0),
    0,
  );

  return (
    <div>
      <PageHeader title="Billing" description="Invoices and payments.">
        <NewInvoiceButton quotes={(quotes as any) ?? []} customers={customers ?? []} jobs={(jobs as any) ?? []} />
      </PageHeader>

      {list.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-4 sm:max-w-md">
          <Card>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">
                {formatCurrency(outstanding)}
              </div>
              <div className="text-xs text-slate-500">Outstanding</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">
                {formatCurrency(collected)}
              </div>
              <div className="text-xs text-slate-500">Collected (all time)</div>
            </CardContent>
          </Card>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No invoices yet"
          description="Turn an accepted quote into an invoice, or start a blank one."
        >
          <NewInvoiceButton quotes={(quotes as any) ?? []} customers={customers ?? []} jobs={(jobs as any) ?? []} />
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
            <div className="col-span-2">Invoice</div>
            <div className="col-span-3">Customer</div>
            <div className="col-span-2">Due</div>
            <div className="col-span-2 text-right">Balance</div>
            <div className="col-span-2 text-right">Total</div>
            <div className="col-span-1 text-right">Status</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {list.map((inv: any) => {
              const balance = Number(inv.total) - Number(inv.amount_paid);
              return (
                <li key={inv.id}>
                  <Link
                    href={`/billing/${inv.id}`}
                    className="grid grid-cols-2 gap-2 px-5 py-3 hover:bg-slate-50 md:grid-cols-12 md:items-center md:gap-4"
                  >
                    <div className="col-span-2 font-medium text-slate-900">
                      {inv.invoice_number}
                    </div>
                    <div className="col-span-3 text-sm text-slate-600">
                      {inv.customers?.name ?? "—"}
                    </div>
                    <div className="col-span-2 text-sm text-slate-500">
                      {inv.due_date ? formatDate(inv.due_date) : "—"}
                    </div>
                    <div className="col-span-2 text-right text-sm font-medium text-slate-900">
                      {formatCurrency(balance)}
                    </div>
                    <div className="col-span-2 text-right text-sm text-slate-500">
                      {formatCurrency(inv.total)}
                    </div>
                    <div className="col-span-1 text-right">
                      <Badge tone={statusTone(inv.status)}>{inv.status}</Badge>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
