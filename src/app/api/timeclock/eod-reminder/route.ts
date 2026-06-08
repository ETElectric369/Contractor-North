import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";

/**
 * End-of-day "fill out your form" reminder. Runs on an evening schedule (Vercel
 * Cron). Texts active techs who, for today, either:
 *   • are still clocked in (open entry) — remind them to clock out, or
 *   • clocked out but left no notes and no job breakdown — remind them to fill
 *     out their end-of-day form.
 * Re-running only texts those still not done, so it "nags" until complete.
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
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY not configured." },
      { status: 500 },
    );
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [{ data: techs }, { data: entries }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, phone")
      .eq("active", true)
      .eq("role", "tech"),
    supabase
      .from("time_entries")
      .select("profile_id, status, notes, time_allocations(id)")
      .gte("clock_in", startOfDay.toISOString()),
  ]);

  const byTech = new Map<string, any[]>();
  for (const e of entries ?? []) {
    const list = byTech.get(e.profile_id) ?? [];
    list.push(e);
    byTech.set(e.profile_id, list);
  }

  const results: { name: string; reason: string; sent: boolean }[] = [];

  for (const t of techs ?? []) {
    const todays = byTech.get(t.id) ?? [];
    if (todays.length === 0) continue; // never clocked in — handled by /nudge

    const stillOpen = todays.some((e) => e.status === "open");
    const anyDocumented = todays.some(
      (e) =>
        (e.notes && e.notes.trim()) ||
        (e.time_allocations && e.time_allocations.length > 0),
    );

    let reason = "";
    let message = "";
    if (stillOpen) {
      reason = "still_clocked_in";
      message = `Hi ${t.full_name ?? ""} — you're still clocked in. Please clock out and fill out your end-of-day form in Contractor North.`;
    } else if (!anyDocumented) {
      reason = "no_eod_form";
      message = `Hi ${t.full_name ?? ""} — please fill out your end-of-day form (what you worked on today) in Contractor North.`;
    } else {
      continue; // done for the day
    }

    const sent = await sendSms(t.phone, message);
    results.push({ name: t.full_name, reason, sent });
  }

  return NextResponse.json({ checked: techs?.length ?? 0, reminded: results.length, results });
}
