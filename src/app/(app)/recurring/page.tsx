import { Repeat, Briefcase, Wallet, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { listCustomerOptions } from "@/lib/schedule-options";
import { RecurringButton, type RecurringValue } from "./recurring-button";
import { RecurringRowActions } from "./recurring-actions-ui";
import { featureOn } from "@/lib/features";
import { viewerSwitches } from "@/lib/viewer-switches";
import { FeatureOffLine } from "@/components/feature-off-line";

export const dynamic = "force-dynamic";

const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Every 2 wks", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly",
};

export default async function RecurringPage() {
  const supabase = await createClient();

  const [{ data: templates }, { data: customers }, { data: orgRow }, sw] = await Promise.all([
    supabase.from("recurring_templates").select("*, customers(name)").order("next_date"),
    listCustomerOptions(supabase),
    supabase.from("organizations").select("settings").maybeSingle(),
    viewerSwitches(),
  ]);
  const orgS = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings);
  // EACH ONE IS MADE ON ITS DAY, AUTOMATICALLY (W2-12). The daily cron (vercel.json, 15:00 UTC =
  // 8 AM Pacific: /api/automations/daily → generateDueTemplates for every company) makes every
  // template that is due, so the header's old "Generate N Due" did by hand what already happens by
  // itself, and it is gone. A row that is due wears its amber "due" chip until the cron makes it, with
  // its own Generate One Now beside the chip for the one you want made right now.
  // RECURRING BILLING OFF (the switch board, 0352): no repeat invoice is made, so the doors that make
  // one (an invoice row's Generate One Now, New's "Recurring invoice" type) go, and generateOne and
  // saveRecurring refuse a new one as well (the cron's engine skips them too). Repeat jobs and
  // expenses aren't the switch's: this page is their only door, so it stays in the dock, New stays
  // for them, and their rows keep Generate One Now. The list stays readable, and Pause/Resume and edit
  // stay. The page isn't a switch route (the jobs and expenses are core), so it draws its own Off line.
  const recurringOn = featureOn(orgS.features, "recurring_billing");
  const salesTax = featureOn(orgS.features, "sales_tax");
  // "Due" is an ORG-LOCAL calendar decision (audit v921). A UTC today rolls over at ~5 PM Pacific,
  // so the chip would say "due" while the cron's generateDueTemplates, which gates on the org's own
  // today, would make nothing yet. Same clock, both sides.
  const today = todayStrInTz(orgS.timezone);

  const custOpts = (customers ?? []).map((c: any) => ({ id: c.id, name: c.name }));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Recurring" description="Jobs, invoices, and expenses that repeat. Each one is made on its day, automatically.">
        <RecurringButton customers={custOpts} salesTax={salesTax} invoiceKind={recurringOn} />
      </PageHeader>

      <FeatureOffLine feature="recurring_billing" features={sw.features} isOwner={sw.isOwner} />

      {(templates ?? []).length === 0 ? (
        <Card className="py-12 text-center text-sm text-slate-400">
          <Repeat className="mx-auto mb-2 h-6 w-6 text-slate-300" />
          {recurringOn
            ? "No recurring items yet. Add a monthly maintenance job, a service-agreement invoice, or a recurring expense like rent."
            : "No recurring items yet. Add a monthly maintenance job, or a recurring expense like rent."}
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
                  <RecurringRowActions id={t.id} active={t.active} kind={t.kind} canGenerate={recurringOn || t.kind !== "invoice"} />
                  <RecurringButton customers={custOpts} template={value} salesTax={salesTax} invoiceKind={recurringOn} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
