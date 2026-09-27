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

/**
 * NESTED OVERLAYS: ONE BACK CLOSES ONE SHEET, THE TOP ONE.
 *
 * A row's ⋯ sheet opens Move To Another Day or Edit Details above itself. Every open Modal used to
 * listen for popstate and close on it, so one Back closed both; and the child's own clean-up (its
 * history.back() after Cancel) arrived at the sheet underneath as a Back, so cancelling the child
 * closed the sheet too, and a half-filled form in it went with it.
 *
 * The order the overlays opened in decides:
 *  · a Back (and an Escape) belongs to the overlay on top; the ones under it ignore it;
 *  · an overlay that takes its own entry off after a button close tells the one under it, so that
 *    pop is not taken for a Back;
 *  · an overlay that closes while another is still open above it (a parent unmounting a moment
 *    before its child) can't step history back yet: its entry sits under the child's. It hands the
 *    step to the child, which takes both off in one go, or neither if the child's entry turned out
 *    not to be ours (a link inside it navigated), because undoing a navigation is never right.
 *
 * Pure bookkeeping: the Modal calls it and does the one history.go it is told to.
 */
export interface OverlayStack {
  /** An overlay opened, on top of every one already open. */
  open(id: string): void;
  /** Is this overlay the one on top: the one a Back or an Escape belongs to? */
  isTop(id: string): boolean;
  /**
   * A popstate arrived; should the overlay `id` take it as its Back? Only the top one does, and not
   * when the pop was a child above it taking its own entry off (that one is consumed here).
   */
  ownsPop(id: string): boolean;
  /**
   * The overlay `id` is closing. How it closed is the Modal's own reading (overlay-history's three
   * cases); the answer is how many history entries to step back now (0: leave history alone).
   */
  close(id: string, how: OverlayState): number;
  /** The open overlays, bottom first (for tests and for nothing else). */
  readonly order: readonly string[];
}

export function createOverlayStack(): OverlayStack {
  const order: string[] = [];
  /** Entries of overlays that closed under this one, to take off with this one's own. */
  const handedOver = new Map<string, number>();
  /** Pops to ignore: an overlay above this one took its own entry off. */
  const childPops = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);
  const isTop = (id: string) => order.length > 0 && order[order.length - 1] === id;

  return {
    get order() {
      return order;
    },
    open(id) {
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at, 1);
      order.push(id);
    },
    isTop,
    ownsPop(id) {
      if (!isTop(id)) return false;
      const n = childPops.get(id) ?? 0;
      if (n > 0) {
        childPops.set(id, n - 1);
        return false;
      }
      return true;
    },
    close(id, how) {
      const at = order.indexOf(id);
      if (at < 0) return 0;
      const extra = handedOver.get(id) ?? 0;
      handedOver.delete(id);
      childPops.delete(id);
      const top = at === order.length - 1;
      order.splice(at, 1);
      if (!top) {
        // Under another overlay: nothing popped it (a Back belongs to the top one), and its entry is
        // under the one above it, so the one above takes it off with its own.
        if (how.pushed && !how.popped) bump(handedOver, order[at], 1 + extra);
        return 0;
      }
      // Closed by Back: its entry is gone already; the ones handed to it sit right under it.
      // Closed by a button with its entry still on top: that entry, and the ones handed to it.
      // Anything else (a navigation took the top): history is left alone.
      const n = how.popped ? extra : shouldRemoveEntry(how) ? 1 + extra : 0;
      if (n > 0 && order.length > 0) bump(childPops, order[order.length - 1], 1);
      return n;
    },
  };
}

/**
 * ONE STEP BACK FOR EVERY OVERLAY THAT CLOSES IN THE SAME MOMENT. A sheet and the Move sheet above it
 * can close together (a successful move closes both). Two history.back() calls in one tick are not
 * two steps everywhere (WebKit keeps one scheduled history navigation and drops the other), which
 * would strand an entry and make the next Back do nothing. So the steps asked for in one tick add up
 * and go out as a single history.go(-n) once the tick is done.
 */
export function createBackStepper(go: (steps: number) => void, later: (fn: () => void) => void): (steps: number) => void {
  let pending = 0;
  return (steps) => {
    if (!(steps > 0)) return;
    pending += steps;
    if (pending !== steps) return; // a step is already on its way this tick: it carries these too
    later(() => {
      const n = pending;
      pending = 0;
      if (n > 0) go(n);
    });
  };
}

/** The stack every Modal on the page shares for Back (the ones that keep a history entry). */
export const backStack = createOverlayStack();
/** The stack every open Modal shares for Escape (history entry or not). */
export const escapeStack = createOverlayStack();
