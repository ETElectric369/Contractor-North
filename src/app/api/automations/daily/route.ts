import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { generateDueTemplates } from "@/lib/recurring-engine";
import { sendDayAheadDigests } from "@/lib/action-items/digest";
import { generateNortReviewsForAllOrgs } from "@/lib/nort/review";
import { sweepOrphanedUploads } from "@/lib/storage-sweep";
import { backfillProcessorFees } from "@/lib/processor-fee-capture";
import { reportError } from "@/lib/observe";
import { findShelfProblems } from "@/lib/stock-reconcile-check";

export const runtime = "nodejs";

/**
 * The daily automation runner (Vercel Cron). One scheduled endpoint that does the
 * org-wide background work the app can't do interactively:
 *   - generate due recurring jobs/expenses (all orgs),
 *   - read Stripe's real processing fee onto online payments still missing one,
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
    // Stripe's real fee onto every online payment still missing one (migration 0284): the ones
    // the webhook could not read at the moment the money landed, and the payments recorded before
    // the column existed. Server-side because the Stripe keys live here; bounded per run.
    result.processor_fees = await backfillProcessorFees(supabase);
  } catch (e: any) {
    result.processor_fees_error = e?.message ?? "failed";
    reportError("cron-processor-fees", e);
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
    // Nort's self-review — read the crew's recent Nort conversations + bug reports and cluster them
    // into "what to build/fix next." The active half of the learning loop; staff read it back in-app.
    result.nort_reviews = await generateNortReviewsForAllOrgs(supabase);
  } catch (e: any) {
    result.nort_reviews_error = e?.message ?? "failed";
    reportError("cron-nort-review", e);
  }

  try {
    // THE SHELF ADDS UP (Shop Stock, Phase 2). stock_reconcile_problems plus the lot-cost drift the
    // view can't see; empty is the only healthy answer. Each problem goes to error_events, where
    // the morning ops review reads it. Read only.
    const shelf = await findShelfProblems(supabase);
    for (const p of shelf.problems) {
      reportError("cron-stock-reconcile", new Error(`${p.problem}: ${p.detail}`), { orgId: p.orgId, lotId: p.lotId, billId: p.billId });
    }
    result.stock_reconcile = shelf.skipped ? { skipped: shelf.skipped } : { problems: shelf.problems.length };
  } catch (e: any) {
    result.stock_reconcile_error = e?.message ?? "failed";
    reportError("cron-stock-reconcile", e);
  }

  try {
    // Housekeeping: drop stale public-endpoint rate-limit windows (>1 day old) so the
    // rate_limits table stays tiny. Cheap, idempotent, no-op when already clean.
    await supabase.rpc("rate_limit_gc");
    result.rate_limit_gc = true;
  } catch (e: any) {
    result.rate_limit_gc_error = e?.message ?? "failed";
    reportError("cron-rate-limit-gc", e);
  }

  try {
    // Storage janitor (Erik: "we shouldnt hold onto old orphaned data") — orphaned intake
    // uploads, dead capture-photo folders, leaked estimator stashes. 48h age guard; SQL can't
    // touch storage, so this is the one place the Storage API reaps what deletions left behind.
    result.storage_sweep = await sweepOrphanedUploads();
  } catch (e: any) {
    result.storage_sweep_error = e?.message ?? "failed";
    reportError("cron-storage-sweep", e);
  }

  return NextResponse.json(result);
}
