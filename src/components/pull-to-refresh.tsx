"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowDown } from "lucide-react";

/**
 * PULL DOWN TO REFRESH — ONE OF THEM, FOR EVERY SCREEN (bug report 44aeec9c, Erik on /billing
 * 2026-09-22: "can we pull down to refresh?").
 *
 * There was no pull-to-refresh anywhere in the app. In the iOS shell there CAN'T be the browser's
 * own: the shell's root is h-dvh + overflow-hidden and globals.css turns the document's rubber-band
 * off on purpose (a drag on the topbar or the dock used to expose the native background), so the
 * page a person is reading is `main`, the one scroller, and nothing happens when they pull it down.
 *
 * The nearest thing that existed is RefreshOnVisible (lib/components/refresh-on-visible): it
 * re-reads when the app comes back to the front and polls while it's open. That answers "is this
 * stale?" by itself; it does not answer "refresh it NOW", which is what a thumb on the screen is
 * asking. They stack: a page can have both.
 *
 * So this is built ONCE, here, and any screen gets it by mounting <PullToRefresh /> anywhere inside
 * itself. It finds its own scroller (the nearest scrollable parent, which in the app shell is
 * `main`), so no page has to pass anything.
 *
 * HOW IT BEHAVES, and why:
 *   · ONLY FROM THE TOP. The pull starts only when the scroller is already at the top, so scrolling
 *     back up through a long page never trips it.
 *   · ONLY A DOWNWARD, MOSTLY-VERTICAL DRAG, and the first few pixels are left alone, so a sideways
 *     swipe (a back gesture, a horizontal strip) is never stolen.
 *   · NOT WHILE A SHEET IS OPEN (body.modal-open) — the same rule RefreshOnVisible follows:
 *     router.refresh() replaces the history entry without the Modal's marker, which breaks the back
 *     gesture out of an open sheet.
 *   · IT SAYS WHAT IT IS DOING at every stage (nothing silent): the arrow follows the thumb, "Let
 *     go to refresh" once it's far enough, then "Refreshing…" until the new page is in. The
 *     indicator is drawn only while something is happening — at rest it draws nothing.
 *   · IT WAITS FOR THE ANSWER. router.refresh() inside a transition means isPending is true until
 *     the server has sent the new page, so the spinner ends when the data actually arrives instead
 *     of after a guessed delay.
 *   · TOUCH ONLY: a mouse never fires these events, so desktop is untouched.
 */

/** How far the thumb has to travel before the release refreshes (px of real finger movement). */
const TRIGGER = 64;
/** The first few pixels are the browser's to interpret (a tap, a sideways swipe), not ours. */
const SLOP = 12;
/** The indicator stops following the thumb here, so a long pull doesn't drag it down the screen. */
const MAX = 96;

/**
 * WHAT ONE MOVE OF THE THUMB MEANS — the whole gesture rule, pure, so it is read without a browser.
 *
 *   "ignore"  nothing yet: still inside the slop, waiting to see what this drag is.
 *   "notOurs" this drag belongs to the page, not to us (it went UP, or it went sideways). Stop
 *             watching it until the next touch, so a scroll back up through a long page and a
 *             sideways swipe are never stolen.
 *   "pull"    a downward, mostly-vertical drag from the top: how far to show it pulled, capped so a
 *             long pull doesn't drag the indicator down the screen.
 *
 * Once a drag has been claimed as a pull it stays one (`claimed`), so a thumb that wanders sideways
 * halfway down doesn't abandon the pull under the person's finger.
 */
export type PullMove = { kind: "ignore" } | { kind: "notOurs" } | { kind: "pull"; px: number };

export function readPullMove(o: { dy: number; dx: number; claimed: boolean }): PullMove {
  const px = Math.max(0, Math.min(o.dy - SLOP, MAX));
  if (o.claimed) return { kind: "pull", px };
  if (o.dy <= SLOP) return o.dy < -2 ? { kind: "notOurs" } : { kind: "ignore" };
  if (Math.abs(o.dx) > Math.abs(o.dy)) return { kind: "notOurs" };
  return { kind: "pull", px };
}

/** Far enough that letting go refreshes. */
export const pullReleases = (px: number): boolean => px >= TRIGGER;

/**
 * The nearest ancestor that scrolls vertically — `main` in the app shell. Not "the nearest one with
 * something to scroll": a short page (an org with no invoices yet) still pulls down to refresh, and
 * it is still the right element to listen on once the page fills up.
 */
export function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n: HTMLElement | null = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

export function PullToRefresh() {
  const router = useRouter();
  const anchor = useRef<HTMLSpanElement>(null);
  /** How far the thumb has pulled past the slop, in px. 0 = nothing is happening. */
  const [pulled, setPulled] = useState(0);
  /** The same figure the listeners read, so a release never acts on a stale render. */
  const live = useRef(0);
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    const scroller = scrollerOf(anchor.current);
    if (!scroller) return;
    // The live gesture, kept out of state so a move never re-renders more than the indicator.
    let startY = 0;
    let startX = 0;
    let tracking = false; // the drag began at the top of the scroller
    let pulling = false; // …and has been claimed as a pull (past the slop, mostly vertical)

    const show = (px: number) => {
      live.current = px;
      setPulled(px);
    };
    const stop = () => {
      tracking = false;
      pulling = false;
      show(0);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || document.body.classList.contains("modal-open")) return stop();
      tracking = scroller.scrollTop <= 0;
      pulling = false;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const move = readPullMove({
        dy: e.touches[0].clientY - startY,
        dx: e.touches[0].clientX - startX,
        claimed: pulling,
      });
      if (move.kind === "notOurs") return void (tracking = false);
      if (move.kind === "ignore") return;
      pulling = true;
      // The scroller is at the top and cannot move down (overscroll-behavior), so taking the
      // gesture here steals nothing — but it must be cancelable to take it at all.
      if (e.cancelable) e.preventDefault();
      show(move.px);
    };

    const onEnd = () => {
      if (pulling && pullReleases(live.current)) startRefresh(() => router.refresh());
      stop();
    };

    scroller.addEventListener("touchstart", onStart, { passive: true });
    // passive: false — a pull can only be claimed by a listener allowed to preventDefault.
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd);
    scroller.addEventListener("touchcancel", stop);
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", stop);
    };
    // Bound once: the release reads the live figure off a ref, never a rendered one.
  }, [router]);

  const ready = pullReleases(pulled);
  const showing = refreshing || pulled > 0;

  return (
    <>
      {/* Where this page sits in the DOM, so the scroller can be found. Draws nothing. */}
      <span ref={anchor} aria-hidden className="hidden" />
      {showing && (
        <div
          // Just under the top bar (h-[calc(4rem+var(--sat))], in flow), reading the shell's own
          // safe-area variable so it lands in the same place on a notched phone. z-30 keeps it under
          // every sheet and menu.
          className="pointer-events-none fixed inset-x-0 top-[calc(var(--sat,0px)+4.75rem)] z-30 flex justify-center"
          style={refreshing ? undefined : { transform: `translateY(${Math.round(pulled / 2)}px)` }}
        >
          <p
            role="status"
            aria-live="polite"
            className="flex min-h-9 items-center gap-2 rounded-full bg-white/95 px-3 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200"
          >
            {refreshing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Refreshing…
              </>
            ) : (
              <>
                <ArrowDown className={`h-4 w-4 transition-transform ${ready ? "rotate-180" : ""}`} />
                {ready ? "Let Go To Refresh" : "Pull To Refresh"}
              </>
            )}
          </p>
        </div>
      )}
    </>
  );
}
