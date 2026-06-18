"use client";

import { useEffect } from "react";

// One shared reference count for EVERY full-screen overlay (the shared <Modal>
// and bespoke ones like the camera). While any is open we lock body scroll and
// add `modal-open` to <body>, which hides the fixed mobile bottom nav (see
// globals.css) so it can never cover a Save/Capture button. A single counter is
// essential — separate counters would let one overlay closing re-show the nav
// while another is still open.
let openCount = 0;

export function lockBodyForModal() {
  openCount += 1;
  document.body.style.overflow = "hidden";
  document.body.classList.add("modal-open");
}

export function unlockBodyForModal() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) {
    document.body.style.overflow = "";
    document.body.classList.remove("modal-open");
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
