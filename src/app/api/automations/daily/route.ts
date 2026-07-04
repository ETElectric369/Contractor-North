import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { generateDueTemplates } from "@/lib/recurring-engine";
import { sendDueReminders } from "@/lib/reminders-engine";
import { sendDayAheadDigests } from "@/lib/action-items/digest";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/**
 * The daily automation runner (Vercel Cron). One scheduled endpoint that does the
 * org-wide background work the app can't do interactively:
 *   - generate due recurring jobs/expenses (all orgs),
 *   - send opt-in customer reminders (quote follow-up / invoice due / appts),
 *   - push the staff "day ahead" digest (needs-action count + top items → /planner),
 *   - push the "Close out your day" money-leak nudge (stray time / uncosted work /
 *     missing return visit — YESTERDAY's gaps, since this cron runs mornings).
 *
 * Protected by CRON_SECRET (Vercel sends it automatically):
 *   GET /api/automations/daily   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

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
  try {
    // Staff "day ahead" push digest — opt-in per user (push_prefs.day_ahead,
    // enforced inside sendPushToProfiles); an org with no open items sends nothing.
    result.day_ahead = await sendDayAheadDigests(supabase);
  } catch (e: any) {
    result.day_ahead_error = e?.message ?? "failed";
    reportError("cron-day-ahead", e);
  }
  // The "Close out your day" nudge moved to the EVENING cron (eod-reminder, 6pm local-ish) —
  // Erik: the debrief is a NIGHT ritual; mornings keep the day-ahead digest only.

  return NextResponse.json(result);
}
