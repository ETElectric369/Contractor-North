/**
 * EVERY SCREEN THAT MAY BE TURNED SIDEWAYS. This file is the whole policy; there is no other.
 *
 * Erik, 2026-10-01, from /schedule: "I'd like to be able to turn the phone sideways to see the
 * calendar in full, but it would be nice to also keep the buttons for the top bar and the dock
 * exactly where they are while spinning everything in between only." And then, widening it himself:
 * "The rotate should be available for any screen that warrants it like documents especially and I
 * see that I already does work on the PDF engine one of them."
 *
 * PORTRAIT IS THE DEFAULT, AND THE DEFAULT IS WHAT YOU GET BY SAYING NOTHING. A screen that is not
 * named below does not turn. That is deliberate both ways round: a screen cannot rotate because
 * somebody forgot to lock it, and a screen cannot be stuck portrait because somebody forgot to
 * think about it — the thinking is the entry.
 *
 * THE ONE TEST AN ENTRY HAS TO PASS: does extra WIDTH show MORE, or does it only stretch? A phone
 * held sideways is wide and has almost no HEIGHT — an iPhone 16 Pro is 402pt tall that way, an SE
 * 320 — and the top bar and the dock take 128 of it before anything is drawn. So a screen that is a
 * TALL LIST loses by rotating: you see a third as many rows, stretched. A screen whose content is
 * WIDER THAN THE PHONE wins: the part you had to scroll sideways for is simply there.
 *
 * WHAT WAS WEIGHED AND LEFT OFF, so the next person doesn't re-litigate it:
 *  - Timecards — a vertical stack of week cards. Width stretches them; height is what shows weeks.
 *    The code already knew: timecards/timecard-stack.tsx says a landscape phone left a 55px slit.
 *  - Analytics — the cards are laid out at `lg` (1024px) and a landscape phone never reaches it, so
 *    the grid doesn't change shape; the charts just get shorter. The money chart already opens at
 *    the most recent month inside its own sideways scroller, which is the right answer on a phone.
 *  - The estimate / quote editor — the work there is TYPING. Sideways the keyboard takes most of
 *    400pt, so the line being edited is the thing that disappears.
 *  - A job's materials list — capped at max-w-4xl and built of full-width rows: wider shows the
 *    same rows, fewer of them.
 *  - Reconcile — a stack of cards, one per kind of disagreement. Same loss as any tall list.
 *  - The job panel / circuit tables — these would genuinely show more (they declare min-w-[640px]),
 *    but they are cards inside pages that are mostly forms, and the Panel tab is on a plan-first
 *    footing. They are the best candidates for the next entry, not this one.
 *  - /print/<doc>/<id> — the seven web-print views are what the PDF engine renders headless. No
 *    person opens them in the app; /print/pdf-preview is the screen a person actually reads.
 *  - /print/business-card — a sheet laid out for a printer. What you do there is tap Print.
 */

/**
 * A screen that may turn. Adding one means adding a name HERE and an entry below with a reason —
 * the record is exhaustive, so it will not compile until both exist.
 */
export type ScreenThatTurns =
  | "document-preview"
  | "document-full-screen"
  | "schedule"
  | "price-list";

export type Warrant = {
  /**
   * The path it lives at, matched on a segment boundary (so "/schedule" covers "/schedule/x" and
   * never "/schedules"). `null` for a FULL-SCREEN LAYER that opens over whatever route you were
   * on and therefore has no path of its own — it says so itself, with useTurnsSidewaysLayer().
   */
  readonly route: string | null;
  /** Why extra width shows MORE here. One line, in words a person would use. Required. */
  readonly because: string;
};

export const SCREENS_THAT_TURN: Record<ScreenThatTurns, Warrant> = {
  // ── Documents first: "documents especially" ────────────────────────────────────────────────
  "document-preview": {
    route: "/print/pdf-preview",
    because:
      "A document is a page of print. Sideways the page is drawn twice as wide, so the print is big enough to read instead of a whole sheet shrunk to nothing.",
  },
  "document-full-screen": {
    route: null, // the in-app viewer for a photo or a PDF — a job's documents, a bill's receipt
    because:
      "A site photo is usually wider than it is tall, and a PDF opened full screen has the same problem as the preview: portrait fits the whole page in at a size nobody can read.",
  },
  // ── The screen he reported from ────────────────────────────────────────────────────────────
  schedule: {
    route: "/schedule",
    because:
      "The week is seven day columns. Portrait shows three and scrolls sideways for the rest; sideways the whole week is on screen at once.",
  },
  // ── And the one other table that is already wider than the phone ───────────────────────────
  "price-list": {
    route: "/price-list",
    because:
      "The table declares min-w-[1080px] and scrolls sideways on a phone today: Cost, Markup, Margin and Sell cannot be seen together, which is the one thing a price table is for.",
  },
};

/** Trailing slashes and query strings never reach usePathname, but a hand-written path can. */
function justThePath(pathname: string): string {
  const p = (pathname || "").split("?")[0].split("#")[0];
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Which declared screen this path IS, or null for "portrait, like everywhere else".
 *
 * Matched on a segment boundary, never with a bare startsWith: "/price-list" must not hand its
 * warrant to a future "/price-lists".
 */
export function screenTurningAt(pathname: string): ScreenThatTurns | null {
  const path = justThePath(pathname);
  for (const name of Object.keys(SCREENS_THAT_TURN) as ScreenThatTurns[]) {
    const route = SCREENS_THAT_TURN[name].route;
    if (!route) continue;
    if (path === route || path.startsWith(`${route}/`)) return name;
  }
  return null;
}

/**
 * THE WHOLE DECISION, as one answer: may the phone be turned right now?
 *
 * `layersOpen` is how many full-screen layers that declared themselves are open over the route — a
 * document opened on top of a tall list may turn even though the list may not, and closing it hands
 * the screen underneath its own answer back. Pure on purpose: this is the line that decides, so it
 * is the line that gets tested, instead of being spelled out inside an effect nobody can run.
 */
export function mayTurnSideways(pathname: string, layersOpen = 0): boolean {
  return layersOpen > 0 || screenTurningAt(pathname) !== null;
}
