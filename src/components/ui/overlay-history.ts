/**
 * THE THREE CASES A CLOSING OVERLAY HAS TO TELL APART.
 *
 * Modal pushes a history entry when it opens so the system BACK gesture closes the overlay rather
 * than leaving the page — on an installed PWA there is no browser chrome, so without this a
 * swipe-back exits the whole screen. Erik: "this leaving page and back page is really frustrating".
 *
 * The behaviour is one `useEffect`, but the DECISIONS inside it are what break, and a wrong one
 * eats the user's navigation. They live here as pure functions so they can be tested — this repo
 * has no component-test harness and adding one for a single file would be a permanent dependency
 * for a temporary need.
 */

/** What the overlay knows about itself when history moves. */
export type OverlayState = {
  /** We pushed an entry when we opened. */
  pushed: boolean;
  /** A popstate already removed our entry — it is GONE, do not remove it again. */
  popped: boolean;
  /** Our marker is still the current history state. False once another page pushed its own. */
  stillOurs: boolean;
};

/**
 * Should cleanup call history.back() to remove the entry we added?
 *
 * · closed by BACK      → no. The entry is already gone; going back again leaves the page, which
 *                          is the exact bug this whole mechanism exists to prevent.
 * · closed by a BUTTON  → yes. Our entry is still on the stack, and leaving it means the user's
 *                          next back "closes" an already-closed overlay and appears to do nothing.
 * · closed by NAVIGATION → no. A link inside the overlay took them somewhere; the new page pushed
 *                          its own state so our marker is no longer current. Going back here would
 *                          drag them off the page they just asked for.
 */
export function shouldRemoveEntry(s: OverlayState): boolean {
  return s.pushed && !s.popped && s.stillOurs;
}

/**
 * On a back gesture, should the overlay STAY open and re-arm the discard notice instead of closing?
 *
 * A dirty form gets the same two-tap guard from back as it gets from a backdrop tap: the first
 * back re-pushes the entry (so the user is still "inside") and arms "Tap again to discard"; the
 * second back is what actually discards. One rule for every dismissal, not a special case for
 * hardware buttons.
 */
export function shouldGuardBack(g: { dirty: boolean; confirmDiscard: boolean }): boolean {
  return g.dirty && !g.confirmDiscard;
}
