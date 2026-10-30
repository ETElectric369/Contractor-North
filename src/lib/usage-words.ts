import { fillText } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { shortDate, type UsageWindow } from "@/lib/usage-window";

/**
 * THE WORDS UNDER THE RING (cn-v1140): a headline ("Usage" / "Uso"), ONE line by state with the
 * reset day in it, the pace forecast on its own when there is one, and the trial's last day when
 * there is a trial. Every word comes through the caller's translator and the us_ catalog
 * (lib/words/usage); the dates through Intl in the person's language ("Nov 1" / "1 nov"). No
 * dollar, no token, no estimate as a unit — nothing to explain.
 *
 *   fine     "Resets Nov 1."
 *   watch    with a run-out: "At this pace you'll run out around Oct 28. Resets Nov 1."
 *            without:        "Most of this month's usage is used. Resets Nov 1."
 *   almost   "Almost out for this month. Resets Nov 1."
 *   out      "Used up for this month — Nort and the estimator run lighter until Nov 1. Add usage or upgrade."
 *            inside the App Store app (opts.shell), which has no purchase door: the same line without
 *            the call to action.
 *
 * THE FORECAST is drawn only from 50% up: lib/usage-window computes a run-out day from the first
 * cent (a new trial at 10% on day 1 has one), and a "you'll run out around" line under a 10% ring
 * is noise, not a warning. Never for a company already out — that is not a forecast any more.
 */
export type UsageWords = {
  headline: string;
  line: string;
  /** The pace forecast on its own: a run-out day, 50% or more, any state short of out. */
  forecast?: string;
  trialLine?: string;
};

export function usageWords(
  window: Pick<UsageWindow, "pct" | "state" | "resetOn" | "runOutOn" | "trialEndsOn">,
  t: (key: string) => string,
  lang: Lang,
  opts: { shell?: boolean } = {},
): UsageWords {
  const date = shortDate(window.resetOn, lang);
  const runOut = window.runOutOn ? shortDate(window.runOutOn, lang) : null;
  const line =
    window.state === "out"
      ? fillText(t(opts.shell ? "us_out100Shell" : "us_out"), { date })
      : window.state === "almost"
        ? fillText(t("us_almost"), { date })
        : window.state === "watch"
          ? runOut
            ? fillText(t("us_watchPace"), { runOut, date })
            : fillText(t("us_watch"), { date })
          : fillText(t("us_resets"), { date });
  const out: UsageWords = { headline: t("us_usage"), line };
  if (runOut && window.state !== "out" && window.pct >= 50) out.forecast = fillText(t("us_forecast"), { runOut });
  if (window.trialEndsOn) out.trialLine = fillText(t("us_trialEnds"), { date: shortDate(window.trialEndsOn, lang) });
  return out;
}
