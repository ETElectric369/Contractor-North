import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendDueReminders } from "@/lib/reminders-engine";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/**
 * Customer reminders on a tighter cadence (Vercel Cron — the Pro plan lifts the once-daily cap).
 * Split OUT of /api/automations/daily so overdue-invoice, quote-follow-up, and especially
 * appointment reminders (which have a ~36h horizon) fire a few times a day instead of once.
 *
 * Safe to run often: sendDueReminders is fully deduped by reminder_log (per-kind weekly caps +
 * max counts), so an extra run never double-sends. Deliberately does NOT touch recurring-job
 * generation or the day-ahead digest — those stay on the DAILY cron, because generating recurring
 * jobs more than once a day could create duplicates. Scheduled in daytime hours only (see
 * vercel.json) so customers never get an overnight email.
 *
 * Protected by CRON_SECRET (Vercel sends it automatically):
 *   GET /api/automations/reminders   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  try {
    const reminders = await sendDueReminders(guard.supabase);
    return NextResponse.json({ ok: true, reminders });
  } catch (e: unknown) {
    reportError("cron-reminders-frequent", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
