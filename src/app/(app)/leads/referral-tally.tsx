import { ChevronRight } from "lucide-react";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";

/** The referral tally ("Brian at the bar") — commission is a lookup, not a memory.
 *  Staff-only server component: one row per referrer with leads referred, how many
 *  converted, and the won value where it's linkable (accepted quotes of the customer
 *  a lead converted into — the cheapest join that can't disagree with the quote book).
 *  Renders nothing for crew or when no lead has a referrer. */

const statusTone: Record<string, "blue" | "amber" | "indigo" | "green" | "slate"> = {
  new: "blue",
  contacted: "amber",
  quoted: "indigo",
  won: "green",
  lost: "slate",
};

type ReferredLead = {
  id: string;
  name: string;
  status: string;
  customer_id: string | null;
  converted_at: string | null;
  referred_by: string;
  referrer: { full_name: string | null } | null;
};

function isConverted(l: ReferredLead) {
  return l.status === "won" || l.customer_id !== null || l.converted_at !== null;
}

export async function ReferralTally() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !isStaffRole(me.role)) return null;

  // ALL referred leads — the open-leads list above filters converted/lost out,
  // so this card is the only place a converted referral keeps its credit visible.
  const { data: refData } = await supabase
    .from("inquiries")
    .select("id, name, status, customer_id, converted_at, referred_by, referrer:profiles!inquiries_referred_by_fkey(full_name)")
    .not("referred_by", "is", null)
    .order("created_at", { ascending: false });

  const referred = (refData ?? []) as unknown as ReferredLead[];
  if (referred.length === 0) return null;

  // Won value where linkable: accepted quotes for the customers these leads became.
  const customerIds = [...new Set(referred.map((l) => l.customer_id).filter((id): id is string => !!id))];
  const valueByCustomer = new Map<string, number>();
  if (customerIds.length > 0) {
    const { data: quotes } = await supabase
      .from("quotes")
      .select("customer_id, total")
      .in("customer_id", customerIds)
      .eq("status", "accepted");
    for (const q of (quotes ?? []) as { customer_id: string | null; total: number }[]) {
      if (!q.customer_id) continue;
      valueByCustomer.set(q.customer_id, (valueByCustomer.get(q.customer_id) ?? 0) + Number(q.total ?? 0));
    }
  }

  // One row per referrer. A customer's value counts once per referrer even if two
  // of their leads converted into the same customer.
  const byReferrer = new Map<string, { name: string; leads: ReferredLead[] }>();
  for (const l of referred) {
    const row = byReferrer.get(l.referred_by) ?? { name: l.referrer?.full_name ?? "Unknown", leads: [] };
    row.leads.push(l);
    byReferrer.set(l.referred_by, row);
  }
  const rows = [...byReferrer.entries()]
    .map(([id, r]) => {
      const converted = r.leads.filter(isConverted);
      const wonCustomers = new Set(converted.map((l) => l.customer_id).filter((c): c is string => !!c));
      const value = [...wonCustomers].reduce((sum, c) => sum + (valueByCustomer.get(c) ?? 0), 0);
      return { id, name: r.name, leads: r.leads, converted: converted.length, value };
    })
    .sort((a, b) => b.value - a.value || b.converted - a.converted || b.leads.length - a.leads.length);

  const anyUnlinked = rows.some((r) => r.converted > 0 && r.value === 0);

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle>Referral tally</CardTitle>
        <CardDescription>Who&apos;s sending work in — commission is a lookup, not a memory.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-3">
        <div className="flex items-center gap-2 px-5 pb-1 text-[10px] uppercase tracking-wide text-slate-400">
          <span className="w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Referrer</span>
          <span className="w-12 shrink-0 text-right">Leads</span>
          <span className="w-10 shrink-0 text-right">Won</span>
          <span className="w-24 shrink-0 text-right">Won value</span>
        </div>
        <div className="divide-y divide-slate-100">
          {rows.map((r) => (
            <details key={r.id} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-2.5 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{r.name}</span>
                <span className="w-12 shrink-0 text-right text-sm tabular-nums text-slate-600">{r.leads.length}</span>
                <span className="w-10 shrink-0 text-right text-sm tabular-nums text-slate-600">{r.converted}</span>
                <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-900">
                  {r.value > 0 ? formatCurrency(r.value) : "—"}
                </span>
              </summary>
              <ul className="pb-2">
                {r.leads.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 py-1 pl-11 pr-5">
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{l.name}</span>
                    <Badge tone={statusTone[l.status] ?? "slate"}>{l.status}</Badge>
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-500">
                      {l.customer_id && (valueByCustomer.get(l.customer_id) ?? 0) > 0
                        ? formatCurrency(valueByCustomer.get(l.customer_id))
                        : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
        <p className="px-5 pt-2 text-[11px] text-slate-400">
          Won value = accepted quote totals for the customer a lead converted into.
          {anyUnlinked && " Some converted leads have no accepted quote yet, so they count but carry no value."}
        </p>
      </CardContent>
    </Card>
  );
}
