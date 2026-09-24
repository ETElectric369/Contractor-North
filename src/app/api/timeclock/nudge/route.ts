import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendSms, smsReadiness } from "@/lib/sms";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz } from "@/lib/tz";

/**
 * "If no clock-in, send text" — runs on a schedule (Vercel Cron). For each org
 * (the service client bypasses RLS, so every query MUST be org-scoped — otherwise
 * one global pass would text every tenant's techs), finds active techs who have NOT
 * clocked in today and texts them. Re-runs naturally nag until they clock in.
 * Per-org opt-out via settings.remind_timeclock === false (default on). An org that cannot text
 * yet (lib/sms-readiness) is skipped and counted in `not_ready`.
 *
 *   GET /api/timeclock/nudge   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const { data: orgs } = await supabase.from("organizations").select("id, name, settings");
  let checked = 0;
  let texted = 0;
  let not_ready = 0;

  for (const org of orgs ?? []) {
    if (!getOrgSettings(org.settings).remind_timeclock) continue; // per-org opt-out (Settings → Scheduling)
    // TEXTING NOT SET UP (lib/sms-readiness): the org's choice is kept, nothing is sent, and the
    // skip is counted. Settings shows this option as not active and lists what is missing, so
    // the person who ticked it reads the truth there rather than in a cron reply nobody opens.
    if (!smsReadiness(org).ready) {
      not_ready++;
      continue;
    }
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
        (org.settings as any)?.sms_from_number,
      );
      if (sent) texted++;
    }
  }

  return NextResponse.json({ checked, texted, not_ready });
}
