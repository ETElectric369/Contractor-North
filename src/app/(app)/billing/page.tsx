import Link from "next/link";
import { Receipt, Send, FileText, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getMoneyPipeline } from "@/lib/billing-pipeline";
import { NewInvoiceButton } from "./new-invoice-button";
import { InvoiceJobButton } from "./invoice-job-button";

export const dynamic = "force-dynamic";

const money = (n: number) => formatCurrency(n);

export default async function BillingPage() {
  const supabase = await createClient();

  const [pipeline, { data: quotes }, { data: customers }, { data: jobs }, { data: refunds }, { data: allInv }] =
    await Promise.all([
      getMoneyPipeline(supabase),
      supabase.from("quotes").select("id, quote_number, total, customers(name)").in("status", ["sent", "accepted"]).order("created_at", { ascending: false }).limit(100),
      supabase.from("customers").select("id, name").order("name"),
      supabase.from("jobs").select("id, name, job_number, customer_id").not("status", "in", "(cancelled)").order("created_at", { ascending: false }).limit(300),
      supabase.from("customer_credits").select("amount").eq("disposition", "refund"),
      supabase.from("invoices").select("id, invoice_number, total, amount_paid, status, due_date, customers(name)").order("created_at", { ascending: false }),
    ]);

  const list = (allInv ?? []) as any[];
  const refundsTotal = (refunds ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
  const collected = list.filter((i) => i.status !== "void").reduce((s: number, i: any) => s + Number(i.amount_paid ?? 0), 0) - refundsTotal;

  const { doneNotInvoiced, drafts, unpaid } = pipeline;
  const caughtUp = doneNotInvoiced.length === 0 && drafts.length === 0 && unpaid.length === 0;

  return (
    <div>
      <PageHeader title="Billing" description="Your money pipeline — nothing slips through.">
        <NewInvoiceButton quotes={(quotes as any) ?? []} customers={customers ?? []} jobs={(jobs as any) ?? []} />
      </PageHeader>

      {/* The three numbers that matter */}
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Card className="border-rose-200">
          <CardContent className="py-3">
            <div className="text-xl font-bold text-slate-900">{money(pipeline.toInvoiceTotal)}</div>
            <div className="text-xs text-slate-500">To invoice · {doneNotInvoiced.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xl font-bold text-slate-900">{money(pipeline.outstandingTotal)}</div>
            <div className="text-xs text-slate-500">Outstanding · {unpaid.length}</div>
          </CardContent>
        </Card>
        <Card className={pipeline.overdueTotal > 0 ? "border-red-300 bg-red-50/40" : ""}>
          <CardContent className="py-3">
            <div className={`text-xl font-bold ${pipeline.overdueTotal > 0 ? "text-red-700" : "text-slate-900"}`}>{money(pipeline.overdueTotal)}</div>
            <div className="text-xs text-slate-500">Overdue · {pipeline.overdueCount}</div>
          </CardContent>
        </Card>
      </div>

      {caughtUp && (
        <Card className="mb-4 border-emerald-200 bg-emerald-50/50">
          <CardContent className="flex items-center gap-2 py-4 text-sm font-medium text-emerald-800">
            <CheckCircle2 className="h-5 w-5" /> All caught up — every finished job is invoiced and every invoice is paid.
          </CardContent>
        </Card>
      )}

      {/* STAGE 1 — done, not invoiced (the silent gap) */}
      {doneNotInvoiced.length > 0 && (
        <Stage tone="rose" icon={<Receipt className="h-4 w-4" />} title="Done — not invoiced" count={doneNotInvoiced.length} sub="Finished jobs with no invoice — or a payment schedule not fully drawn. Bill them before they slip.">
          {doneNotInvoiced.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <Link href={`/jobs/${j.id}`} className="min-w-0 hover:underline">
                <div className="truncate text-sm font-medium text-slate-900">{j.customer ?? "—"}</div>
                <div className="truncate text-xs text-slate-500">{j.name ?? j.job_number}{j.value > 0 ? ` · est. ${money(j.value)}` : ""}</div>
              </Link>
              {j.draw ? (
                // Schedule job → draws bill via "Request next payment" on the job's payment
                // schedule, not a standard invoice (createInvoiceForJob rejects schedule jobs).
                <Link href={`/jobs/${j.id}?tab=invoices`} className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark">
                  Request payment →
                </Link>
              ) : (
                <InvoiceJobButton jobId={j.id} />
              )}
            </li>
          ))}
        </Stage>
      )}

      {/* STAGE 2 — drafts not sent */}
      {drafts.length > 0 && (
        <Stage tone="amber" icon={<FileText className="h-4 w-4" />} title="Draft — not sent" count={drafts.length} sub="Invoices written up but not sent to the customer yet.">
          {drafts.map((inv) => (
            <li key={inv.id}>
              <Link href={`/billing/${inv.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-amber-50">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">{inv.customer ?? "—"}</div>
                  <div className="truncate text-xs text-slate-500">{inv.job ?? inv.invoice_number}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm font-medium text-slate-900">{money(inv.total)}</span>
                  <span className="inline-flex items-center text-xs font-semibold text-brand">Review &amp; send <ChevronRight className="h-3.5 w-3.5" /></span>
                </div>
              </Link>
            </li>
          ))}
        </Stage>
      )}

      {/* STAGE 3 — sent, not paid (overdue first) */}
      {unpaid.length > 0 && (
        <Stage tone="sky" icon={<Send className="h-4 w-4" />} title="Sent — awaiting payment" count={unpaid.length} sub="Out the door, money not in yet. Overdue ones are flagged.">
          {unpaid.map((inv) => (
            <li key={inv.id}>
              <Link href={`/billing/${inv.id}`} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${inv.overdue ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-sky-50"}`}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900">{inv.customer ?? "—"}</div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    {inv.overdue && <span className="inline-flex items-center gap-0.5 font-semibold text-red-600"><AlertTriangle className="h-3 w-3" /> Overdue</span>}
                    <span className="truncate">{inv.invoice_number}{inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ""}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`text-sm font-medium ${inv.overdue ? "text-red-700" : "text-slate-900"}`}>{money(inv.balance)}</span>
                  <span className="inline-flex items-center text-xs font-semibold text-brand">Record payment <ChevronRight className="h-3.5 w-3.5" /></span>
                </div>
              </Link>
            </li>
          ))}
        </Stage>
      )}

      {/* Reference: every invoice + lifetime collected */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-500">All invoices</h3>
          <Link href="/payments" className="text-xs font-medium text-slate-500 hover:text-brand">Collected {money(collected)} · payments →</Link>
        </div>
        {list.length === 0 ? (
          <EmptyState icon={Receipt} title="No invoices yet" description="Turn an accepted quote into an invoice, or start a blank one.">
            <NewInvoiceButton quotes={(quotes as any) ?? []} customers={customers ?? []} jobs={(jobs as any) ?? []} />
          </EmptyState>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
              {list.map((inv: any) => {
                const balance = Number(inv.total) - Number(inv.amount_paid);
                return (
                  <li key={inv.id}>
                    <Link href={`/billing/${inv.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-slate-900">{inv.invoice_number}</span>
                        <span className="ml-2 text-sm text-slate-500">{inv.customers?.name ?? "—"}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-4">
                        <span className="text-sm font-medium text-slate-900">{money(balance)}</span>
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
    </div>
  );
}

const TONES: Record<string, string> = {
  rose: "border-rose-200 bg-rose-50/40 text-rose-800",
  amber: "border-amber-200 bg-amber-50/40 text-amber-800",
  sky: "border-sky-200 bg-sky-50/40 text-sky-800",
};

function Stage({ tone, icon, title, count, sub, children }: { tone: string; icon: React.ReactNode; title: string; count: number; sub: string; children: React.ReactNode }) {
  return (
    <Card className={`mb-3 ${TONES[tone].split(" ").slice(0, 2).join(" ")}`}>
      <CardContent className="py-4">
        <div className={`mb-1 flex items-center gap-2 text-sm font-semibold ${TONES[tone].split(" ").slice(2).join(" ")}`}>
          {icon} {title} · {count}
        </div>
        <p className="mb-3 text-xs text-slate-500">{sub}</p>
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100 bg-white">{children}</ul>
      </CardContent>
    </Card>
  );
}
