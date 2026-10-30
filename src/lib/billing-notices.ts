import "server-only";
import { readAllOrgs, withBillingColumns } from "@/lib/cron-orgs";
import { renderPlatformNoticeEmail, sendEmail } from "@/lib/email";
import { notifyPeople } from "@/lib/notifications";
import { errorMessage, reportError } from "@/lib/observe";
import { langOf } from "@/lib/lang-of";
import type { Lang } from "@/lib/locale";
import { getOrgSettings } from "@/lib/org-settings";
import { billingEnabled } from "@/lib/stripe";
import { accessState, type AccessState } from "@/lib/subscription";

/**
 * THE BILLING NOTICES (cn-v1137, 0400). A company hears about its own standing with North BEFORE
 * the wall: the trial's last days (7, 3, 1 and the day itself), a declined card with the grace
 * window closing (3 days, 1 day), and the day a plan ends. Every notice goes to the owner and the
 * admins — the people who can pick a plan or update the card — as a bell line and a push under the
 * `billing` kind (notifyPeople, so the bell records it even when the push is muted), and ONE email
 * to the company's address, else the owner's. It runs from the daily cron, once a day.
 *
 * THE STAMP IS THE LOCK. organizations.billing_notices (0400) holds one ISO stamp per notice key, and
 * claim_billing_notice(p_org, p_key) writes it FIRST and answers whether it did: TRUE means this run
 * tells them, FALSE means a run already did. A notice is sent only behind a TRUE, so two overlapping
 * runs cannot say the same thing twice, and a run that comes back after a crash finds the stamp and
 * stays quiet. The price of that order: a bell or an email that fails AFTER the claim is a courtesy
 * lost, filed and counted, never retried by the next run — ONE LOST COURTESY BEATS A DUPLICATE EVERY
 * RUN (the stamp cannot be released by a sender that may have half-sent).
 *
 * THE KEYS. Trial: trial_7 · trial_3 · trial_1 · trial_0, once each per trial (the company never has
 * a second trial). Grace: grace_3:<period_end> · grace_1:<period_end>, keyed on the period that went
 * unpaid, so a card that fails again next year is told again. Lapsed: one key, `lapsed`, which the
 * Stripe webhook releases when a sync lands the company active, so a company that lapses again is
 * told again. The webhook's own declined-card line is past_due:<period_end>, claimed there.
 *
 * THE WORDS come from the REAL days left (the company's own calendar for the trial, accessState with
 * its timezone); the KEY comes from the threshold WINDOW the days left fall in — the smallest
 * threshold at or above them — and a window already stamped is never re-sent (dueTrialNotice). A day
 * the cron missed is SKIPPED, never caught up: a re-run on the same day (after a red 500, or a double
 * delivery) must find one stamp and stay quiet, where "the largest unstamped threshold" fired trial_7,
 * then 3, 1 and 0 across four re-runs of one morning (skeptic #43, S4). A comped company (the column
 * or the env list) is never told anything; with billing off there is nothing to lapse from and
 * nothing is read.
 */

/** The thresholds, largest first: the trial notices (days left) and the grace notices (days of grace left). */
export const TRIAL_THRESHOLDS = [7, 3, 1, 0] as const;
export const GRACE_THRESHOLDS = [3, 1] as const;

export const LAPSED_KEY = "lapsed";
/** Where every notice points: the plan and the card live on Settings › Getting Paid. */
export const NOTICE_URL = "/settings?tab=getpaid";

export type TrialThreshold = (typeof TRIAL_THRESHOLDS)[number];
export type GraceThreshold = (typeof GRACE_THRESHOLDS)[number];
export type LapsedReason = "trial_ended" | "grace_spent" | "canceled";
export type NoticeWords = { title: string; body: string };

/** One stamp per key: the notice's key → the ISO instant it was claimed (0400). */
export type Stamped = Record<string, unknown> | null | undefined;

const isStamped = (stamped: Stamped, key: string) => !!stamped && stamped[key] != null;

