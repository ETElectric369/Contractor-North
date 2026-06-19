import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { payPeriodForOffset, tzDayStartUtc, todayStrInTz } from "@/lib/tz";
import { hoursBetween } from "@/lib/utils";
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
  if (!me || !["owner", "admin", "office"].includes(me.role)) redirect("/timeclock");

  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as any)?.settings);
  const period = payPeriodForOffset(settings.pay_schedule, settings.pay_anchor, todayStrInTz(settings.timezone), offset);
  const startIso = tzDayStartUtc(period.start, settings.timezone).toISOString();
  const endIso = tzDayStartUtc(period.end, settings.timezone).toISOString();

  const { data: entries } = await supabase
    .from("time_entries")
    .select("profile_id, clock_in, clock_out, lunch_minutes, miles, paid_at, profiles(full_name, hourly_rate)")
    .eq("status", "closed")
    .not("clock_out", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);

  type Rec = { name: string; rate: number; unpaidHours: number; unpaidMiles: number; paidHours: number; paidMiles: number };
  const byProfile = new Map<string, Rec>();
  for (const e of (entries ?? []) as any[]) {
    const rec =
      byProfile.get(e.profile_id) ??
      { name: e.profiles?.full_name ?? "—", rate: Number(e.profiles?.hourly_rate ?? 0), unpaidHours: 0, unpaidMiles: 0, paidHours: 0, paidMiles: 0 };
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    const m = Number(e.miles ?? 0);
    if (e.paid_at) { rec.paidHours += h; rec.paidMiles += m; } else { rec.unpaidHours += h; rec.unpaidMiles += m; }
    byProfile.set(e.profile_id, rec);
  }
  const rows = [...byProfile.entries()]
    .map(([profileId, r]) => ({ profileId, ...r }))
    .filter((r) => r.unpaidHours > 0 || r.paidHours > 0)
    .sort((a, b) => b.unpaidHours - a.unpaidHours || b.paidHours - a.paidHours);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Payroll" description="Hours, gross pay & mileage per pay period. Mark hours paid when you pay the crew; export for your accountant." />
      <PayrollView
        rows={rows}
        period={period}
        offset={offset}
        mileageRate={settings.mileage_rate}
      />
    </div>
  );
}
