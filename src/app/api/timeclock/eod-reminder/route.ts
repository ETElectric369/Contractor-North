import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz } from "@/lib/tz";

/**
 * End-of-day "fill out your form" reminder. Runs on an evening schedule (Vercel
 * Cron). For each org (the service client bypasses RLS, so every query MUST be
 * org-scoped), texts active techs who, for today, either:
 *   • are still clocked in (open entry) — remind them to clock out, or
 *   • clocked out but left no notes and no job breakdown — fill out the EOD form.
 * Re-running only texts those still not done. Per-org opt-out via
 * settings.remind_timeclock === false (default on).
 *
 *   GET /api/timeclock/eod-reminder   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let supabase;
  try {
    supabase = createServiceClient();
  } catch {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured." }, { status: 500 });
  }

  const { data: orgs } = await supabase.from("organizations").select("id, settings");
  let checked = 0;
  let reminded = 0;

  for (const org of orgs ?? []) {
    if ((org.settings ?? {}).remind_timeclock === false) continue; // per-org opt-out
    // "Today" is the org's LOCAL day, not the (UTC-on-Vercel) server day, so a
    // Pacific evening shift counts toward today rather than tomorrow.
    const { dayStart } = todayBoundsInTz(getOrgSettings(org.settings).timezone);
    const [{ data: techs }, { data: entries }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, phone")
        .eq("org_id", org.id)
        .eq("active", true)
        .eq("role", "tech"),
      supabase
        .from("time_entries")
        .select("profile_id, status, notes, time_allocations(id)")
        .eq("org_id", org.id)
        .gte("clock_in", dayStart.toISOString()),
    ]);
    if (!techs?.length) continue;

    const byTech = new Map<string, any[]>();
    for (const e of entries ?? []) {
      const list = byTech.get(e.profile_id) ?? [];
      list.push(e);
      byTech.set(e.profile_id, list);
    }

    checked += techs.length;
    for (const t of techs) {
      const todays = byTech.get(t.id) ?? [];
      if (todays.length === 0) continue; // never clocked in — handled by /nudge

      const stillOpen = todays.some((e) => e.status === "open");
      const anyDocumented = todays.some(
        (e) => (e.notes && e.notes.trim()) || (e.time_allocations && e.time_allocations.length > 0),
      );

      let message = "";
      if (stillOpen) {
        message = `Hi ${t.full_name ?? ""} — you're still clocked in. Please clock out and fill out your end-of-day form in Contractor North.`;
      } else if (!anyDocumented) {
        message = `Hi ${t.full_name ?? ""} — please fill out your end-of-day form (what you worked on today) in Contractor North.`;
      } else {
        continue; // done for the day
      }

      const sent = await sendSms(t.phone, message);
      if (sent) reminded++;
    }
  }

  return NextResponse.json({ checked, reminded });
}
