import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listCustomerOptions } from "@/lib/schedule-options";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { FactsGrid, StatTile } from "@/components/ui/stat-tile";
import { InquiryModal } from "./inquiry-modal";
import { InquiryRow } from "./inquiry-row";
import { ReferralTally } from "./referral-tally";
import type { Inquiry } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const { focus } = await searchParams;
  const supabase = await createClient();

  const [{ data: inqData }, { data: custData }] = await Promise.all([
    supabase
      .from("inquiries")
      .select("*, referrer:profiles!inquiries_referred_by_fkey(full_name)")
      .is("converted_at", null)
      .neq("status", "lost")
      // Hottest qualified leads first (priority = size × readiness × reachability). Legacy /
      // manually-added leads are all priority 0, so they tie here and keep the original
      // follow-up-due → newest ordering below — an org with no triaged leads is unaffected.
      .order("priority", { ascending: false })
      .order("next_follow_up_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false }),
    listCustomerOptions(supabase),
  ]);

  const inquiries = (inqData ?? []) as Inquiry[];
  const customers = (custData ?? []) as { id: string; name: string }[];

  // A deep-link can point at a lead that already left the open list — a just-converted lead,
  // or the "From lead" backlink on an estimate/job (which points at a now-converted lead). Fetch
  // that one by id and surface it at the top so the link always lands on a real, flashing row
  // instead of an empty list. Its status badge (quoted/won) makes clear it's already been acted on.
  let focusExtra: Inquiry | null = null;
  if (focus && !inquiries.some((i) => i.id === focus)) {
    const { data } = await supabase
      .from("inquiries")
      .select("*, referrer:profiles!inquiries_referred_by_fkey(full_name)")
      .eq("id", focus)
      .maybeSingle();
    focusExtra = (data as Inquiry) ?? null;
  }
  const rows = focusExtra ? [focusExtra, ...inquiries] : inquiries;

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

      {rows.length === 0 ? (
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
            {rows.map((i) => (
              <InquiryRow key={i.id} inquiry={i} customers={customers} focused={i.id === focus} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
