"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/**
 * THE glass dropdown-menu chrome — the chamfered sea-glass panel that every ⋯ / account /
 * quick-add menu floats in. One definition of the z / overflow / radius / padding / shadow
 * recipe so the five menus that hand-rolled the identical string can't drift. Compose with
 * the per-menu width + positioning at the call site:
 *   className={`${GLASS_MENU_CLASS} w-56`}   style={{ position: "absolute", right: 0, … }}
 * (The `.glass-menu` base + `.glass`/`.glass-gloss` skins live in globals.css.)
 */
export const GLASS_MENU_CLASS =
  "glass glass-gloss glass-menu z-[90] overflow-hidden rounded-lg py-1.5 shadow-xl";

/** px the panel keeps clear of viewport / bottom-bar edges. */
const EDGE = 8;
/** The trigger→panel gap — matches the historical `top: calc(100% + 0.25rem)`. */
const GAP_REM = "0.25rem";
const GAP_PX = 4;

/**
 * Where menu content must STOP at the bottom: the visual viewport's bottom edge,
 * raised to the top of the mobile shell's floating glass bottom nav when it's
 * showing (Chris's /team report: "Remove button on bottom guy is blocked by menu
 * bar" — z-index can't save a panel whose ancestor stacking context loses to the
 * dock's backdrop-filter+translateZ, so we dodge it geometrically instead). The
 * width filter skips the narrow section-sheet edge handle, which wears the same
 * `.app-bottom-nav` class only so `body.modal-open` hides it too.
 */
function viewportBottomLimit(): number {
  const vv = window.visualViewport;
  let limit = vv ? vv.offsetTop + vv.height : window.innerHeight;
  document.querySelectorAll(".app-bottom-nav").forEach((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.height > 0 && r.width >= window.innerWidth / 2 && r.top < limit) limit = r.top;
  });
  return limit;
}

/**
 * Where menu content must STOP at the TOP — the mirror of viewportBottomLimit(), and the half that
 * was missing. A panel that opens UPWARD is not clipped by the window; it is clipped by the nearest
 * ancestor that SCROLLS, which in the app shell is `<main className="turn-host flex-1
 * overflow-y-auto">` — and main starts BELOW the top bar (h-[calc(4rem+var(--sat))]), 84px down on a
 * 375x667 phone and 123px down in the iOS shell at sat 59. Measuring room above from the window's
 * edge let the tab strip's nine-row More panel open to y 8, putting its first rows — the MONEY
 * header and Invoices — above main's top edge where they are CUT OFF AND UNREACHABLE: main has
 * nothing to scroll (scrollHeight === clientHeight) and the panel's own scroller is already at 0.
 * That is Erik's "Can't see the bottom of the list" from the other end.
 *
 * Same walk and same rule as scrollerOf() in pull-to-refresh.tsx — nearest computed overflow-y
 * auto/scroll — kept here rather than imported because that module is a whole feature component
 * (router, icons, the turned-sideways geometry) and this is the primitive underneath it. 0 means
 * "nothing clips it": off the shell the window's own edge is the limit, which is what EDGE is for.
 */
export function clipTopLimit(anchor: HTMLElement | null): number {
  for (let n: HTMLElement | null = anchor; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n.getBoundingClientRect().top;
  }
  return 0;
}

/**
 * THE PLACEMENT MATH, pure (so it is tested without a browser). Given the panel's height, the trigger's
 * top and bottom (viewport px) and where content must stop at each end (the dock's top edge below, the
 * clipping scroller's top edge above), it drops down when the panel fits below; otherwise it opens
 * upward when that fits or there is more room above; and whichever side it takes, a panel taller than
 * that side's room gets a max-height (it scrolls) so no row ends up out of reach.
 *
 * `topLimit` is REQUIRED, not optional with a 0 default: a caller that forgets it is a caller whose
 * tall panel opens up through the top of the page again, and there is no way to notice that by
 * reading the call. Pass clipTopLimit(anchor) — 0 only when nothing clips the panel.
 */
