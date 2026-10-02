/**
 * HOW WIDE A DOCUMENT'S PAGE IS DRAWN, and when it has to be drawn again.
 *
 * Pulled out of print/pdf-preview/viewer.tsx because both answers are arithmetic with a history, and
 * arithmetic with a history belongs somewhere it can be tested:
 *  - a width of 0 or NaN rendered every page into a negative-width canvas — Erik's blank sheets
 *  - and until 2026-10-01 the width was measured ONCE, so turning the phone sideways left the same
 *    374pt-wide page sitting in an 812pt-wide window: a bitmap does not re-flow.
 */

/** Never narrower than this: below it a letter page is unreadable anyway, and 0 draws nothing. */
const NARROWEST = 280;
/** Never wider: past this a sheet on a desktop is bigger than the paper it prints on. */
const WIDEST = 900;
/** Breathing room around the sheet, so the shadow isn't flush against the scroller's edge. */
const FRAME = 16;

/**
 * The width to draw a page at, given the room measured INSIDE the scroller (which is where the
 * camera-cutout insets already live, so a page is never drawn under the notch).
 *
 * Anything that isn't a real measurement — 0 from a display:none element, NaN from a detached one —
 * floors at the narrowest page rather than going negative.
 */
export function pageWidthInside(insideWidth: number): number {
  if (!Number.isFinite(insideWidth)) return NARROWEST;
  return Math.min(Math.max(Math.floor(insideWidth) - FRAME, NARROWEST), WIDEST);
}

/**
 * Is this a new width, or the same width measured again? A scrollbar appearing, or a hairline of
 * rounding, is not a reason to re-rasterize a twelve-page material list.
 */
export function worthRedrawing(want: number, drawnAt: number): boolean {
  return Math.abs(want - drawnAt) >= 8;
}
