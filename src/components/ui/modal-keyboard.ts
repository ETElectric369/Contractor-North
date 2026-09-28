/**
 * THE MODAL WITH THE KEYBOARD UP — the geometry the shared <Modal> needs, kept pure so it can be
 * tested without a phone.
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
 * that showed was the bottom of the panel: the Create Job button. The fix measured the keyboard
 * against documentElement.clientHeight, which iOS 18 does not move.
 *
 * IOS 26 AND LATER (bug triage, 2026-09-27: that fix was only ever tested on iOS 18, and Erik's
 * phone runs 26). The page's own heights are not a steady ruler across iOS versions and webviews:
 * whichever one a release decides to move with the keyboard (innerHeight on 18; the layout
 * viewport's height in a webview that resizes its content), measuring against it reads "closed"
 * with the keyboard up, which is exactly the 62be0852 failure again. And where the page runs under
 * a floating toolbar, the visual viewport is shorter than the page with NO keyboard at all. So the
 * keyboard is measured against the one ruler that means "no keyboard": the visual viewport's OWN
 * height when the modal opened (a sheet opens from a tap, not mid-typing), raised to the tallest it
 * has been since (a sheet opened while a keyboard was still up learns the full height the moment
 * the keyboard goes), and reset when the width changes (a rotation is a new screen).
 */

/** The visual viewport as the Modal last measured it with no keyboard in the way. */
export type KeyboardBaseline = { height: number; width: number };

/**
 * The baseline after one more measurement: the first one sets it, a taller one raises it, and a
 * change of width (a rotation, a split-screen resize) starts it again from here.
 */
export function nextKeyboardBaseline(prev: KeyboardBaseline | null, vv: { height: number; width: number }): KeyboardBaseline {
  const height = Number(vv.height) || 0;
  const width = Number(vv.width) || 0;
  if (!prev || Math.abs(prev.width - width) >= 1) return { height, width };
  return { height: Math.max(prev.height, height), width };
}

/** True when the on-screen keyboard is NOT taking space: the visual viewport is as tall as it was
 *  when the modal opened (the baseline above) — never a page height, which some iOS versions move
 *  with the keyboard. Nothing to measure against reads closed. */
export function keyboardClosed(visualHeight: number, baselineHeight: number): boolean {
  if (!(baselineHeight > 0)) return true;
  return visualHeight >= baselineHeight - 1;
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
