import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { payPeriodForOffset, tzDayStartUtc, todayStrInTz } from "@/lib/tz";
import { aggregatePayrollEntries } from "@/lib/payroll-math";
import { PayrollView } from "./payroll-view";

export const dynamic = "force-dynamic";

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: pRaw } = await searchParams;
  const offset = Math.max(0, parseInt(pRaw ?? "0", 10) || 0);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  if (!me || !isStaffRole(me.role)) redirect("/timeclock");

  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as any)?.settings);
  const period = payPeriodForOffset(settings.pay_schedule, settings.pay_anchor, todayStrInTz(settings.timezone), offset);
  const startIso = tzDayStartUtc(period.start, settings.timezone).toISOString();
  const endIso = tzDayStartUtc(period.end, settings.timezone).toISOString();

  const { data: entries } = await supabase
    .from("time_entries")
    .select("profile_id, clock_in, clock_out, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, profiles(full_name, hourly_rate, commute_baseline_miles)")
    .eq("status", "closed")
    .not("clock_out", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);

  // Pass the org tz so business miles net the per-person daily commute baseline correctly.
  const rows = aggregatePayrollEntries((entries ?? []) as any[], settings.timezone);

  // Settled mileage dollars come ONLY from kind='mileage' runs — human-stated at
  // settlement time, never miles × rate. SUM per person: a late entry settled
  // later is a second run row for the same period. (Org scoping is RLS.)
  const { data: mileageRuns } = await supabase
    .from("payroll_runs")
    .select("profile_id, mileage_amount")
    .eq("kind", "mileage")
    .eq("period_start", period.start)
    .eq("period_end", period.end);
  const settledMileage: Record<string, number> = {};
  for (const run of (mileageRuns ?? []) as any[]) {
    const amt = Number(run.mileage_amount ?? 0);
    if (!run.profile_id || !Number.isFinite(amt)) continue;
    settledMileage[run.profile_id] = Math.round(((settledMileage[run.profile_id] ?? 0) + amt) * 100) / 100;
  }

  // The 48.50 lesson: still-open entries are EXCLUDED from the period by the closed-only
  // filter above — with zero indication, the period silently under-counts a whole shift.
  // Name the gap so the number is never trusted blind.
  const { data: openInPeriod } = await supabase
    .from("time_entries")
    .select("id, profiles(full_name)")
    .is("clock_out", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);
  const openNames = [...new Set((openInPeriod ?? []).map((e: any) => e.profiles?.full_name).filter(Boolean))];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Payroll" description="Base pay (hours × pay rate) per pay period. Mileage is tracked in miles and settled separately — mark each paid when you actually pay it; export for your accountant." />
      {openNames.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          {openInPeriod!.length} open {openInPeriod!.length === 1 ? "entry" : "entries"} ({openNames.join(", ")}) not counted — close {openInPeriod!.length === 1 ? "it" : "them"} on the timecards page and these totals will update.
        </div>
      )}
      <PayrollView
        rows={rows}
        period={period}
        offset={offset}
        settledMileage={settledMileage}
        taxNumber={settings.tax_number}
      />
    </div>
  );
}
