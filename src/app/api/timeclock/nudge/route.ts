import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";

/**
 * "If no clock-in, send text" — runs on a schedule (Vercel Cron). Finds active
 * techs who have NOT clocked in today and texts them. Because cron re-runs and
 * only texts those still not clocked in, it naturally "nags" until they do.
 *
 * Protect with CRON_SECRET (Vercel sends it automatically):
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
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY not configured." },
      { status: 500 },
    );
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: techs } = await supabase
    .from("profiles")
    .select("id, full_name, phone")
    .eq("active", true)
    .eq("role", "tech");

  const { data: clockedIn } = await supabase
    .from("time_entries")
    .select("profile_id")
    .gte("clock_in", startOfDay.toISOString());

  const clockedSet = new Set((clockedIn ?? []).map((e: any) => e.profile_id));
  const missing = (techs ?? []).filter((t: any) => !clockedSet.has(t.id));

  const results: { name: string; sent: boolean }[] = [];
  for (const t of missing) {
    const sent = await sendSms(
      t.phone,
      `Good morning ${t.full_name ?? ""}! You haven't clocked in yet. Open Contractor North to clock in.`,
    );
    results.push({ name: t.full_name, sent });
  }

  return NextResponse.json({
    checked: techs?.length ?? 0,
    notClockedIn: missing.length,
    results,
  });
}
