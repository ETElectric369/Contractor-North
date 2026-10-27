import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { generateDueTemplates } from "@/lib/recurring-engine";
import { sendDayAheadDigests } from "@/lib/action-items/digest";
import { generateNortReviewsForAllOrgs } from "@/lib/nort/review";
import { sweepOrphanedUploads } from "@/lib/storage-sweep";
import { backfillProcessorFees } from "@/lib/processor-fee-capture";
import { reportError } from "@/lib/observe";
import { findShelfProblems } from "@/lib/stock-reconcile-check";
import { tellStaleBankTransfers } from "@/lib/bank-transfer-alerts";

export const runtime = "nodejs";
// The steps run one after another and the Nort review is a model call per company (cn-v1130):
// Vercel's default minute would cut the night off mid-step with no row anywhere to say so.
export const maxDuration = 300;

/** The Nort review's share of the run, measured from the run's own start (the clock Vercel's 300 s
 *  runs on): it is the slow step, and the three after it still need their turn. */
const NORT_REVIEW_BUDGET_MS = 200_000;

/**
 * The daily automation runner (Vercel Cron). One scheduled endpoint that does the
 * org-wide background work the app can't do interactively:
 *   - generate due recurring jobs/expenses (all orgs),
 *   - read Stripe's real processing fee onto online payments still missing one,
 *   - push the staff "day ahead" digest (needs-action count + top items → /planner),
 *   - push the "Close out your day" money-leak nudge (stray time / uncosted work /
 *     missing return visit — YESTERDAY's gaps, since this cron runs mornings).
 *
 * The answer is honest (cn-v1130): `ok` is false and the status is 500 when ANY step failed (its
 * *_error key says which) — see the end of GET.
 *
 * Protected by CRON_SECRET (Vercel sends it automatically):
 *   GET /api/automations/daily   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;
  const startedAt = Date.now();

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
  try {
    // A BANK TRANSFER "ON ITS WAY" FOR MORE THAN A WEEK (audit v994 BK3, 0338). ACH takes 3-5
    // business days; a debit still pending after 7 means its async event never reached us (most
    // likely not subscribed on the connected-accounts webhook), and the invoice may sit open over
    // money that already landed. The office is told once per transfer, in words, and ops hears too.
    result.stale_bank_transfers = await tellStaleBankTransfers(supabase);
  } catch (e: any) {
    result.stale_bank_transfers_error = e?.message ?? "failed";
    reportError("cron-stale-bank-transfers", e);
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
    // A deadline rides along (cn-v1130): a model call per company adds up, and past its share of
    // the run the review stops and files how many companies it did not reach, instead of Vercel
    // cutting the function with the steps after it undone and no row anywhere.
    const review = await generateNortReviewsForAllOrgs(supabase, { deadlineMs: startedAt + NORT_REVIEW_BUDGET_MS });
    result.nort_reviews = review;
    // A REVIEW THAT MADE NOTHING IS A FAILED STEP (cn-v1130, skeptic #34). The review files its own
    // per-company rows and never throws for them, so a revoked key (every company failed) or a
    // starved run (the deadline left companies unreviewed) would have answered a green 200.
    if (review.failed > 0 && review.made === 0) {
      result.nort_reviews_error = `every company with activity failed: ${review.failed}`;
    } else if (review.left > 0) {
      result.nort_reviews_error = `cut short: ${review.left} companies not reviewed`;
    }
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
    // supabase-js never throws on a database error: it hands it back (cn-v1130, skeptic #34).
    const { error } = await supabase.rpc("rate_limit_gc");
    if (error) throw error;
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

  // SINK-07 (cn-v1130, rule changed by skeptic #34): a cron JSON nobody reads is not a report.
  // Every step files its own row in the sink, but Vercel's cron log is the one place that goes red,
  // and it reads only the status. So ANY failed step answers 500 with ok false and its *_error key.
  // The first rule (500 only when EVERY step failed) could never fire: several steps fail closed
  // without throwing, so "all eight" was unreachable and a failed step stayed green.
  const errors = Object.keys(result).filter((k) => k.endsWith("_error"));
  result.ok = errors.length === 0;
  return NextResponse.json(result, { status: errors.length > 0 ? 500 : 200 });
}
