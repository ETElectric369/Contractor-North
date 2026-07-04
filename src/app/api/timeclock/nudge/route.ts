import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendSms } from "@/lib/sms";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz } from "@/lib/tz";

/**
 * "If no clock-in, send text" — runs on a schedule (Vercel Cron). For each org
 * (the service client bypasses RLS, so every query MUST be org-scoped — otherwise
 * one global pass would text every tenant's techs), finds active techs who have NOT
 * clocked in today and texts them. Re-runs naturally nag until they clock in.
 * Per-org opt-out via settings.remind_timeclock === false (default on).
 *
 *   GET /api/timeclock/nudge   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const { data: orgs } = await supabase.from("organizations").select("id, settings");
  let checked = 0;
  let texted = 0;

  for (const org of orgs ?? []) {
    if ((org.settings ?? {}).remind_timeclock === false) continue; // per-org opt-out
    const { data: techs } = await supabase
      .from("profiles")
      .select("id, full_name, phone")
      .eq("org_id", org.id)
      .eq("active", true)
      .eq("role", "tech");
    if (!techs?.length) continue;

    // "Today" is the org's LOCAL day, not the (UTC-on-Vercel) server day, so an
    // early/late clock-in counts against the right calendar day.
    const { dayStart } = todayBoundsInTz(getOrgSettings(org.settings).timezone);
    const { data: clockedIn } = await supabase
      .from("time_entries")
      .select("profile_id")
      .eq("org_id", org.id)
      .gte("clock_in", dayStart.toISOString());
    const clockedSet = new Set((clockedIn ?? []).map((e: any) => e.profile_id));

    checked += techs.length;
    for (const t of techs.filter((t: any) => !clockedSet.has(t.id))) {
      const sent = await sendSms(
        t.phone,
        `Good morning ${t.full_name ?? ""}! You haven't clocked in yet. Open Contractor North to clock in.`,
      );
      if (sent) texted++;
    }
  }

  return NextResponse.json({ checked, texted });
}
