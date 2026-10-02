"use client";

import { useEffect } from "react";

// One shared reference count for EVERY full-screen overlay (the shared <Modal>
// and bespoke ones like the camera). While any is open we lock body scroll and
// add `modal-open` to <body>, which hides the fixed mobile bottom nav (see
// globals.css) so it can never cover a Save/Capture button. A single counter is
// essential — separate counters would let one overlay closing re-show the nav
// while another is still open.
let openCount = 0;
let savedScrollY = 0;

/**
 * AND THE SAME COUNT ANSWERS "IS THERE A SHEET OVER THE PAGE?" for the turned phone.
 *
 * A sheet and a turned page cannot both be right. A turned region is painted through a CSS transform,
 * and a transform makes its element the containing block for every `position: fixed` descendant — so a
 * Modal opened inside one resolved its full-screen overlay against a 684 x 402 rotated box instead of
 * the window, landed as a sliver hugging one physical edge, and took Cancel and Save off the screen
 * with it. There is no way round that: it is what a transform does. So the rule is that the page comes
 * UPRIGHT while a sheet is open over it (components/turns-sideways.tsx), and this is the count it
 * reads — the same one shared reference count that already means "a full-screen overlay is open",
 * rather than a second list of overlays to keep in step with this one.
 *
 * AN OVERLAY THAT WANTS TO KEEP THE TURN SAYS SO, by declaring itself a layer with
 * useTurnsSidewaysLayer() — the full-screen photo/PDF viewer is the one that does. The decision
 * compares the two counts, so a declared layer holds its own turn and anything else holds the screen
 * upright.
 */
const overlayWatchers = new Set<() => void>();

/**
 * AND THE ONES THAT COVER THE SCREEN WITHOUT TAKING THE LOCK. Not every full-screen overlay can hold
 * the body lock: the section sheet's Escape handler stands down while `modal-open` is set (Escape
 * belongs to a Modal on top of it), so taking the lock itself would stop Escape closing it, and
 * `modal-open` also hides its own edge handle. It still covers the screen with `position: fixed`
 * though, so for the turned phone it is a sheet like any other. Counted separately, reported together,
 * so `overlaysOpen()` stays the one answer to "is something covering the page right now".
 */
let coveringCount = 0;

/** How many full-screen overlays are open right now — declared turning layers included. */
export function overlaysOpen(): number {
  return openCount + coveringCount;
}

/**
 * THIS COVERS THE SCREEN, BUT TAKES NO BODY LOCK. For an overlay that has its own reason not to —
 * everything else should use useModalLock, which counts here as well. The page underneath comes
 * upright while it is open, for the reason in the note above.
 */
export function useCoversTheScreen(active: boolean) {
  useEffect(() => {
    if (!active) return;
    coveringCount += 1;
    tellTheWatchers();
    return () => {
      coveringCount = Math.max(0, coveringCount - 1);
      tellTheWatchers();
    };
  }, [active]);
}

/** Be told when that count changes. Returns the teardown. */
export function watchOverlays(fn: () => void): () => void {
  overlayWatchers.add(fn);
  return () => {
    overlayWatchers.delete(fn);
  };
}

function tellTheWatchers() {
  for (const w of overlayWatchers) w();
}

// iOS Safari IGNORES `overflow: hidden` on <body> when an input inside a fixed
// overlay is focused — it scrolls the document to reveal the field above the
// keyboard, which shoves a position:fixed modal off the top of the screen (the
// "I can't reach the address / notes fields" bug, since those sit at the bottom
// of a tall form). The reliable cross-browser lock is `position: fixed` on the
// body: it truly freezes the page, so iOS scrolls the field into view WITHIN the
// modal's own scroll area instead of moving the whole modal. We restore the exact
// scroll position on unlock so closing a modal never jumps the page.
export function lockBodyForModal() {
  openCount += 1;
  if (openCount === 1 && typeof window !== "undefined") {
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    const b = document.body.style;
    b.position = "fixed";
    b.top = `-${savedScrollY}px`;
    b.left = "0";
    b.right = "0";
    b.width = "100%";
    b.overflow = "hidden";
  }
  document.body.classList.add("modal-open");
  tellTheWatchers();
}

export function unlockBodyForModal() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0 && typeof window !== "undefined") {
    const b = document.body.style;
    b.position = "";
    b.top = "";
    b.left = "";
    b.right = "";
    b.width = "";
    b.overflow = "";
    document.body.classList.remove("modal-open");
    // Restore where the page was BEFORE the fixed-lock collapsed it to the top.
    window.scrollTo(0, savedScrollY);
  }
  tellTheWatchers();
}

/** Hold the body scroll-lock + nav-hide while `active` is true. */
export function useModalLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockBodyForModal();
    return () => unlockBodyForModal();
  }, [active]);
}
