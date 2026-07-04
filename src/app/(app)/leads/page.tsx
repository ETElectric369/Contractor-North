import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { FactsGrid, StatTile } from "@/components/ui/stat-tile";
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
        <FactsGrid cols={2} className="mb-4 sm:max-w-sm">
          <StatTile label="Open inquiries" value={inquiries.length} />
          <StatTile label="Follow-ups due" value={dueToday} tone={dueToday > 0 ? "warning" : "default"} />
        </FactsGrid>
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
