"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
 *   · FILL TO THE FOLD (opt-in) — growth rides on scroll events, and a box whose content is
 *     shorter than the box never fires one. Timecards on a phone: two light weeks under a 70dvh
 *     lid could not scroll, so the stack could never grow backwards and every earlier week was
 *     unreachable until something happened to add height. Erik 2026-09-16, iPhone,
 *     /timecards?week=2: "Scroll doesn't work until I click around." With `fillToOverflow` the
 *     hook prepends one step per animation frame — after mount, after a jump, after every growth,
 *     after a rotation — until the box actually overflows or the back cap is hit. It is not a
 *     gesture, so the 350 ms beat never throttles it; but each step takes the same latch and the
 *     same hold-his-place restore, so the anchor week stays where he is looking and a gesture can
 *     never double up on a step in flight. Off by default: the calendar behaves exactly as before.
 */
export function useEndlessStack(
  anchorKey: string,
  maxBack = 26,
  maxFwd = 52,
  opts?: { fillToOverflow?: boolean },
) {
  const fillToOverflow = !!opts?.fillToOverflow;
  const [back, setBack] = useState(0);
  const [fwd, setFwd] = useState(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const growingRef = useRef(false);
  const anchorRef = useRef(0);
  const lastTopRef = useRef(0);
  const lastGrowRef = useRef(0);
  // Live copies for the fill step, which runs inside a rAF callback: a value closed over by the
  // effect that scheduled it can be a render stale (the reset effect's `back` is the pre-jump count,
  // and at the cap that stale count would refuse a fill the fresh stack is owed).
  const backRef = useRef(back);
  backRef.current = back;
  const maxBackRef = useRef(maxBack);
  maxBackRef.current = maxBack;
  const fillRafRef = useRef(0);

  /* ONE STEP PER FRAME, MEASURED LIVE. Scheduling cancels any step still queued, so a jump can't
     land a step measured against the stack it just replaced. The check reads the DOM at the moment
     it runs and bails the instant the box overflows — from there the gestures take over. */
  const scheduleFill = useCallback(() => {
    if (!fillToOverflow || typeof requestAnimationFrame === "undefined") return;
    cancelAnimationFrame(fillRafRef.current);
    fillRafRef.current = requestAnimationFrame(() => {
      fillRafRef.current = 0;
      const el = scrollRef.current;
      if (!el || growingRef.current) return;
      // Not laid out (nothing rendered yet, or hidden) — there is nothing to measure, and a fill
      // against a 0px box would run straight to the cap.
      if (el.clientHeight === 0) return;
      if (el.scrollHeight > el.clientHeight) return;
      if (backRef.current >= maxBackRef.current) return;
      growingRef.current = true;
      /* ARMS THE BEAT, NOT THROTTLED BY IT. The last step's restore lands at the very bottom of a
         box that only just overflows, and that scrollTop write echoes a scroll event from there.
         Inside the beat the echo is physics and ignored; outside it the forward branch would read
         it as a downward gesture and open a week nobody asked for. Same beat a gesture growth arms. */
      lastGrowRef.current = Date.now();
      anchorRef.current = el.scrollHeight;
      setBack((b) => b + 1);
    });
  }, [fillToOverflow]);

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
    // Mount and every jump start the fill from a clean slate. Scheduled AFTER the reset so the
    // check runs against the re-anchored stack, and it replaces any step queued before the jump.
    scheduleFill();
  }, [anchorKey, scheduleFill]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !growingRef.current) return;
    if (anchorRef.current) {
      /* KILL THE MOMENTUM FIRST. iOS ignores scrollTop writes while a momentum scroll is live, so
         the restore below silently failed mid-flick and the view stayed on the freshly PREPENDED
         week — one week back per beat for as long as the glide lasted ("scroll keeps jumping me
         way back", and every rescue tap only stopped the lurch instead of clicking). Toggling
         overflow is the one reliable way to stop a glide: hidden ends it, the write lands, auto
         resumes. One flick now opens exactly one week and stops — a page turn, not a slot machine. */
      const prevOverflow = el.style.overflow;
      el.style.overflow = "hidden";
      el.scrollTop += el.scrollHeight - anchorRef.current;
      void el.offsetHeight; // flush so the write is applied before overflow returns
      el.style.overflow = prevOverflow;
      anchorRef.current = 0;
      lastTopRef.current = el.scrollTop;
    }
    growingRef.current = false;
    // After every growth, gesture or fill alike: is there still room under the lid?
    scheduleFill();
  }, [back, fwd, scheduleFill]);

  // A rotation makes the box taller (portrait after landscape), so the fill re-checks; when the
  // box already overflows the step is a no-op. Unmount drops any step still queued.
  useEffect(() => {
    if (!fillToOverflow || typeof window === "undefined") return;
    window.addEventListener("resize", scheduleFill);
    return () => {
      window.removeEventListener("resize", scheduleFill);
      cancelAnimationFrame(fillRafRef.current);
    };
  }, [fillToOverflow, scheduleFill]);

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

  // The caps ride back out so consumers can say "this is the edge" without hand-copying the
  // number — the timecards notice had its own literal 26, one retune away from lying.
  return { back, fwd, scrollRef, onScroll, maxBack, maxFwd, atBackCap: back >= maxBack, atFwdCap: fwd >= maxFwd };
}
