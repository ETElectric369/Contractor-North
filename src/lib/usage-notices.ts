import { fillText } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { shortDate, type UsageState, type UsageWindow } from "@/lib/usage-window";

/**
 * THE USAGE NOTICES' KEYS AND WORDS (cn-v1140), beside the billing ones (lib/billing-notices): a
 * company hears twice a month at most about its usage — once at 80%, once when it is used up — and
 * never the same thing twice, because the key carries the month and the daily cron's step (builder
 * U2) claims it through claim_billing_notice (0400) before it sends, the way every billing notice
 * is told once. The guard and the gate claim nothing: ONE place tells, the cron. Under 80% claims
 * nothing either.
 *
 * THE KEY IS THE PERCENT'S, NOT THE STATE'S. The ring's "watch" also fires at 50–79% when the pace
 * says the month will not last (lib/usage-window) — that is a color on the ring, not a notice. A key
 * taken from the state fired the 80 notice at 55% and burned the month's one usage_80 stamp, so the
 * real 80% went untold. So:
 *
 *   usage_80:<YYYY-MM>    pct ≥ 80 — "Usage: 80% Of This Month", the reset day in the body
 *   usage_100:<YYYY-MM>   out (pct ≥ 100) — "Usage: Used Up For This Month", the lighter-model sentence
 *
 * The words come through the caller's translator and the us_ catalog, in the person's language.
 */
export type UsageNoticeKey = `usage_80:${string}` | `usage_100:${string}`;

export function usageNoticeKey(meter: { pct: number; state: UsageState; monthKey: string }): UsageNoticeKey | null {
  if (meter.state === "out" || meter.pct >= 100) return `usage_100:${meter.monthKey}`;
  if (meter.pct >= 80) return `usage_80:${meter.monthKey}`;
  return null;
}

/** The notice's kind from a key the ledger holds; null for a key that is not a usage notice. */
export function usageNoticeKind(key: string): "80" | "100" | null {
  if (/^usage_80:\d{4}-\d{2}$/.test(key)) return "80";
  if (/^usage_100:\d{4}-\d{2}$/.test(key)) return "100";
  return null;
}

export function usageNoticeWords(key: string, window: Pick<UsageWindow, "resetOn">, t: (key: string) => string, lang: Lang): { title: string; body: string } | null {
  const kind = usageNoticeKind(key);
  if (!kind) return null;
  const date = shortDate(window.resetOn, lang);
  return kind === "80"
    ? { title: t("us_notice80Title"), body: fillText(t("us_notice80Body"), { date }) }
    : { title: t("us_notice100Title"), body: fillText(t("us_notice100Body"), { date }) };
}
