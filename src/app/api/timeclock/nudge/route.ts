import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * "If no clock-in, send text" — meant to run on a schedule (e.g. Vercel Cron at
 * the start of the workday). Finds active techs who have NOT clocked in today
 * and texts them a reminder.
 *
 * Protect with a secret so only your cron can call it:
 *   GET /api/timeclock/nudge   Header: Authorization: Bearer <CRON_SECRET>
 *
 * Wire up SMS by filling in sendSms() with Twilio (or your provider).
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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

  // Active techs.
  const { data: techs } = await supabase
    .from("profiles")
    .select("id, full_name, phone")
    .eq("active", true)
    .eq("role", "tech");

  // Anyone who already has an entry today.
  const { data: clockedIn } = await supabase
    .from("time_entries")
    .select("profile_id")
    .gte("clock_in", startOfDay.toISOString());

  const clockedSet = new Set((clockedIn ?? []).map((e: any) => e.profile_id));
  const missing = (techs ?? []).filter((t: any) => !clockedSet.has(t.id));

  const results: { name: string; phone: string | null; sent: boolean }[] = [];
  for (const t of missing) {
    const sent = await sendSms(
      t.phone,
      `Good morning ${t.full_name ?? ""}! You haven't clocked in yet. Reply or open Contractor North to clock in.`,
    );
    results.push({ name: t.full_name, phone: t.phone, sent });
  }

  return NextResponse.json({
    checked: techs?.length ?? 0,
    notClockedIn: missing.length,
    results,
  });
}

/**
 * Stub SMS sender. To enable, add TWILIO_* env vars and uncomment the fetch.
 * Returns false (not sent) until configured, so the endpoint is safe to run.
 */
async function sendSms(to: string | null, body: string): Promise<boolean> {
  if (!to) return false;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.log(`[nudge] (SMS not configured) would text ${to}: ${body}`);
    return false;
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    },
  );
  return res.ok;
}
