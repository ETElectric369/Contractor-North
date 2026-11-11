"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export interface SegmentItem {
  id: string;
  label: string;
  href?: string;
}

/** The one-line pill and its segment: what every pill in the app draws unless it asks to stack. */
const PILL = "flex shrink-0 gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm";
const SEGMENT = "whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition-colors";

/** THE STACK: a vertical list. One segment per row, as wide as the pill, at least 44px tall (a thumb's
 *  target), its label centered; a label wider than the row breaks inside its own row. No shrink-0: a
 *  pill that may not shrink keeps its widest label on one line and runs it off the screen. */
const STACKED_PILL = "flex flex-col gap-0.5 rounded-lg bg-slate-100 p-0.5 text-sm";
const STACKED_SEGMENT = "flex min-h-11 items-center justify-center whitespace-normal text-center rounded-md px-3 py-1.5 font-medium transition-colors";

/** THE SAME STACK, BELOW `lg` ONLY, laid over the one-line classes — which stay exactly as written, so
 *  from `lg` up the pill is the one-line pill by the same CSS as every other. Each class here is a
 *  stack class behind `max-lg:` (and `max-lg:shrink` takes shrink-0 back). WRITTEN OUT, never built
 *  from the list above: Tailwind makes a class only when it reads it whole in the source. */
const NARROW_PILL = "max-lg:flex-col max-lg:shrink";
const NARROW_SEGMENT = "max-lg:flex max-lg:min-h-11 max-lg:items-center max-lg:justify-center max-lg:whitespace-normal max-lg:text-center";
/** With `stretch` the one-line segments share their row (flex-1). A stacked row is one segment and
 *  shares nothing, so below `lg` that is taken back; "always" simply never adds it. */
const NARROW_UNSHARED = "max-lg:flex-none";

/**
 * The compact segmented control — the inline-pill analogue of <TabBar>. One
 * source of truth for the `rounded-lg bg-slate-100` pill used across the app for
 * sub-toggles (calendar month/week/day, board week/month, set-time/propose).
 * Each segment is a <Link> when it has an href (server/bidirectional switchers),
 * else a button driven by onSelect (client switchers).
 *
 * `stack` (cn-v1158) is for a set that cannot fit one line. The estimate's paper switch has four
 * segments ("Company Default · Every Part", "Every Part", "One Materials Line", "Hidden") in a
 * card that is narrow on every device, and Document Studio's Labor and Parts on Estimates has three
 * in a bar that is page-wide on a desktop and far narrower on anything smaller.
 *
 *   "always"  a vertical list at every width: one segment per row.
 *   "narrow"  that list below Tailwind's `lg` breakpoint (a 1024px window); from `lg` up, the
 *             one-line pill.
 *
 * A LIST, NOT A WRAP. The first cut let the segments wrap onto rows by their own widths, and the
 * rows came out 1/2/1 at one width, 1/1/2 at the next and 1/1/1/1 in Spanish on a small phone: a
 * shape that moves with the width and the language is the kind of screen the owner is fighting. A
 * stack has one shape.
 *
 * WHY `lg`, AND NOT A PHONE'S WIDTH. The second cut stacked only below `sm`. A window is not the
 * place a pill sits in: the dock and the page padding come off it first, so from `sm` to about 800px
 * the studio's one-line pill was wider than its bar, ran out of it, and the page scrolled sideways
 * (doc-studio/estimate-lines-control has the numbers). `lg` is where the app's own page layouts
 * change, and the one line fits from there. The price is a list in a 900px window where one line
 * would have fit, and it is the cheaper one: a list never runs out of its place.
 *
 * It is OPT-IN: a caller that passes nothing draws the same bytes as before (segmented.test.tsx pins
 * them), because every other pill in the app sits in a row built around its one-line height. Only
 * classes change — the same buttons and links in the same order — so the keyboard and a screen
 * reader meet what they met.
 */
export function SegmentedControl({
  items,
  activeId,
  onSelect,
  stretch = false,
  stack,
  className,
}: {
  items: SegmentItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  /** Segments fill the width equally (e.g. inside a modal). A stacked row is already the pill's
   *  whole width, so on a stack this adds only the pill's own full width. */
  stretch?: boolean;
  /** One segment per row, each at least 44px tall: "always", or only below `lg` ("narrow"). */
  stack?: "always" | "narrow";
  className?: string;
}) {
  const stacked = stack === "always";
  return (
    <div className={cn(stacked ? STACKED_PILL : PILL, stack === "narrow" && NARROW_PILL, stretch && "w-full", className)}>
      {items.map((s) => {
        const active = s.id === activeId;
        const cls = cn(
          stacked ? STACKED_SEGMENT : SEGMENT,
          stack === "narrow" && NARROW_SEGMENT,
          stretch && !stacked && "flex-1 text-center",
          stretch && stack === "narrow" && NARROW_UNSHARED,
          active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
        );
        return s.href ? (
          <Link key={s.id} href={s.href} scroll={false} className={cls}>
            {s.label}
          </Link>
        ) : (
          <button key={s.id} type="button" onClick={() => onSelect?.(s.id)} className={cls}>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
