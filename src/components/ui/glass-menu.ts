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
 * Viewport-aware vertical placement for a trigger-anchored glass menu panel.
 *
 * The shared mechanism behind every "⋯" menu that hangs off its trigger
 * (TeamMemberMenu / JobManageMenu / SectionActionsMenu): the panel drops DOWN by
 * default, but when the open panel would extend past the bottom limit (visual
 * viewport minus the mobile bottom nav) and there's more room above, it flips UP
 * from the trigger instead. Belt-and-suspenders: whichever side it hangs on, if
 * the panel still can't fit it gets a max-height + internal scroll so no row
 * (Remove is deliberately LAST) can ever be unreachable.
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
export function useGlassMenuPlacement(open: boolean): {
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
    const panelH = panel.offsetHeight;
    const roomBelow = viewportBottomLimit() - EDGE - a.bottom - GAP_PX;
    const roomAbove = a.top - GAP_PX - EDGE;
    const up = panelH > roomBelow && (panelH <= roomAbove || roomAbove > roomBelow);
    const room = up ? roomAbove : roomBelow;
    setDropUp(up);
    // The 96px floor keeps a freak short viewport usable (scrollable) rather than sliver-thin.
    setMaxHeight(panelH > room ? Math.max(Math.floor(room), 96) : undefined);
  }, [open]);

  const panelStyle: CSSProperties = {
    position: "absolute",
    ...(dropUp ? { bottom: `calc(100% + ${GAP_REM})` } : { top: `calc(100% + ${GAP_REM})` }),
    // Inline overflow-y beats GLASS_MENU_CLASS's overflow-hidden on the y axis only;
    // x stays hidden so rounded corners keep clipping row hover fills.
    ...(maxHeight !== undefined ? { maxHeight, overflowY: "auto" as const } : null),
  };
  return { panelRef, panelStyle };
}
