import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { NewCustomerButton } from "../crm/new-customer-button";
import { LeadRow } from "./lead-row";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("customers")
    .select("*")
    .eq("status", "lead")
    .order("next_follow_up_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  const leads = (data ?? []) as Customer[];
  const today = new Date(new Date().toDateString());
  const dueToday = leads.filter(
    (l) => l.next_follow_up_at && new Date(l.next_follow_up_at) <= today,
  ).length;

  return (
    <div>
      <PageHeader title="Leads" description="Prospects to follow up and convert.">
        <NewCustomerButton />
      </PageHeader>

      {leads.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-4 sm:max-w-sm">
          <Card>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">{leads.length}</div>
              <div className="text-xs text-slate-500">Open leads</div>
            </CardContent>
          </Card>
          <Card className={dueToday ? "border-amber-200 bg-amber-50" : ""}>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">{dueToday}</div>
              <div className="text-xs text-slate-500">Follow-ups due</div>
            </CardContent>
          </Card>
        </div>
      )}

      {leads.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No open leads"
          description="New customers with the 'lead' status show up here for follow-up."
        >
          <NewCustomerButton />
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {leads.map((l) => (
              <LeadRow key={l.id} lead={l} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
