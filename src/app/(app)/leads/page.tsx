import Link from "next/link";
import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz } from "@/lib/tz";
import { INSPECTION_TYPES } from "@/lib/statuses";
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
  searchParams: Promise<{ focus?: string; due?: string }>;
}) {
  const { focus, due } = await searchParams;
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

  /**
   * WHICH LEADS HAVE ALREADY BEEN WALKED.
   *
   * Erik: "the sarah cain lead was already converted to an inspection but still shows up as a
   * new lead." Staying OPEN is correct and deliberate — leads/actions.ts documents inspection as
   * exempt from converting, so an inspected lead can still go on to become an estimate. What was
   * wrong is that her row looked IDENTICAL to a lead nobody had touched: three inspections, one
   * of them completed with a full capture, and not a mark on the list to say so.
   *
   * So this is a display fix, not a status change. Counts only — the row says what happened, the
   * status keeps meaning what it has always meant.
   */
  const leadIds = (inqData ?? []).map((i: { id: string }) => i.id);
  const { data: inspRows } = leadIds.length
    ? await supabase
        .from("appointments")
        .select("inquiry_id, status")
        .in("inquiry_id", leadIds)
        .in("type", [...INSPECTION_TYPES])
        .neq("status", "cancelled")
        .limit(500)
    : { data: [] as { inquiry_id: string; status: string }[] };
  const inspectionState = new Map<string, { done: number; upcoming: number }>();
  for (const r of (inspRows ?? []) as { inquiry_id: string; status: string }[]) {
    const cur = inspectionState.get(r.inquiry_id) ?? { done: 0, upcoming: 0 };
    if (r.status === "completed") cur.done += 1;
    else cur.upcoming += 1;
    inspectionState.set(r.inquiry_id, cur);
  }

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
  // ?due=1 — THE FOLLOW-UP LIST, as a lens on this board rather than a new page (the shape the
  // layout mock recommended and everyone agreed to). next_follow_up_at already IS the follow-up
  // list (cn-v612); this is the first surface that shows it as one.
  const dueOnly = due === "1";
  // Same cutoff as the dueToday tile below — the lens and the number it sits on must agree.
  // "Due" means due by the end of TODAY in the ORG's day, not the server's UTC day (audit 7:
  // from 5 PM Pacific the old server-local cutoff counted tomorrow's follow-ups as due — a
  // 7-hour phantom-overdue window every evening).
  const { data: tzRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const { dayEnd: dueCutoff } = todayBoundsInTz(getOrgSettings((tzRow as { settings?: unknown } | null)?.settings).timezone);
  const base = focusExtra ? [focusExtra, ...inquiries] : inquiries;
  const rows = dueOnly
    ? base.filter((i) => i.next_follow_up_at && new Date(i.next_follow_up_at) < dueCutoff)
    : base;

  // The tile and the ?due=1 lens MUST share one cutoff, or the count and the list disagree.
  const dueToday = inquiries.filter(
    (i) => i.next_follow_up_at && new Date(i.next_follow_up_at) < dueCutoff,
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
          {/* The tiles are the FILTER now — tap "Follow-ups due" and the board shows only what's
              due; tap "Open inquiries" (or it again) and everything is back. State lives in the
              URL, so the lens survives a refresh and can be sent to somebody. */}
          <Link href="/leads" aria-current={!dueOnly ? "true" : undefined} className={!dueOnly ? "rounded-xl ring-2 ring-brand" : ""}>
            <StatTile label="Open inquiries" value={inquiries.length} />
          </Link>
          <Link href="/leads?due=1" aria-current={dueOnly ? "true" : undefined} className={dueOnly ? "rounded-xl ring-2 ring-brand" : ""}>
            <StatTile label="Follow-ups due" value={dueToday} tone={dueToday > 0 ? "warning" : "default"} />
          </Link>
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
              <InquiryRow
                key={i.id}
                inquiry={i}
                customers={customers}
                focused={i.id === focus}
                inspections={inspectionState.get(i.id) ?? null}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
