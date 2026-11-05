import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendDueReminders } from "@/lib/reminders-engine";
import { reportBlockerAwaited } from "@/lib/observe-blocker";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { REMINDER_LOCAL_HOURS, atLocalHour, readAllOrgs } from "@/lib/cron-orgs";

export const runtime = "nodejs";
// One email per due reminder across every company, in series (cn-v1130): Vercel's default minute
// would cut a busy morning off mid-run.
export const maxDuration = 300;

/**
 * Customer reminders on a tighter cadence (Vercel Cron — the Pro plan lifts the once-daily cap).
 * Split OUT of /api/automations/daily so overdue-invoice, quote-follow-up, and especially
 * appointment reminders (which have a ~36h horizon) fire a few times a day instead of once.
 *
 * Safe to run often: sendDueReminders is fully deduped by reminder_log (per-kind weekly caps +
 * max counts), so an extra run never double-sends. Deliberately does NOT touch recurring-job
 * generation or the day-ahead digest — those stay on the DAILY cron.
 *
 * HOURLY, EACH COMPANY ON ITS OWN THREE HOURS (2026-11-02, the day after DST ended). It ran at
 * 15/19/23 UTC — 8 AM, noon and 4 PM only in Pacific summer; since the fall-back 7, 11 and 3, and
 * for a company in any other zone whatever those UTC hours happened to be (an East Coast customer's
 * 7 PM). Now vercel.json runs it every hour and each company is handled on the runs that fall in ITS
 * 8 AM, noon and 4 PM (REMINDER_LOCAL_HOURS, atLocalHour on the org's timezone, judged on the hour
 * the run began), so a customer never gets an overnight email. The due companies are worked out
 * once, here, and handed to sendDueReminders; its reminder_log dedupe is unchanged. The answer adds
 * `companies: { due, not_due_yet, failed }`; a company whose zone cannot be read is counted in
 * failed and filed, and the rest still run.
 *
 * Protected by CRON_SECRET (Vercel sends it automatically):
 *   GET /api/automations/reminders   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  // One clock for the whole run, taken before the company read (cn-v1130's rule).
  const nowMs = Date.now();
  const companies = { due: 0, not_due_yet: 0, failed: 0 };
  try {
    const orgs = await readAllOrgs<{ id: string; settings: unknown }>(guard.supabase);
    const dueIds = new Set<string>();
    for (const org of orgs) {
      try {
        const tz = getOrgSettings(org.settings).timezone;
        if (REMINDER_LOCAL_HOURS.some((h) => atLocalHour(tz, h, nowMs))) {
          dueIds.add(org.id);
          companies.due++;
        } else {
          companies.not_due_yet++;
        }
      } catch (e) {
        // One company's unreadable zone is its own: counted, filed, and the rest still run.
        companies.failed++;
        reportError("cron-reminders-hour", e, { orgId: org.id });
      }
    }
    // No company at one of its hours: nothing is read, nothing is sent.
    if (dueIds.size === 0) return NextResponse.json({ ok: true, companies });
    const reminders = await sendDueReminders(guard.supabase, { orgIds: dueIds });
    return NextResponse.json({ ok: true, companies, reminders });
  } catch (e: unknown) {
    // Waited for (cn-v1130, skeptic #34): the 500 below is answered on the tick it files, and a
    // fire-and-forget write can freeze with it. A BLOCKER (cn-v1136): the whole run fell over, every
    // company's reminders with it, so the first such run pages North's own team.
    await reportBlockerAwaited("cron-reminders-frequent", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
