import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { generateDueTemplates } from "@/lib/recurring-engine";
import { sendDayAheadDigests } from "@/lib/action-items/digest";
import { generateNortReviewsForAllOrgs } from "@/lib/nort/review";
import { sweepOrphanedUploads } from "@/lib/storage-sweep";
import { backfillProcessorFees } from "@/lib/processor-fee-capture";
import { reportError } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";
import { findShelfProblems } from "@/lib/stock-reconcile-check";
import { tellStaleBankTransfers } from "@/lib/bank-transfer-alerts";
import { sweepErrorEvents } from "@/lib/error-retention";
import { sendBugWatchDigest } from "@/lib/bug-watch-digest";
import { sendBillingNotices } from "@/lib/billing-notices";
import { sendUsageNotices } from "@/lib/usage-notice-run";
import { getOrgSettings } from "@/lib/org-settings";
import { DAILY_LOCAL_HOUR, GLOBAL_UTC_HOUR, atLocalHour, readAllOrgs } from "@/lib/cron-orgs";

export const runtime = "nodejs";
// The steps run one after another and the Nort review is a model call per company (cn-v1130):
// Vercel's default minute would cut the night off mid-step with no row anywhere to say so.
export const maxDuration = 300;

/** The Nort review's share of the run, measured from the run's own start (the clock Vercel's 300 s
 *  runs on): it is the slow step, and the steps after it still need their turn. */
const NORT_REVIEW_BUDGET_MS = 200_000;

