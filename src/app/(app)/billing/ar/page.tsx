import Link from "next/link";
import { redirect } from "next/navigation";
import { Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { getArAging, computeArByCustomer } from "@/lib/analytics/money-metrics";

export const dynamic = "force-dynamic";

/**
 * Accounts Receivable — WHO owes money, rolled up per customer, fed by INVOICES
 * (sent/partial with an open balance), never by job status (Erik's lifecycle rework:
 * "invoiced" left the job lifecycle; a job just gets done — the money owed lives here).
 * Same engine as /analytics' aging card + Nort's ar_aging tool (money-metrics.ts SSOT).
 */
export default async function ArPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  if (!me || !isStaffRole((me as { role?: string }).role ?? "")) redirect("/planner");

  const aging = await getArAging(supabase);
  const customers = computeArByCustomer(aging);
  const pastDue = aging.buckets.d30 + aging.buckets.d60 + aging.buckets.d90;

  const BUCKETS: { key: keyof typeof aging.buckets; label: string }[] = [
    { key: "current", label: "Current" },
    { key: "d30", label: "1–30 days" },
    { key: "d60", label: "31–60 days" },
    { key: "d90", label: "60+ days" },
  ];
  const maxBucket = Math.max(1, ...BUCKETS.map((b) => aging.buckets[b.key]));

  return (
    <div>
      <PageHeader
        title="Accounts Receivable"
        description="Who owes you, by customer — open balances on sent and partially-paid invoices."
      />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card><CardContent className="py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Outstanding</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{formatCurrency(aging.outstanding)}</p>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Past due</p>
          <p className={`mt-1 text-2xl font-bold ${pastDue > 0 ? "text-red-600" : "text-slate-900"}`}>{formatCurrency(pastDue)}</p>
        </CardContent></Card>
        <Card className="col-span-2 sm:col-span-1"><CardContent className="py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Open invoices</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{aging.invoices.length}</p>
        </CardContent></Card>
      </div>

      {/* Aging buckets — the same shape the analytics card draws. */}
      <Card className="mb-6">
        <CardContent className="py-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Aging</h3>
          <div className="space-y-2">
            {BUCKETS.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 text-slate-500">{label}</span>
                <div className="h-3 flex-1 overflow-hidden rounded bg-slate-100">
                  <div
                    className={`h-full rounded ${key === "current" ? "bg-emerald-400" : key === "d30" ? "bg-amber-400" : key === "d60" ? "bg-orange-400" : "bg-red-500"}`}
                    style={{ width: `${Math.round((aging.buckets[key] / maxBucket) * 100)}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right font-medium text-slate-700">{formatCurrency(aging.buckets[key])}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {customers.length === 0 ? (
        <EmptyState icon={Receipt} title="Nothing owed" description="No open balances — every sent invoice is paid up." />
      ) : (
        <div className="space-y-4">
          {customers.map((c) => (
            <Card key={c.customer + c.balance} className="overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold text-slate-900">{c.customer}</span>
                  {c.worstDaysLate > 0 && <Badge tone="red">{c.worstDaysLate}d late</Badge>}
                </div>
                <span className="shrink-0 text-base font-bold text-slate-900">{formatCurrency(c.balance)}</span>
              </div>
              <ul className="divide-y divide-slate-50">
                {c.invoices.map((inv) => (
                  <li key={inv.id ?? inv.invoice_number ?? Math.random()}>
                    <Link
                      href={inv.id ? `/billing/${inv.id}` : "/billing"}
                      className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-slate-50"
                    >
                      <span className="text-slate-600">{inv.invoice_number ?? "Invoice"}</span>
                      <span className="flex items-center gap-3">
                        {inv.daysLate > 0 ? (
                          <span className="text-xs text-red-600">{inv.daysLate} days late</span>
                        ) : (
                          <span className="text-xs text-slate-400">current</span>
                        )}
                        <span className="font-medium text-slate-800">{formatCurrency(inv.balance)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