export const trialNoticeKey = (t: TrialThreshold) => `trial_${t}`;
export const graceNoticeKey = (t: GraceThreshold, periodEnd: string | null | undefined) => `grace_${t}:${periodEnd ?? "unknown"}`;

/** The window the days left fall in: the SMALLEST threshold at or above them (ascending), or none past
 *  the largest. Day 5 → 7, day 3 → 3, day 2 → 3, day 1 → 1, day 0 → 0, day 8 → none. */
function windowFor<T extends number>(thresholds: readonly T[], daysLeft: number): T | null {
  const ascending = [...thresholds].sort((a, b) => a - b);
  return ascending.find((t) => t >= daysLeft) ?? null;
}

/**
 * WHICH TRIAL NOTICE IS DUE: the window the days left fall in (windowFor), and ONLY if that window's
 * key is not stamped — otherwise nothing. Day 5 with trial_7 unstamped is told under trial_7; day 3
 * with trial_3 unstamped under trial_3; day 5 with trial_7 stamped: nothing, the next door opens at
 * day 3. A window the cron missed (day 2 with trial_7 never stamped) is SKIPPED: the company is told
 * under trial_3, and trial_7 is never fired late — so a same-day re-run finds the one stamp and stays
 * quiet instead of cascading down the list. Day 9: nothing.
 */
export function dueTrialNotice(daysLeft: number, stamped: Stamped): TrialThreshold | null {
  if (!Number.isFinite(daysLeft)) return null;
  const t = windowFor(TRIAL_THRESHOLDS, daysLeft);
  if (t === null) return null;
  return isStamped(stamped, trialNoticeKey(t)) ? null : t;
}

/** The same rule for the grace window, keyed on the unpaid period's end; 0 days is grace_spent,
 *  which is the lapse notice's business, not this one's. */
export function dueGraceNotice(daysLeft: number, periodEnd: string | null | undefined, stamped: Stamped): GraceThreshold | null {
  if (!Number.isFinite(daysLeft) || daysLeft <= 0) return null;
  const t = windowFor(GRACE_THRESHOLDS, daysLeft);
  if (t === null) return null;
  return isStamped(stamped, graceNoticeKey(t, periodEnd)) ? null : t;
}

const TRIAL_BODY = "Pick a plan in Settings › Getting Paid to keep the crew working. Your customers can still pay you and your data stays yours either way.";
const GRACE_BODY = "Update the card in Settings › Getting Paid › Manage Billing. The crew keeps working until then.";
const LAPSED_BODY = "Nort, texts and reminders are paused. Your customers can still pay you. Download For Your Accountant stays open. Pick a plan to continue.";

const LAPSED_TITLES: Record<LapsedReason, string> = {
  trial_ended: "Your Free Trial Has Ended",
  grace_spent: "Your Card Was Not Updated In Time",
  canceled: "Your Subscription Has Ended",
};

/** THE WORDS, from the real days left (never the threshold): "Ends In 5 Days", "Ends Tomorrow",
 *  "Ends Today"; the grace line with its day count; the lapse line by its reason. */
export function noticeWords(kind: "trial" | "grace", daysLeft: number): NoticeWords;
export function noticeWords(kind: "lapsed", reason: LapsedReason): NoticeWords;
export function noticeWords(kind: "trial" | "grace" | "lapsed", detail: number | LapsedReason): NoticeWords {
  if (kind === "lapsed") return { title: LAPSED_TITLES[detail as LapsedReason], body: LAPSED_BODY };
  const d = Math.max(0, Math.floor(Number(detail)));
  if (kind === "trial") {
    const title = d === 0 ? "Your Free Trial Ends Today" : d === 1 ? "Your Free Trial Ends Tomorrow" : `Your Free Trial Ends In ${d} Days`;
    return { title, body: TRIAL_BODY };
  }
  return { title: `Your Card Was Declined — ${d === 1 ? "1 Day" : `${d} Days`} Left`, body: GRACE_BODY };
}

