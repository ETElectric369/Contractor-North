"use client";

import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import type { Level } from "@/lib/action-items/types";

/**
 * THE TWO MARKS (the Needs You redraw, cn-v1161). Red and amber mean urgency and nothing else, and
 * this is the ONLY file in the box allowed to hold a red or an amber class: a test scans the folder.
 *
 *   NOW   a red octagon with a white "!": it costs money or a legal right if it waits past today.
 *   SOON  an amber triangle with a dark "!": it has sat a week, or its day is close.
 *
 * Colour is never the only signal. Each mark is a shape a colour-blind reader tells apart at a
 * glance, and it carries its own words for a screen reader (role="img" and a label from the
 * catalog). The triangle's amber-700 edge is what gives it 3:1 against a white card: amber-400 alone
 * is too pale to see on white. A row with no mark draws nothing, and its slot stays empty so the
 * words of every row start at one x.
 */
export function LevelMark({
  level,
  className = "h-4 w-4",
  decorative = false,
}: {
  level: Level | null | undefined;
  className?: string;
  /** Beside words that already say it (the header's counts and their sr-only sentence): no role and
   *  no label, hidden from a screen reader, so it is said once and not twice. */
  decorative?: boolean;
}) {
  const t = translator(useLang());
  const a11y = (label: string) => (decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label });
  if (level === "now") {
    return (
      <svg viewBox="0 0 16 16" {...a11y(t("ny_markNow"))} data-mark="now" data-shape="octagon" className={`shrink-0 ${className}`}>
        <polygon points="4.7,0.5 11.3,0.5 15.5,4.7 15.5,11.3 11.3,15.5 4.7,15.5 0.5,11.3 0.5,4.7" className="fill-red-600" />
        <rect x="7" y="3.5" width="2" height="6" rx="1" className="fill-white" />
        <circle cx="8" cy="12" r="1.1" className="fill-white" />
      </svg>
    );
  }
  if (level === "soon") {
    return (
      <svg viewBox="0 0 16 16" {...a11y(t("ny_markSoon"))} data-mark="soon" data-shape="triangle" className={`shrink-0 ${className}`}>
        <polygon points="8,1.2 15.2,14.6 0.8,14.6" strokeWidth="1.3" strokeLinejoin="round" className="fill-amber-400 stroke-amber-700" />
        <rect x="7.1" y="5.4" width="1.8" height="5" rx="0.9" className="fill-slate-900" />
        <circle cx="8" cy="12.4" r="1" className="fill-slate-900" />
      </svg>
    );
  }
  return null;
}
