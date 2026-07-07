import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { generateDueTemplates } from "@/lib/recurring-engine";
import { sendDayAheadDigests } from "@/lib/action-items/digest";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/**
 * The daily automation runner (Vercel Cron). One scheduled endpoint that does the
 * org-wide background work the app can't do interactively:
 *   - generate due recurring jobs/expenses (all orgs),
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
  // Customer reminders (quote follow-up / invoice due / appts) moved to their OWN cron
  // /api/automations/reminders (a few times a day, not just here) — see that route.
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

  try {
    // Housekeeping: drop stale public-endpoint rate-limit windows (>1 day old) so the
    // rate_limits table stays tiny. Cheap, idempotent, no-op when already clean.
    await supabase.rpc("rate_limit_gc");
    result.rate_limit_gc = true;
  } catch (e: any) {
    result.rate_limit_gc_error = e?.message ?? "failed";
    reportError("cron-rate-limit-gc", e);
  }

  return NextResponse.json(result);
}
