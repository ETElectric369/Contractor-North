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
}

/** Hold the body scroll-lock + nav-hide while `active` is true. */
export function useModalLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockBodyForModal();
    return () => unlockBodyForModal();
  }, [active]);
}