/** The columns the step reads, with the billing columns added once each (withBillingColumns). */
export const NOTICE_COLUMNS = "id, name, email, settings, billing_notices";

export type NoticeOrg = {
  id: string;
  name: string | null;
  email: string | null;
  settings: unknown;
  billing_notices: Record<string, unknown> | null;
  subscription_status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  comped_until: string | null;
};

export type BillingNoticeRun = {
  /** Companies read. */
  orgs: number;
  /** Companies with a notice due today (before the claim). */
  due: number;
  /** Notices that went: the bell line and push, and the email where there was an address. */
  sent: number;
  skipped: { comped: number; billing_off?: true };
  /** Companies whose turn failed: a claim that errored, or a courtesy lost after the claim. */
  failed: number;
};

/** The service client, typed as loosely as the other crons type it: every read and the claim are
 *  checked for their error below. */
export type NoticeClient = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

/** The words a notice is told in: one set for everyone (the billing notices, English today), or a
 *  FUNCTION of the language (the usage notices, cn-v1140, lib/usage-notice-run) — notifyPeople groups
 *  the owner and admins by their language and each group gets its own line; the email reads in the
 *  owner's. */
export type NoticeWordsByLang = NoticeWords | ((lang: Lang) => NoticeWords);

export type Due = {
  key: string;
  words: NoticeWordsByLang;
  /** The email button's words by language, for a notice told by language; "Open Settings" when absent. */
  cta?: (lang: Lang) => string;
};

/** What, if anything, this company is told today. */
export function dueNotice(st: AccessState, org: Pick<NoticeOrg, "billing_notices" | "current_period_end">): Due | null {
  const stamped = org.billing_notices;
  if (st.reason === "trial") {
    if (st.daysLeft == null) return null; // trialing with no end date: nothing to count down
    const t = dueTrialNotice(st.daysLeft, stamped);
    return t == null ? null : { key: trialNoticeKey(t), words: noticeWords("trial", st.daysLeft) };
  }
  if (st.reason === "grace") {
    if (st.daysLeft == null) return null;
    const t = dueGraceNotice(st.daysLeft, org.current_period_end, stamped);
    return t == null ? null : { key: graceNoticeKey(t, org.current_period_end), words: noticeWords("grace", st.daysLeft) };
  }
  if (!st.active && (st.reason === "trial_ended" || st.reason === "grace_spent" || st.reason === "canceled")) {
    return isStamped(stamped, LAPSED_KEY) ? null : { key: LAPSED_KEY, words: noticeWords("lapsed", st.reason) };
  }
  return null;
}

/** The app's own address for the email's button: the platform's, never a company's custom domain
 *  (the plan and the card live on North's settings page). */
function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app").replace(/\/+$/, "");
}

type Recipient = { id: string; email: string | null; role: string | null };

/**
 * THE SEND, after the claim held: the bell line and the push to every active owner and admin (the
 * service client bypasses RLS, so `active` and the company are filtered by hand), then ONE email —
 * to the company's address, else the owner's, else nobody. Throws when any part did not go, so the
 * caller counts it; the stamp stands either way (see the file's head). Exported for the usage
 * notices (cn-v1140, lib/usage-notice-run), which are told through this one door with their words
 * as a function of the language: the plain-words path is byte for byte the billing notices' own.
 */
