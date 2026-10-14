import type { AgentScreen } from "@/lib/assistant-protocol";

/**
 * THE HANDS — performs one show_screen block on this phone (field feedback 10-13, item 6).
 *
 * Four moves, in the order a person would make them: park Nort's box (so the screen is theirs),
 * open the menu he's pointing into, go to the path, then find the spot and ring it. The spot is
 * found the way the tour finds one (components/tour/tour-spotlight): by `data-tour` name, then by
 * element id, the first VISIBLE match — the dock is a rail on a computer and a bar on a phone and
 * only one of them has a size. After a navigation the page has to arrive first, so the finder
 * polls for a few seconds before giving up; a spot that never shows is a point not made, never an
 * error (the tour's rule: a missing anchor is not a broken step).
 *
 * THE RING IS NOT THE TOUR'S DIMMER. Erik: "i dont want it waiting for me to click anything." A
 * class goes on the element and comes off by itself; the page stays fully usable underneath.
 */
export const RING_CLASS = "cn-nort-ring";
export const RING_MS = 4000;
/** How long to wait for a spot after a navigation (a cold page over a field signal). */
export const FIND_MS = 6000;
const POLL_MS = 120;

export const BOX_EVENT = "cn:assistant-box";
export const MENU_EVENT = "cn:tour-menu";

const visible = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2;
};

/** The first visible element named `name` — by `data-tour`, then by id. Null when none is. */
export function findSpot(name: string, doc: Document = document): HTMLElement | null {
  const all = Array.from(doc.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`));
  const byId = doc.getElementById(name);
  if (byId) all.push(byId);
  return all.find(visible) ?? null;
}

/** The ring's own off-timer per element, so a spot rung twice gets the full RING_MS from the second. */
const ringTimers = new WeakMap<Element, number>();

/** Scroll the spot into view when it isn't, then ring it for RING_MS. Re-ringing restarts it. */
export function ringSpot(el: HTMLElement, win: Window = window): void {
  const r = el.getBoundingClientRect();
  const inView = r.top >= 0 && r.bottom <= (win.innerHeight || 0);
  if (!inView) el.scrollIntoView({ block: "center", behavior: "smooth" });
  const prev = ringTimers.get(el);
  if (prev) win.clearTimeout(prev);
  el.classList.remove(RING_CLASS);
  // Force the animation to restart on a spot rung twice in a row.
  void el.offsetWidth;
  el.classList.add(RING_CLASS);
  ringTimers.set(el, win.setTimeout(() => el.classList.remove(RING_CLASS), RING_MS));
}

/** One poll at a time: a newer block's search cancels an older one still waiting (so block 1
 *  cannot ring its spot seconds after block 2 moved the screen on). */
let pollGeneration = 0;

/**
 * Keep looking for the spot until it shows or the wait runs out; ring it when it does. `ready`
 * holds the search until the page we pushed has ARRIVED — the first poll runs before the
 * transition commits, and a name that lives on both pages (needs-you: Bills and My Day) would
 * otherwise ring the one we are leaving. A miss after the wait is SAID (onMiss), never silent.
 */
export function pointAt(
  name: string,
  waitMs: number,
  win: Window = window,
  opts: { ready?: () => boolean; onMiss?: (name: string) => void } = {},
): void {
  const mine = ++pollGeneration;
  const until = Date.now() + waitMs;
  const tick = () => {
    if (mine !== pollGeneration) return; // a newer move took over
    const el = opts.ready && !opts.ready() ? null : findSpot(name, win.document);
    if (el) {
      ringSpot(el, win);
      return;
    }
    if (Date.now() < until) win.setTimeout(tick, POLL_MS);
    else opts.onMiss?.(name);
  };
  tick();
}

export type ScreenNav = {
  /** Where we are: pathname + search. */
  here: () => string;
  /** Go there (the app router, so the chat stays mounted and the stream keeps streaming). */
  push: (path: string) => void;
};

const noHash = (s: string) => s.split("#")[0];

/** Perform one block. Returns what it did, for the log line and the tests. */
export function performScreen(
  s: AgentScreen,
  nav: ScreenNav,
  win: Window = window,
  opts: { onMiss?: (s: AgentScreen) => void } = {},
): { moved: boolean; pointed: boolean } {
  if (s.box) win.dispatchEvent(new CustomEvent(BOX_EVENT, { detail: { box: s.box, label: s.label ?? null } }));
  // sticky:false — the person may close it the usual ways (outside tap, Escape); the tour's own
  // open is sticky because the tour closes what it opened.
  if (s.menu) win.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: { menu: s.menu, open: true, sticky: false } }));
  let moved = false;
  const target = s.path ? noHash(s.path) : null;
  if (target && target !== noHash(nav.here())) {
    nav.push(target);
    moved = true;
  }
  if (s.anchor) {
    pointAt(s.anchor, moved ? FIND_MS : 1500, win, {
      ready: moved && target ? () => noHash(nav.here()) === target : undefined,
      onMiss: () => opts.onMiss?.(s),
    });
  }
  return { moved, pointed: !!s.anchor };
}
