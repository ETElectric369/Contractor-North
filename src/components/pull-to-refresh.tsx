"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowDown } from "lucide-react";
import { useTheTurn } from "@/components/turns-sideways";
import { isTurned, thumbThroughTheTurn, type Held } from "@/lib/turned-geometry";

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
 * So this is built ONCE, here, and MOUNTED ONCE — in the app shell's own `<main>`, which is that one
 * scroller — so every screen in the app has it. It finds its scroller itself (the nearest scrollable
 * parent) and needs no data from the page it sits in, which is why no page mounts its own: a second
 * copy would refresh twice on one pull. cn-v1039 shipped it on /billing alone, where the report came
 * from, under this same headline; the headline was right and the wiring was short (pinned in the test).
 *
 * HOW IT BEHAVES, and why:
 *   · ONLY FROM THE TOP. The pull starts only when the scroller is already at the top, so scrolling
 *     back up through a long page never trips it.
 *   · ONLY ON THE PAGE'S OWN SURFACE — never inside one of the page's own scrollers (Erik, iPhone,
 *     /timecards): the week stack is a `max-h-[70dvh] overflow-y-auto` lid that arrives already
 *     scrolled down (useEndlessStack fills it backwards and holds your place), so the FIRST thing a
 *     thumb does there is drag DOWN inside the lid to reach the weeks the fill prepended — while
 *     `main` is still at the top from the navigation. Gating on `main.scrollTop <= 0` alone claimed
 *     that scroll as a pull: it blocked the lid while the move was still cancelable, drew the pill
 *     over it, and refreshed on release — and router.refresh() remounts the stack, so the prepended
 *     weeks go with the position. So the precondition is the whole chain from the thumb to the
 *     scroller, not one element's scrollTop: the surface the finger landed on must BELONG to the
 *     scroller we listen on (pullMayStart + scrollerOf). A lid keeps its gesture, the page keeps its
 *     pull — on /timecards, /calendar, /schedule, Nort's transcript, a More menu, a section sheet,
 *     and the next `max-h` + `overflow-y-auto` box somebody adds, without that page knowing.
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
 *   · AND IT WORKS WITH THE PHONE HELD TURNED, on the screens that may be (the schedule and the two
 *     document ones — lib/screens-that-turn.ts). That is not free, and it is not cosmetic either:
 *     while turned, THE ELEMENT THAT SCROLLS IS A DIFFERENT ELEMENT, and a thumb's travel arrives
 *     measured along an axis the content is no longer drawn on. Both halves are answered below —
 *     scrollerForTheTurn() and thumbThroughTheTurn() — from the one word that says how the phone is
 *     being held. Upright, every line of this behaves exactly as it did before any of that existed.
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
 * WHICH SCROLLER OWNS THIS SURFACE: the element itself if it scrolls vertically, else its nearest
 * ancestor that does — `main` in the app shell. Not "the nearest one with something to scroll": a
 * short page (an org with no invoices yet) still pulls down to refresh, and it is still the right
 * element to listen on once the page fills up.
 *
 * It answers two questions with one walk, which is why it starts at `el` and not at `el.parentElement`:
 * from the anchor it finds the scroller to LISTEN on (the anchor draws nothing and scrolls nothing,
 * so starting at itself changes nothing there), and from a touch's target it finds the scroller that
 * touch belongs to — including when the finger lands on the padding of the scrolling box itself.
 */
export function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/**
 * THE SELECTOR globals.css MOVES THE SCROLL ONTO while the phone is held turned, spelled once. The
 * stylesheet gives `main.turn-host` `overflow: hidden` and this element `overflow-y: auto` — so this
 * string and that rule are two halves of one fact, and the test asserts the stylesheet still says it.
 */
export const TURNED_FACE = ".turn-face[data-held]";

/**
 * THE TURNED FACE THIS SURFACE IS DRAWN INSIDE, or null for "nothing here is turned". A walk, not
 * `closest()`, for the same reason scrollerOf() is a walk: the rule is then readable without a browser,
 * and the suite runs in plain Node.
 */
export function turnedFaceAround(el: Element | null): HTMLElement | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.matches?.(TURNED_FACE)) return n as HTMLElement;
  }
  return null;
}

/**
 * WHICH ELEMENT SCROLLS RIGHT NOW — the whole resolution, pure, because the answer CHANGES when the
 * phone is turned and a gesture armed on the wrong element is a dead control.
 *
 * Upright: scrollerOf(), unchanged, which is `main` in the app shell. Turned: the face `main`'s scroll
 * was handed to.
 *
 * THE FALLBACK IS LOAD-BEARING, NOT DEFENSIVE, and the case is a real one that happens every time a
 * photo is opened. `held` says which way the SCREEN is drawn, and the turn has exactly one owner
 * (lib/screens-that-turn.ts): when a full-screen viewer owns it, `held` is "clockwise" while the app
 * shell's own region deliberately stays upright — no `data-held`, `display: contents`, and `main` still
 * the scroller, because that is what keeps the viewer full screen. So "turned" alone must not be read
 * as "the face below me is the scroller": the walk for a turned face is what settles it, and finding
 * none means `main` is still the right answer. (A pull is refused under an open viewer anyway — it
 * holds the body lock — so this is the second of two reasons it cannot go wrong, not the only one.)
 */