export async function tell(supabase: NoticeClient, org: NoticeOrg, due: Due): Promise<void> {
  const { data: people, error } = await supabase
    .from("profiles")
    .select("id, email, role")
    .eq("org_id", org.id)
    .eq("active", true)
    .in("role", ["owner", "admin"]);
  if (error) throw new Error(`the owner and admins could not be read: ${errorMessage(error)}`);
  const recipients = (people ?? []) as Recipient[];
  const ids = recipients.map((p) => p.id);
  const words = due.words;
  // notifyPeople never throws: a line that was not written comes back as bell false, and is counted
  // below AFTER the email has had its turn — one failed channel must not silence the other.
  const { bell } = await notifyPeople(
    org.id,
    ids,
    "billing",
    typeof words === "function" ? (lang: Lang) => ({ ...words(lang), url: NOTICE_URL }) : { title: words.title, body: words.body, url: NOTICE_URL },
  );

  const to = org.email?.trim() || recipients.find((p) => p.role === "owner" && p.email?.trim())?.email?.trim() || null;
  let emailProblem: string | null = null;
  if (to) {
    // THE EMAIL'S LANGUAGE (cn-v1140): a notice told by language reads in the owner's — the first
    // active owner, else the first admin — one small read, English when nobody or when the read
    // fails (langOf never throws). Plain words are English and read nothing.
    let lang: Lang = "en";
    if (typeof words === "function") {
      const reader = recipients.find((p) => p.role === "owner") ?? recipients[0];
      if (reader) lang = (await langOf(supabase, [reader.id], org.id)).get(reader.id) ?? "en";
    }
    const { title, body } = typeof words === "function" ? words(lang) : words;
    const sent = await sendEmail({
      to,
      subject: title,
      html: renderPlatformNoticeEmail({ heading: title, message: body, cta: { label: due.cta?.(lang) ?? "Open Settings", href: `${appBaseUrl()}${NOTICE_URL}` } }),
      // North itself writes (no fromName); a reply goes to the support box when there is one.
      replyTo: process.env.SUPPORT_EMAIL || undefined,
    });
    if (!sent.ok) emailProblem = sent.error ?? "the email was not sent";
  }

  const problems = [
    !ids.length && !to ? "nobody to tell: no active owner or admin, and no company email" : null,
    !bell ? "the bell line was not written" : null,
    emailProblem,
  ].filter((p): p is string => !!p);
  if (problems.length) throw new Error(problems.join("; "));
}

/**
 * THE STEP, from the daily cron. Every company, whole, or a throw the cron files (readAllOrgs);
 * each company's turn in its own try, so one company's failure is its own row (cron-billing-notices,
 * with the orgId) and the next company is still told.
 */
export async function sendBillingNotices(supabase: NoticeClient, nowMs: number): Promise<BillingNoticeRun> {
  const run: BillingNoticeRun = { orgs: 0, due: 0, sent: 0, skipped: { comped: 0 }, failed: 0 };
  // BILLING OFF (no Stripe key): everyone is active and there is nothing to lapse from — nothing is
  // read, and the run says why.
  if (!billingEnabled) return { ...run, skipped: { comped: 0, billing_off: true } };

  const orgs = await readAllOrgs<NoticeOrg>(supabase, withBillingColumns(NOTICE_COLUMNS));
  for (const org of orgs) {
    run.orgs++;
    try {
      const tz = getOrgSettings(org.settings).timezone;
      const st = accessState(org, { nowMs, tz });
      if (st.reason === "comped") {
        run.skipped.comped++;
        continue;
      }
      const due = dueNotice(st, org);
      if (!due) continue;
      run.due++;

      // THE LOCK: the stamp is written first, and only a TRUE sends. supabase-js hands a database
      // error back; it never throws it.
      const { data: claimed, error } = await supabase.rpc("claim_billing_notice", { p_org: org.id, p_key: due.key });
      if (error) throw new Error(`claim_billing_notice ${due.key} failed: ${errorMessage(error)}`);
      if (claimed == null) throw new Error(`claim_billing_notice ${due.key} answered nothing`);
      if (claimed === false) continue; // already told

      try {
        await tell(supabase, org, due);
        run.sent++;
      } catch (e) {
        // AFTER THE CLAIM: the stamp stands. A bell or an email lost here is filed with the key and
        // counted, and the next run does not try again — one lost courtesy beats a duplicate every
        // run, and a sender that may have half-sent cannot honestly release the stamp.
        run.failed++;
        reportError("billing-notices:send", e, { orgId: org.id, key: due.key });
      }
    } catch (e) {
      run.failed++;
      reportError("cron-billing-notices", e, { orgId: org.id });
    }
  }
  return run;
}