/**
 * The daily automation runner (Vercel Cron). One scheduled endpoint that does the
 * org-wide background work the app can't do interactively.
 *
 * HOURLY, ON TWO CLOCKS (2026-11-02, the day after DST ended). It ran at 15:00 UTC, an hour tuned to
 * Pacific summer: the fall-back moved every company's morning to 7 AM, and a company in any other
 * zone never had its own morning at all. Now vercel.json runs it every hour ("0 * * * *") and:
 *   - the COMPANY steps run for each company on the run that falls in ITS 8 AM (DAILY_LOCAL_HOUR,
 *     atLocalHour on the org's timezone, judged on the hour the run BEGAN): recurring templates,
 *     stale bank transfers, the billing and usage notices, the day-ahead digest, Nort's review, the
 *     shelf check. The due companies are worked out ONCE, up top, and handed to each step; a run
 *     with none due runs none of them. Each is once a day per company on its own (see each step).
 *   - the GLOBAL steps (North's own housekeeping) run once a day, on the run that begins in
 *     GLOBAL_UTC_HOUR: the processor-fee backfill, the error sweep, the Bug Watch digest (its own
 *     Monday rule in PLATFORM_TZ inside), the rate-limit and storage sweeps.
 *   The answer adds `companies: { due, not_due_yet, failed }` and `global: "ran" | "skipped"`.
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
  // One clock for the whole run, taken BEFORE the company read (cn-v1130's rule): a company late in
  // the list, or a slow read, is judged on the hour the run began, never on the one it reached.
  const startedAt = Date.now();

  const result: Record<string, unknown> = { ok: true };
  // The steps this run attempted: "every step failed" is judged against THESE, not a fixed twelve
  // (an off-hour run with no company due attempts none; the 15:00 UTC run attempts the five global).
  let attempted = 0;

  // THE COMPANIES AT THEIR OWN 8 AM. Every company whole (readAllOrgs), each judged inside its own
  // try: a timezone Intl cannot read costs that one company its morning, counted and filed, never
  // the rest of the list theirs. A failed read is a failed step (companies_error) and runs no
  // company step: a failed read reaches nobody.
  const companies = { due: 0, not_due_yet: 0, failed: 0 };
  const dueIds = new Set<string>();
  let companiesRead = false;
  try {
    const orgs = await readAllOrgs<{ id: string; settings: unknown }>(supabase);
    companiesRead = true;
    for (const org of orgs) {
      try {
        if (atLocalHour(getOrgSettings(org.settings).timezone, DAILY_LOCAL_HOUR, startedAt)) {
          dueIds.add(org.id);
          companies.due++;
        } else {
          companies.not_due_yet++;
        }
      } catch (e) {
        companies.failed++;
        reportError("cron-daily-hour", e, { orgId: org.id });
      }
    }
  } catch (e: any) {
    attempted++; // the read is a step only when it fails: then it is the one company step this run tried
    result.companies_error = e?.message ?? "failed";
    reportError("cron-daily-companies", e);
  }
  result.companies = companies;
  const companyRun = companiesRead && dueIds.size > 0;
  const globalRun = new Date(startedAt).getUTCHours() === GLOBAL_UTC_HOUR;
  result.global = globalRun ? "ran" : "skipped";
  const only = { orgIds: dueIds as ReadonlySet<string> };

  if (companyRun) {
    attempted++;
    try {
      // The engine answers two counts (cn-v1137): what it made, and the templates it left alone
      // because their company's plan has ended. Flattened, so the run's body reads one key per fact.
      // ONCE A DAY: claim-first on next_date (a period is taken only while next_date still holds the
      // value read), so a second run the same day finds nothing due.
      const recurring = await generateDueTemplates(supabase, null, only);
      result.recurring_generated = recurring.generated;
      result.recurring_lapsed_skipped = recurring.lapsed_skipped;
    } catch (e: any) {
      result.recurring_error = e?.message ?? "failed";
      reportError("cron-recurring", e);
    }
  }
  if (globalRun) {
    attempted++;
    try {
      // Stripe's real fee onto every online payment still missing one (migration 0284): the ones
      // the webhook could not read at the moment the money landed, and the payments recorded before
      // the column existed. Server-side because the Stripe keys live here; bounded per run.
      result.processor_fees = await backfillProcessorFees(supabase);
    } catch (e: any) {
      result.processor_fees_error = e?.message ?? "failed";
      reportError("cron-processor-fees", e);
    }
  }
  if (companyRun) {
    attempted++;
    try {
      // A BANK TRANSFER "ON ITS WAY" FOR MORE THAN A WEEK (audit v994 BK3, 0338). ACH takes 3-5
      // business days; a debit still pending after 7 means its async event never reached us (most
      // likely not subscribed on the connected-accounts webhook), and the invoice may sit open over
      // money that already landed. The office is told once per transfer (the stale_alerted_at stamp),
      // in words, and ops hears too.
      result.stale_bank_transfers = await tellStaleBankTransfers(supabase, new Date(startedAt), only);
    } catch (e: any) {
      result.stale_bank_transfers_error = e?.message ?? "failed";
      reportError("cron-stale-bank-transfers", e);
    }
    attempted++;
    try {
      // THE BILLING NOTICES (cn-v1137, 0400): the trial's last days, a declined card with the grace
      // window closing, the day a plan ends — to the owner and admins, once each, behind the stamp
      // claim_billing_notice writes first. North's own work, so it reads every company, comped ones
      // counted as skipped; with billing off nothing is read.
      result.billing_notices = await sendBillingNotices(supabase, startedAt, only);
    } catch (e: any) {
      result.billing_notices_error = e?.message ?? "failed";
      reportError("cron-billing-notices", e);
    }
    attempted++;
    try {
      // THE USAGE NOTICES (cn-v1140): one meter, Usage — at 80% of the month's budget the owner and
      // admins are told once, at 100% once more, behind the same stamp (claim_billing_notice); past
      // 100% nothing stops, Nort and the estimator run lighter until the 1st. Every company that is
      // not lapsed, comped ones included; a meter that could not be read tells nobody.
      result.usage_notices = await sendUsageNotices(supabase, startedAt, only);
    } catch (e: any) {
      result.usage_notices_error = e?.message ?? "failed";
      reportError("cron-usage-notices", e);
    }
    // Customer reminders (quote follow-up / invoice due / appts) moved to their OWN cron
    // /api/automations/reminders (a few times a day, not just here) — see that route.
    attempted++;
    try {
      // Staff "day ahead" push digest — opt-in per user (push_prefs.day_ahead,
      // enforced inside sendPushToProfiles); an org with no open items sends nothing. Once a day per
      // person: someone whose bell already has today's day_ahead line is passed over.
      result.day_ahead = await sendDayAheadDigests(supabase, only);
    } catch (e: any) {
      result.day_ahead_error = e?.message ?? "failed";
      reportError("cron-day-ahead", e);
    }
  }
  // The "Close out your day" nudge moved to the EVENING cron (eod-reminder, 6pm local-ish) —
  // Erik: the debrief is a NIGHT ritual; mornings keep the day-ahead digest only.

  // THE SINK'S TWO STEPS RUN BEFORE THE NORT REVIEW (skeptic #42, N2): they are cheap, and behind the
  // review's 200 s budget they were the first to be cut when the night ran long.
  if (globalRun) {
    attempted++;
    try {
      // THE SINK KEEPS ONLY WHAT IS STILL NEWS (cn-v1136, 0399): fixed and ignored rows go after
      // their time, traces after a week. The rule is the database's; this is the nightly knock.
      result.error_sweep = await sweepErrorEvents(supabase);
    } catch (e: any) {
      result.error_sweep_error = e?.message ?? "failed";
      reportError("cron-error-sweep", e);
    }

    attempted++;
    try {
      // THE MONDAY DIGEST (cn-v1136): on North's own Monday (or the first of Tuesday and Wednesday to
      // get through, N1), every platform admin gets the week's numbers once — open reports, new
      // errors, the blockers, the loudest culprits, what has sat open past thirty days. Every other
      // day it says "not Monday" and does nothing. Its own weekly claim keeps it to one.
      result.bug_watch_digest = await sendBugWatchDigest(supabase, startedAt);
    } catch (e: any) {
      result.bug_watch_digest_error = e?.message ?? "failed";
      reportError("cron-bug-watch-digest", e);
    }
  }

  if (companyRun) {
    attempted++;
    try {
      // Nort's self-review — read the crew's recent Nort conversations + bug reports and cluster them
      // into "what to build/fix next." The active half of the learning loop; staff read it back in-app.
      // A deadline rides along (cn-v1130): a model call per company adds up, and past its share of
      // the run the review stops and files how many companies it did not reach, instead of Vercel
      // cutting the function with the steps after it undone and no row anywhere. Once a day per
      // company: one with a review made in the last 20 hours is counted `already`.
      const review = await generateNortReviewsForAllOrgs(supabase, { deadlineMs: startedAt + NORT_REVIEW_BUDGET_MS, ...only });
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

    attempted++;
    try {
      // THE SHELF ADDS UP (Shop Stock, Phase 2). stock_reconcile_problems plus the lot-cost drift the
      // view can't see; empty is the only healthy answer. Each problem goes to error_events, where
      // the morning ops review reads it (the sink keeps one row per problem and counts repeats).
      // Read only; cut to the companies at their 8 AM, so each shelf is checked once a day.
      const shelf = await findShelfProblems(supabase, only);
      for (const p of shelf.problems) {
        reportError("cron-stock-reconcile", new Error(`${p.problem}: ${p.detail}`), { orgId: p.orgId, lotId: p.lotId, billId: p.billId });
      }
      result.stock_reconcile = shelf.skipped ? { skipped: shelf.skipped } : { problems: shelf.problems.length };
    } catch (e: any) {
      result.stock_reconcile_error = e?.message ?? "failed";
      reportError("cron-stock-reconcile", e);
    }
  }

  if (globalRun) {
    attempted++;
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

    attempted++;
    try {
      // Storage janitor (Erik: "we shouldnt hold onto old orphaned data") — orphaned intake
      // uploads, dead capture-photo folders, leaked estimator stashes. 48h age guard; SQL can't
      // touch storage, so this is the one place the Storage API reaps what deletions left behind.
      result.storage_sweep = await sweepOrphanedUploads();
    } catch (e: any) {
      result.storage_sweep_error = e?.message ?? "failed";
      reportError("cron-storage-sweep", e);
    }
  }

  // SINK-07 (cn-v1130, rule changed by skeptic #34): a cron JSON nobody reads is not a report.
  // Every step files its own row in the sink, but Vercel's cron log is the one place that goes red,
  // and it reads only the status. So ANY failed step answers 500 with ok false and its *_error key.
  const errors = Object.keys(result).filter((k) => k.endsWith("_error"));
  result.ok = errors.length === 0;
  // EVERY STEP FAILED IS A BLOCKER (cn-v1136): a row per step reads as that many troubles; a run
  // where every step it attempted failed is the database or the service key gone, platform-wide, and
  // pages North's own team. Counted against the steps THIS run attempted (a failed company read is
  // one), so an off-hour run whose company read failed pages too, as the nudge's does.
  // Waited for: this function answers on the tick it files.
  if (attempted > 0 && errors.length === attempted) {
    await reportBlockerAwaited("cron-daily", new Error(`every step failed: ${errors.join(", ")}`));
  }
  return NextResponse.json(result, { status: errors.length > 0 ? 500 : 200 });
}
