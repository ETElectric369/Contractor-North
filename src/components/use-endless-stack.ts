"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * AN ENDLESS STACK, ONE IMPLEMENTATION.
 *
 * Erik: "lets keep the scroll as week view and get rid of the fixed week view … and lets make the
 * month view apply all the same new rules."
 *
 * The scrolling stack turned out to be the week view he actually wanted, so the fixed one is gone
 * rather than left beside it as a second answer to the same question. The month wants the same
 * behaviour — which is exactly why this is a hook and not a second copy. Two copies of a scroll
 * latch is how the month ends up cycling six months on a flick a week after the week view stopped
 * doing it, and a hand-copied list has already bitten this app once this week.
 *
 * Every subtlety in here was learned the hard way:
 *   · DIRECTION, not just position — at rest the scroller sits at 0, which already satisfies the
 *     top sentinel, so a position-only test grew backwards on the very first touch, going down.
 *   · A LATCH, and it must be a REF — scroll fires dozens of times per frame and React batches, so
 *     `back < max` reads a stale value in every one of those calls and the functional updates all
 *     land. That is the "six months in half a second" bug.
 *   · HOLD HIS PLACE — prepending shoves what he was reading down by a whole grid. Restored before
 *     paint, and the restore must not itself be read as a gesture.
 *   · RESET ON A JUMP — pressing Today with forty weeks unrolled should land on today, not on
 *     today plus everything he had opened up.
 */
export function useEndlessStack(anchorKey: string, maxBack = 26, maxFwd = 52) {
  const [back, setBack] = useState(0);
  const [fwd, setFwd] = useState(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const growingRef = useRef(false);
  const anchorRef = useRef(0);
  const lastTopRef = useRef(0);
  const lastGrowRef = useRef(0);

  useEffect(() => {
    setBack(0);
    setFwd(1);
    growingRef.current = false;
    anchorRef.current = 0;
    lastTopRef.current = 0;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      /* THE BROWSER ANCHORS TOO. Chrome's native scroll anchoring compensates for content
         inserted above the viewport — and so does the manual restore below, so a prepend was
         corrected TWICE and the view lurched by a week's height, compounding on every growth
         until a backwards scroll "skips me back to the beginning of july" (Erik). One anchor
         only: ours, because Safari has none and the restore must work everywhere. */
      scrollRef.current.style.overflowAnchor = "none";
    }
  }, [anchorKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !growingRef.current) return;
    if (anchorRef.current) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = 0;
      lastTopRef.current = el.scrollTop;
    }
    growingRef.current = false;
  }, [back, fwd]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    /* iOS RUBBER-BAND IS NOT A GESTURE. During the bounce, scrollTop goes NEGATIVE — which reads
       as "going up" AND "at the top", so a bare tug at rest fired a prepend, and the layout
       effect's scrollTop restore then fought WebKit's own bounce animation. That fight, repeated,
       is the freeze Erik hit on his phone. An overscrolled frame is ignored entirely — not even
       recorded as the last position, or the settle back to 0 would read as an upward gesture. */
    if (el.scrollTop < 0) return;
    const top = el.scrollTop;
    const goingUp = top < lastTopRef.current;
    lastTopRef.current = top;
    if (growingRef.current) return;
    /* ONE GROWTH PER BEAT. iOS momentum keeps delivering scroll events after the finger lifts,
       and each restore re-arms the latch — so a single hard flick could chain prepends all the
       way to the cap (Erik's phone landed on a week in April). A gesture reaches an edge at
       most a couple of times a second; anything faster is physics, not intent. */
    const now = Date.now();
    if (now - lastGrowRef.current < 350) return;

    if (goingUp && top < 120 && back < maxBack) {
      growingRef.current = true;
      lastGrowRef.current = now;
      anchorRef.current = el.scrollHeight;
      setBack((b) => b + 1);
      return;
    }
    if (!goingUp && el.scrollHeight - top - el.clientHeight < 240 && fwd < maxFwd) {
      growingRef.current = true;
      lastGrowRef.current = now;
      setFwd((f) => f + 1);
    }
  }

  return { back, fwd, scrollRef, onScroll };
}
