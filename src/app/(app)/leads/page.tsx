import Link from "next/link";
import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { listCustomerOptions } from "@/lib/schedule-options";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { FactsGrid, StatTile } from "@/components/ui/stat-tile";
import { InquiryModal } from "./inquiry-modal";
import { InquiryRow } from "./inquiry-row";
import { ReferralTally } from "./referral-tally";
import type { Inquiry } from "@/lib/types";
import { readLeadVisits } from "@/lib/leads/visit-read";
import { viewerSwitches } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";

export const dynamic = "force-dynamic";

export default async function InquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; due?: string }>;
}) {
  const { focus, due } = await searchParams;
  const supabase = await createClient();

  const [{ data: inqData }, { data: custData }, sw] = await Promise.all([
    supabase
      .from("inquiries")
      .select("*, referrer:profiles!inquiries_referred_by_fkey(full_name)")
      .is("converted_at", null)
      .neq("status", "lost")
      // Hottest qualified leads first (priority = size × readiness × reachability). Legacy /
      // manually-added leads are all priority 0, so they tie here and keep the original
      // follow-up-due → newest ordering below — an org with no triaged leads is unaffected.
      .order("priority", { ascending: false })
      /* nullsFirst — a lead with NO follow-up date is an UNTOUCHED lead, and hiding it at the
         bottom of the pile is how "the new lead i just added isnt showing up" happened: he added
         it, scrolled the top, and concluded the save failed. Fresh and untouched belongs at the
         top ("new leads should be listed at the top of the page"); dated follow-ups sort below,
         soonest first, and the Due-today tile carries the due story. */
      .order("next_follow_up_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false }),
    listCustomerOptions(supabase),
    // THE SWITCH BOARD (0352). Leads off: this page still opens from a link (a Needs You card, an
    // estimate's "from lead"), with the shell's Off line on top, and New Lead goes. Website requests
    // keep arriving either way. Track Referrals off: no tally. Estimates off: no Estimate on a row.
    viewerSwitches(),
  ]);
  const leadsOn = featureOn(sw.features, "leads");

  const inquiries = (inqData ?? []) as Inquiry[];
  const customers = (custData ?? []) as { id: string; name: string }[];

  // A deep-link can point at a lead that already left the open list — a just-converted lead,
  // or the "From lead" backlink on an estimate/job (which points at a now-converted lead). Fetch
  // that one by id and surface it at the top so the link always lands on a real, flashing row
  // instead of an empty list. Its chip (Became An Estimate / Became A Job / Lost) makes clear it's
  // already been acted on.
  let focusExtra: Inquiry | null = null;
  if (focus && !inquiries.some((i) => i.id === focus)) {
    const { data } = await supabase
      .from("inquiries")
      .select("*, referrer:profiles!inquiries_referred_by_fkey(full_name)")
      .eq("id", focus)
      .maybeSingle();
    focusExtra = (data as Inquiry) ?? null;
  }

  /**
   * WHAT EACH LEAD'S VISITS SAY, for its one next-step chip (W2-07, lib/leads/next-step).
   *
   * Erik: "the sarah dale lead was already converted to an inspection but still shows up as a
   * new lead." Staying OPEN is correct and deliberate — leads/actions.ts documents inspection as
   * exempt from converting, so an inspected lead can still go on to become an estimate. What was
   * wrong is that her row looked IDENTICAL to a lead nobody had touched. So: how many visits are
   * done, how many are still booked, and the earliest booked start (with its type), so the chip
   * can say "Inspection · Tue Oct 1" or "Walked · Estimate Next". EVERY kind of visit counts,
   * not just inspections; cancelled ones never do.
   *
   * THE READ'S ERROR IS KEPT, and the batching with it (lib/leads/visit-read): one request carrying
   * every open lead's uuid outgrows the gateway past a couple of hundred leads, and five hundred rows
   * is not a busy book's whole appointment list. Either way the old `const { data } = await …` dropped
   * the error, so a failed read looked exactly like "no visits booked" and the chip told him to
   * cold-call a lead he was seeing Tuesday. A lead whose visits could not be read now says so.
   */
  const leadIds = [...(inqData ?? []).map((i: { id: string }) => i.id), ...(focusExtra ? [focusExtra.id] : [])];
  const visitState = await readLeadVisits(leadIds, (batch, cap) =>
    supabase
      .from("appointments")
      .select("inquiry_id, status, starts_at, type")
      .in("inquiry_id", batch)
      .neq("status", "cancelled")
      .limit(cap),
  );
  // ?due=1 — THE FOLLOW-UP LIST, as a lens on this board rather than a new page (the shape the
  // layout mock recommended and everyone agreed to). next_follow_up_at already IS the follow-up
  // list (cn-v612); this is the first surface that shows it as one.
  const dueOnly = due === "1";
  // "Due" is a CALENDAR-DATE question. next_follow_up_at is a bare `date` column, and
  // `new Date("YYYY-MM-DD")` is UTC midnight — 5 PM Pacific the evening BEFORE — so the old
  // instant-compare counted tomorrow's follow-ups as due every evening (this exact bug's third
  // appearance in the codebase). Two date-words compare as strings; no clock is consulted.
  // `phone` rides along with the settings read (PROJECTION LAW): the business line is what the
  // "Text it" handoff has to be able to NAME — see convert-menu for why naming it is the whole fix.
  const { data: tzRow } = await supabase.from("organizations").select("settings, phone").limit(1).maybeSingle();
  // The company's clock: today's date, and the day each chip's booked visit falls on.
  const tz = getOrgSettings((tzRow as { settings?: unknown } | null)?.settings).timezone;
  const todayYmd = todayStrInTz(tz);
  const businessPhone = ((tzRow as { phone?: string | null } | null)?.phone ?? "").trim() || null;
  const isDue = (i: { next_follow_up_at: string | null }) =>
    Boolean(i.next_follow_up_at && i.next_follow_up_at.slice(0, 10) <= todayYmd);
  const base = focusExtra ? [focusExtra, ...inquiries] : inquiries;
  const rows = dueOnly ? base.filter(isDue) : base;

  // The tile and the ?due=1 lens MUST share one cutoff, or the count and the list disagree.
  const dueToday = inquiries.filter(isDue).length;

  return (
    <div>
      <PageHeader title="Leads" description="New requests to follow up and convert — nothing converts automatically.">
        {leadsOn && <InquiryModal />}
      </PageHeader>

      {/* Staff-only commission lookup — renders nothing for crew or when no lead
          has a referrer. Sits above the open list because converted referrals
          drop OUT of that list and this is where their credit stays visible. */}
      {featureOn(sw.features, "referrals") && <ReferralTally />}

      {inquiries.length > 0 && (
        <FactsGrid cols={2} className="mb-4 sm:max-w-sm">
          {/* The tiles are the FILTER now — tap "Follow-Ups Due" and the board shows only what's
              due; tap "Open Leads" (or it again) and everything is back. State lives in the URL, so
              the lens survives a refresh and can be sent to somebody. Both count open leads only. */}
          <Link href="/leads" aria-current={!dueOnly ? "true" : undefined} className={!dueOnly ? "rounded-xl ring-2 ring-brand" : ""}>
            <StatTile label="Open Leads" value={inquiries.length} />
          </Link>
          <Link href="/leads?due=1" aria-current={dueOnly ? "true" : undefined} className={dueOnly ? "rounded-xl ring-2 ring-brand" : ""}>
            <StatTile label="Follow-Ups Due" value={dueToday} tone={dueToday > 0 ? "warning" : "default"} />
          </Link>
        </FactsGrid>
      )}

      {rows.length === 0 ? (
        // No duplicate "New lead" here (Andrew, 8/21: "leave the new lead button on the top
        // right and get rid of the button in the center its redundant") — the header's button
        // is always on screen, including over this empty state.
        <EmptyState
          icon={UserPlus}
          title="No open leads"
          description={
            leadsOn
              ? "Web submissions and manually-added leads show up here to follow up and convert — or add one with New Lead above."
              : "Nothing open right now."
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {rows.map((i) => (
              <InquiryRow
                key={i.id}
                inquiry={i}
                customers={customers}
                focused={i.id === focus}
                visits={visitState.forLead(i.id)}
                todayYmd={todayYmd}
                tz={tz}
                businessPhone={businessPhone}
                estimateDoor={featureOn(sw.features, "estimates")}
                referralsOn={featureOn(sw.features, "referrals")}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