export function placeGlassMenu({
  panelH,
  anchorTop,
  anchorBottom,
  bottomLimit,
  topLimit,
}: {
  panelH: number;
  anchorTop: number;
  anchorBottom: number;
  bottomLimit: number;
  topLimit: number;
}): { dropUp: boolean; maxHeight: number | undefined } {
  const roomBelow = bottomLimit - EDGE - anchorBottom - GAP_PX;
  const roomAbove = anchorTop - GAP_PX - Math.max(EDGE, topLimit);
  const up = panelH > roomBelow && (panelH <= roomAbove || roomAbove > roomBelow);
  const room = up ? roomAbove : roomBelow;
  // The 96px floor keeps a freak short viewport usable (scrollable) rather than sliver-thin.
  return { dropUp: up, maxHeight: panelH > room ? Math.max(Math.floor(room), 96) : undefined };
}

/**
 * Viewport-aware vertical placement for a trigger-anchored glass menu panel.
 *
 * The shared mechanism behind every "⋯" menu that hangs off its trigger
 * (TeamMemberMenu / JobManageMenu / SectionActionsMenu): the panel drops DOWN by
 * default, but when the open panel would extend past the bottom limit (visual
 * viewport minus the mobile bottom nav) and there's more room above, it flips UP
 * from the trigger instead. Belt-and-suspenders: whichever side it hangs on, if
 * the panel still can't fit it gets a max-height + internal scroll so no row
 * (Remove is deliberately LAST) can ever be unreachable. "Room above" is room
 * inside the box that clips the panel, not room to the window's edge — see
 * clipTopLimit: the tab strip's nine-row More panel used to open straight through
 * the top of the scrolling <main> and lose its first rows there.
 *
 * Usage — attach `panelRef` to the panel div and spread `panelStyle` FIRST, then
 * the call site's horizontal anchor (position stays inline because .glass-gloss
 * forces position:relative, the documented gotcha):
 *   <div ref={panelRef} style={{ ...panelStyle, right: 0 }} className={`${GLASS_MENU_CLASS} w-56`}>
 *
 * Measured per-open (the SectionActionsMenu alignLeft idiom) via useLayoutEffect —
 * the panel renders drop-down, is measured, and any flip lands before paint, so
 * there's no flicker. Assumes the panel's parentElement is the relative trigger
 * wrapper (the `<div ref={ref} className="relative">` every menu already has).
 */
export function useGlassMenuPlacement(
  open: boolean,
  /** What the panel is showing, when it can change while it stays open (the job's Add A Cost menu
   *  swaps "which paper?" in place). A new value measures the panel again: a short view that fit
   *  below the trigger must not hand its placement to a tall one that then hangs under the dock. */
  contentKey?: string | number,
): {
  panelRef: RefObject<HTMLDivElement | null>;
  panelStyle: CSSProperties;
} {
  const panelRef = useRef<HTMLDivElement>(null);
  const [dropUp, setDropUp] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!open) {
      // Reset so the next open re-measures from the unconstrained drop-down state.
      setDropUp(false);
      setMaxHeight(undefined);
      return;
    }
    const panel = panelRef.current;
    const anchor = panel?.parentElement; // the relative wrapper ≈ the trigger's box
    if (!panel || !anchor) return;
    const a = anchor.getBoundingClientRect();
    // Measure the panel's own height, not the cap an earlier measure put on it (a re-measure after the
    // content changed runs with the old inline max-height still applied). The CSS cap on the panel's
    // class still counts; the inline value goes straight back so React's style and the DOM agree.
    const inlineMax = panel.style.maxHeight;
    panel.style.maxHeight = "";
    const panelH = panel.offsetHeight;
    panel.style.maxHeight = inlineMax;
    const placed = placeGlassMenu({
      panelH,
      anchorTop: a.top,
      anchorBottom: a.bottom,
      bottomLimit: viewportBottomLimit(),
      topLimit: clipTopLimit(anchor),
    });
    setDropUp(placed.dropUp);
    setMaxHeight(placed.maxHeight);
  }, [open, contentKey]);

  const panelStyle: CSSProperties = {
    position: "absolute",
    ...(dropUp ? { bottom: `calc(100% + ${GAP_REM})` } : { top: `calc(100% + ${GAP_REM})` }),
    // Inline overflow-y beats GLASS_MENU_CLASS's overflow-hidden on the y axis only;
    // x stays hidden so rounded corners keep clipping row hover fills.
    ...(maxHeight !== undefined ? { maxHeight, overflowY: "auto" as const } : null),
  };
  return { panelRef, panelStyle };
}