export function scrollerForTheTurn(anchor: Element | null, held: Held): HTMLElement | null {
  if (isTurned(held)) {
    const face = turnedFaceAround(anchor);
    if (face) return face;
  }
  return scrollerOf(anchor as HTMLElement | null);
}

/** Anything with a vertical scroll position: an element in the app, a stand-in in a test. */
type VScroller = { scrollTop: number };

/**
 * MAY THIS TOUCH BECOME A PULL — the whole precondition, in one place, pure, so it is read without a
 * browser and the listener decides nothing of its own (the next page with a `max-h` +
 * `overflow-y-auto` box must not be able to re-break this by accident).
 *
 *   · one finger (two is a pinch, a zoom, a map)
 *   · no sheet open — router.refresh() there replaces the history entry without the Modal's marker,
 *     which breaks the back gesture out of an open sheet
 *   · the scroller we listen on is already at its top, so scrolling back up never trips it
 *   · and NOTHING between the thumb and that scroller can scroll: `surface` is the scroller that owns
 *     the surface the finger landed on (scrollerOf(e.target)), and it has to BE the scroller we
 *     listen on. A drag inside a page's own lid — a week stack, Nort's transcript, a More menu — is
 *     that lid's scroll, not a pull, whether the lid is at its top or a month down.
 */
export function pullMayStart(o: {
  fingers: number;
  sheetOpen: boolean;
  scroller: VScroller | null;
  surface: VScroller | null;
}): boolean {
  if (o.fingers !== 1 || o.sheetOpen) return false;
  if (!o.scroller || o.scroller.scrollTop > 0) return false;
  return o.surface === o.scroller;
}

export function PullToRefresh() {
  const router = useRouter();
  const anchor = useRef<HTMLSpanElement>(null);
  /** How far the thumb has pulled past the slop, in px. 0 = nothing is happening. */
  const [pulled, setPulled] = useState(0);
  /** The same figure the listeners read, so a release never acts on a stale render. */
  const live = useRef(0);
  const [refreshing, startRefresh] = useTransition();
  /**
   * HOW THE PHONE IS BEING HELD, from the one writer (components/turns-sideways.tsx) — the SAME word
   * <Turned> draws the face with, not a second reading of the hardware. It decides two things here and
   * it is in this effect's dependencies, so the moment the phone turns the listeners come off the old
   * scroller and go onto the new one. Without that, a turn would leave the gesture bound to a `main`
   * that had stopped scrolling.
   */
  const { held } = useTheTurn();

  useEffect(() => {
    const scroller = scrollerForTheTurn(anchor.current, held);
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
      // The one rule, read from the one place: the listener reports the facts and obeys the answer.
      if (
        !pullMayStart({
          fingers: e.touches.length,
          sheetOpen: document.body.classList.contains("modal-open"),
          scroller,
          surface: scrollerOf(e.target as HTMLElement | null),
        })
      )
        return stop();
      tracking = true;
      pulling = false;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      // THE THUMB, IN THE FRAME THE CONTENT IS DRAWN IN. clientX/clientY are the GLASS's, and while
      // the phone is held turned the face has been painted a quarter turn under them — so a pull down
      // the person's own view arrives here as a drag sideways, and readPullMove would correctly call
      // that "not ours" and drop it. One mapping, the same inverse the face is drawn with
      // (lib/turned-geometry), and upright it returns the deltas untouched.
      const thumb = thumbThroughTheTurn(
        { dx: e.touches[0].clientX - startX, dy: e.touches[0].clientY - startY },
        held,
      );
      const move = readPullMove({ dy: thumb.dy, dx: thumb.dx, claimed: pulling });
      if (move.kind === "notOurs") return void (tracking = false);
      if (move.kind === "ignore") return;
      pulling = true;
      // The drag began on the page's own surface, with the page already at its top and unable to
      // move down (overscroll-behavior) — pullMayStart established both — so taking the gesture
      // here steals nothing. But it must be cancelable to take it at all.
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
    // Re-bound when the phone turns and at no other time: the release reads the live figure off a ref,
    // never a rendered one, so `pulled` is deliberately not a dependency.
  }, [router, held]);

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
          //
          // `pull-pill`: HELD TURNED, THIS IS FIXED INSIDE A TRANSFORMED BOX, which makes the face its
          // containing block instead of the window — so it is already centred across the person's view
          // and painted upright with the content, and only the offset needs saying. Inside the face
          // there is no top bar above it and no notch at the person's top (the notch is down one side),
          // so globals.css trades both of those for a plain 0.75rem. Not a second indicator: the same
          // one, told where the top is.
          className="pull-pill pointer-events-none fixed inset-x-0 top-[calc(var(--sat,0px)+4.75rem)] z-30 flex justify-center"
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
