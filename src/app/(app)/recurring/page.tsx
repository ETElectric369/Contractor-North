import { Repeat, Briefcase, Wallet, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { listCustomerOptions } from "@/lib/schedule-options";
import { RecurringButton, type RecurringValue } from "./recurring-button";
import { RecurringRowActions, GenerateDueButton } from "./recurring-actions-ui";

export const dynamic = "force-dynamic";

const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Every 2 wks", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly",
};

export default async function RecurringPage() {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  const [{ data: templates }, { data: customers }] = await Promise.all([
    supabase.from("recurring_templates").select("*, customers(name)").order("next_date"),
    listCustomerOptions(supabase),
  ]);

  const custOpts = (customers ?? []).map((c: any) => ({ id: c.id, name: c.name }));
  const dueCount = (templates ?? []).filter((t: any) => t.active && t.next_date <= today).length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Recurring" description="Jobs, invoices, and expenses that repeat — generate them on a schedule.">
        <div className="flex items-center gap-2">
          {dueCount > 0 && <GenerateDueButton count={dueCount} />}
          <RecurringButton customers={custOpts} />
        </div>
      </PageHeader>

      {(templates ?? []).length === 0 ? (
        <Card className="py-12 text-center text-sm text-slate-400">
          <Repeat className="mx-auto mb-2 h-6 w-6 text-slate-300" />
          No recurring items yet. Add a monthly maintenance job, a service-agreement invoice, or a recurring expense like rent.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(templates ?? []).map((t: any) => {
              const value: RecurringValue = {
                id: t.id, kind: t.kind, title: t.title, frequency: t.frequency, next_date: t.next_date,
                customer_id: t.customer_id, description: t.description, amount: t.amount, category: t.category, vendor: t.vendor,
                tax_rate: t.tax_rate, auto_send: t.auto_send, line_items: t.line_items,
              };
              const due = t.active && t.next_date <= today;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${t.kind === "job" ? "bg-brand/10 text-brand" : t.kind === "invoice" ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>
                    {t.kind === "job" ? <Briefcase className="h-4 w-4" /> : t.kind === "invoice" ? <Receipt className="h-4 w-4" /> : <Wallet className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{t.title}</span>
                      {!t.active && <Badge tone="slate">paused</Badge>}
                      {due && <Badge tone="amber">due</Badge>}
                    </div>
                    <div className="text-xs text-slate-400">
                      {FREQ_LABEL[t.frequency] ?? t.frequency} · next {formatDate(t.next_date)}
                      {t.kind === "job" && t.customers?.name ? ` · ${t.customers.name}` : ""}
                      {t.kind === "expense" && t.amount != null ? ` · ${formatCurrency(t.amount)}${t.category ? ` · ${t.category}` : ""}` : ""}
                      {t.kind === "invoice" ? ` · ${t.amount != null ? formatCurrency(t.amount) : "—"}${t.customers?.name ? ` · ${t.customers.name}` : ""}${t.auto_send ? " · auto-sends" : ""}` : ""}
                    </div>
                  </div>
                  <RecurringRowActions id={t.id} active={t.active} />
                  <RecurringButton customers={custOpts} template={value} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
