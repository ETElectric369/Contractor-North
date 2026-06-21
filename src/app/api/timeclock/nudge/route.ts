import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";

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

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

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

    const { data: clockedIn } = await supabase
      .from("time_entries")
      .select("profile_id")
      .eq("org_id", org.id)
      .gte("clock_in", startOfDay.toISOString());
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
