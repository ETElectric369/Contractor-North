import "server-only";
import { NOTICE_COLUMNS, tell, type NoticeClient, type NoticeOrg, type NoticeWords } from "@/lib/billing-notices";
import { readActiveOrgs } from "@/lib/cron-orgs";
import { translator } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { errorMessage, reportError } from "@/lib/observe";
import { USAGE_ORG_COLUMNS, usageFor, type UsageOrg } from "@/lib/usage-meter";
import { usageNoticeKey, usageNoticeWords } from "@/lib/usage-notices";

/**
 * THE USAGE NOTICES' STEP (cn-v1140), from the daily cron, right after the billing notices. ONE
 * meter, Usage: the company's model spend this calendar month against its plan's monthly budget
 * (lib/usage-meter, the one read). At 80% the owner and admins are told ONCE for the month (bell +
 * push + email); when it is used up, once more; past 100% nothing stops — Nort and the estimator
 * run lighter until the 1st. Never a count of estimates and never a dollar in any notice: the
 * words are lib/usage-notices' (the us_ catalog, in each person's own language) and carry a
 * percent and the reset day, nothing else.
 *
 * THE RULES, company by company:
 *   · WHO: every company that is not lapsed (readActiveOrgs — the lapse policy's one read, cn-v1137:
 *     a lapsed company spends nothing and is counted as skipped.lapsed). A COMPED company is IN —
 *     the comp is about paying, the usage is theirs, and its meter runs on Company's line. With
 *     billing off (no Stripe key) nobody is lapsed and everyone is read: usage is model spend, not
 *     a card.
 *   · ONE READ per company: usageFor is handed the row (USAGE_ORG_COLUMNS are in the select) and
 *     reads the month's spend and top-ups. A read that failed answers `degraded` (filed by the
 *     meter itself) and the company is SKIPPED and counted — a meter that could not be read tells
 *     nobody anything, and claims nothing.
 *   · THE KEY is the percent's (lib/usage-notices): out → usage_100:<month>, 80% or more →
 *     usage_80:<month>, under 80% → nothing (skipped.fine — a "watch" by pace at 50–79% is the
 *     ring's color, never a notice). One notice per company per run; a company found at 100% that
 *     was never told at 80% gets ONLY the 100 notice. A new month is a new key.
 *   · THE LOCK is the billing notices' own: claim_billing_notice(p_org, p_key) stamps FIRST and
 *     only a TRUE sends (false → skipped.already). Two overlapping runs cannot say it twice; a run
 *     back after a crash finds the stamp and stays quiet.
 *   · THE SEND is the billing notices' `tell`: the bell line and the push (kind `billing`) to every
 *     active owner and admin, each in their own language, then ONE email to the company's address,
 *     else the owner's, in the owner's language, its button pointing at Settings › Getting Paid.
 *   · A FAILURE is the company's own: caught, filed as usage-notices:<org> and counted (`failed`),
 *     never thrown — the next company is still told. After the claim, a bell or an email lost is a
 *     courtesy lost, filed with the key, never retried (the stamp stands; one lost courtesy beats a
 *     duplicate every run). Only a failed COMPANIES READ throws, so the cron's own catch files it
 *     and the night goes red.
 */
export type UsageNoticeRun = {
  /** Companies read (the lapsed ones are not among them). */
  orgs: number;
  /** Companies told this run: the bell line and push, and the email where there was an address. */
  told: number;
  skipped: {
    /** Under 80% (a watch by pace included): nothing to say. */
    fine: number;
    /** Lapsed companies, left unread. */
    lapsed: number;
    /** The meter could not be read: nothing claimed, nothing said. */
    degraded: number;
    /** The month's key was already stamped: told by an earlier run. */
    already: number;
  };
  /** Companies whose turn failed: a claim that errored, or a courtesy lost after the claim. */
  failed: number;
};

/** The columns the step reads: the notices' own (the stamps, the email) and the meter's (the plan,
 *  the standing), each once — the row is handed to usageFor whole (one read per company). */
export const USAGE_NOTICE_COLUMNS = Array.from(
  new Set(
    `${NOTICE_COLUMNS}, ${USAGE_ORG_COLUMNS}`
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  ),
).join(", ");

export type UsageNoticeOrg = NoticeOrg & UsageOrg & { plan: string | null };

export async function sendUsageNotices(supabase: NoticeClient, nowMs: number): Promise<UsageNoticeRun> {
  const run: UsageNoticeRun = { orgs: 0, told: 0, skipped: { fine: 0, lapsed: 0, degraded: 0, already: 0 }, failed: 0 };

  // Every company that is not lapsed, whole, or a throw the cron files.
  const { rows, lapsedSkipped } = await readActiveOrgs<UsageNoticeOrg>(supabase, USAGE_NOTICE_COLUMNS, nowMs);
  run.skipped.lapsed = lapsedSkipped;

  for (const org of rows) {
    run.orgs++;
    try {
      const meter = await usageFor(org.id, org, { nowMs, client: supabase });
      if (meter.degraded) {
        run.skipped.degraded++;
        continue;
      }
      const key = usageNoticeKey(meter);
      if (!key) {
        run.skipped.fine++;
        continue;
      }

      // THE LOCK: the stamp is written first, and only a TRUE sends. supabase-js hands a database
      // error back; it never throws it.
      const { data: claimed, error } = await supabase.rpc("claim_billing_notice", { p_org: org.id, p_key: key });
      if (error) throw new Error(`claim_billing_notice ${key} failed: ${errorMessage(error)}`);
      if (claimed == null) throw new Error(`claim_billing_notice ${key} answered nothing`);
      if (claimed === false) {
        run.skipped.already++;
        continue;
      }

      // The words in both languages, once, before anyone is told: a key the catalog has no words
      // for is a failure of ours, filed, never a blank line.
      const en = usageNoticeWords(key, meter, translator("en"), "en");
      const es = usageNoticeWords(key, meter, translator("es"), "es");
      if (!en || !es) throw new Error(`no words for ${key}`);
      const words = (lang: Lang): NoticeWords => (lang === "es" ? es : en);
      // The email's button: "Open Settings" / "Abrir Ajustes" (the billing family's words), the
      // door the notice points at (Settings › Getting Paid).
      const cta = (lang: Lang) => translator(lang)("us_noticeOpenSettings");

      try {
        await tell(supabase, org, { key, words, cta });
        run.told++;
      } catch (e) {
        // AFTER THE CLAIM: the stamp stands. Filed with the key and counted; never retried.
        run.failed++;
        reportError(`usage-notices:${org.id}`, e, { orgId: org.id, key, after: "claim" });
      }
    } catch (e) {
      run.failed++;
      reportError(`usage-notices:${org.id}`, e, { orgId: org.id });
    }
  }
  return run;
}
