import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { generateDueTemplates } from "@/lib/recurring-engine";
import { sendDueReminders } from "@/lib/reminders-engine";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/**
 * The daily automation runner (Vercel Cron). One scheduled endpoint that does the
 * org-wide background work the app can't do interactively:
 *   - generate due recurring jobs/expenses (all orgs),
 *   - (next) send opt-in customer reminders (quote follow-up / invoice due / appts).
 *
 * Protected by CRON_SECRET (Vercel sends it automatically):
 *   GET /api/automations/daily   Authorization: Bearer <CRON_SECRET>
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

  const result: Record<string, unknown> = { ok: true };
  try {
    result.recurring_generated = await generateDueTemplates(supabase, null);
  } catch (e: any) {
    result.recurring_error = e?.message ?? "failed";
    reportError("cron-recurring", e);
  }
  try {
    // Opt-in only: sends nothing for an org whose reminder toggles are off.
    result.reminders = await sendDueReminders(supabase);
  } catch (e: any) {
    result.reminders_error = e?.message ?? "failed";
    reportError("cron-reminders", e);
  }

  return NextResponse.json(result);
}
