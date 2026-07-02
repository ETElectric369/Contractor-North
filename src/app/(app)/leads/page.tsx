import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { InquiryModal } from "./inquiry-modal";
import { InquiryRow } from "./inquiry-row";
import { ReferralTally } from "./referral-tally";
import type { Inquiry } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InquiriesPage() {
  const supabase = await createClient();

  const [{ data: inqData }, { data: custData }] = await Promise.all([
    supabase
      .from("inquiries")
      .select("*, referrer:profiles!inquiries_referred_by_fkey(full_name)")
      .is("converted_at", null)
      .neq("status", "lost")
      .order("next_follow_up_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase.from("customers").select("id, name").order("name"),
  ]);

  const inquiries = (inqData ?? []) as Inquiry[];
  const customers = (custData ?? []) as { id: string; name: string }[];

  const today = new Date(new Date().toDateString());
  const dueToday = inquiries.filter(
    (i) => i.next_follow_up_at && new Date(i.next_follow_up_at) <= today,
  ).length;

  return (
    <div>
      <PageHeader title="Leads" description="New requests to follow up and convert — nothing converts automatically.">
        <InquiryModal />
      </PageHeader>

      {/* Staff-only commission lookup — renders nothing for crew or when no lead
          has a referrer. Sits above the open list because converted referrals
          drop OUT of that list and this is where their credit stays visible. */}
      <ReferralTally />

      {inquiries.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-4 sm:max-w-sm">
          <Card>
            <CardContent className="py-4">
              <div className="text-2xl font-bold text-slate-900">{inquiries.length}</div>
              <div className="text-xs text-slate-500">Open inquiries</div>
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

      {inquiries.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No open leads"
          description="Web submissions and manually-added leads show up here to follow up and convert."
        >
          <InquiryModal />
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {inquiries.map((i) => (
              <InquiryRow key={i.id} inquiry={i} customers={customers} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
