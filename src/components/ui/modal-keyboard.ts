/**
 * THE MODAL WITH THE KEYBOARD UP — the two pieces of geometry the shared <Modal> needs, kept pure
 * so they can be tested without a phone.
 *
 * Erik, 2026-09-23 (report 62be0852, iPhone 402x874, the CNShell WKWebView): "Typing in new job
 * description at bottom pushed everything up out of sight except the create job button".
 * Reproduced on an iPhone 16 Pro simulator (iOS 18.6), in Safari AND in the shell, with the
 * Modal's own code:
 *
 *   keyboard up → innerHeight 874 → 494 (it SHRINKS with the keyboard on iOS 18),
 *                 visualViewport.height 494, offsetTop 380, documentElement.clientHeight 874.
 *
 * The Modal decided "is the keyboard closed?" with `vv.height >= innerHeight - 1`. On iOS 18
 * innerHeight tracks the visual viewport, so that was TRUE with the keyboard up, the overlay was
 * pinned to top 0 of a layout viewport the keyboard had panned 380px above the screen, and all
 * that showed was the bottom of the panel: the Create Job button. The layout viewport's height
 * is documentElement.clientHeight, which does not move with the keyboard, so that is what the
 * keyboard is measured against now.
 */

/** True when the on-screen keyboard is NOT taking space: the visual viewport is as tall as the
 *  layout viewport. `layoutHeight` is documentElement.clientHeight — never innerHeight, which
 *  iOS 18 shrinks along with the visual viewport. */
export function keyboardClosed(visualHeight: number, layoutHeight: number): boolean {
  if (!(layoutHeight > 0)) return true;
  return visualHeight >= layoutHeight - 1;
}

type Box = { top: number; bottom: number };

/**
 * How far to scroll the Modal's body so the field being typed in shows WITH its label. `box` is
 * the field's labelled wrapper when that fits the visible body, otherwise the field alone; `view`
 * is the body's visible rect. Positive scrolls down. Zero when it already shows.
 *
 * When the keyboard shrinks the panel, a field near the bottom of the form ends up below the
 * body's visible slice — iOS's own reveal scrolls the page instead (it is what panned the layout
 * viewport above), so the body has to be scrolled here. Never scrolls the box's top out of view to
 * show its bottom: the label is the part that says what is being typed.
 */
export function revealScroll(box: Box, view: Box, margin = 8): number {
  const below = box.bottom - (view.bottom - margin);
  const roomAbove = box.top - (view.top + margin);
  if (below > 0) return Math.max(0, Math.min(below, roomAbove));
  if (roomAbove < 0) return roomAbove;
  return 0;
}
