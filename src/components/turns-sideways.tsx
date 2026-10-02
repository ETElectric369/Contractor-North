"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { watchHowThePhoneIsHeld } from "@/lib/native-orientation";
import { mayTurnSideways, type ScreenThatTurns } from "@/lib/screens-that-turn";
import { isTurned, uprightTurn, type Held } from "@/lib/turned-geometry";

/**
 * THE ONE THING THAT KNOWS THE PHONE HAS BEEN TURNED.
 *
 * Mounted ONCE, in the ROOT layout, beside <BackLinkTracker /> — so it never unmounts, it sees every
 * route including /print/*, and no screen has to remember to do anything. What may turn is declared
 * in lib/screens-that-turn.ts and nowhere else; everything not named there stays as it is.
 *
 * WHAT CHANGED, AND WHY. This used to ask the shell to let iOS rotate the interface. iOS rotating the
 * interface is what carried the top bar and the dock around with it — Erik, on cn-v1041: "nice it
 * rotates now on schedule but the dock and top bar rotate with it still". The shell is portrait-
 * locked again, so the chrome cannot move: it is pinned to the phone's real top and bottom edges
 * because nothing moves at all. This watcher is told which way the phone is HELD, and hands that one
 * word to the two things that draw:
 *   · <Turned> (components/turned.tsx) — lays the content region out at the swapped dimensions and
 *     paints it a quarter turn, so the page gets a real landscape viewport.
 *   · `html[data-phone-held]` + `--turn-deg` — the stylesheet rule that paints every square chrome
 *     control's face through the SAME quarter turn, so the buttons read upright. Both numbers come
 *     from uprightDegrees() in lib/turned-geometry.ts; neither is written out by hand.
 *
 * ONE WRITER, which is the whole reason this is a watcher and not a per-screen call. A full-screen
 * document viewer can open ON TOP of a screen that already turns (a receipt opened from the
 * schedule): if the viewer answered for itself on its way out it would un-turn the screen underneath
 * that was allowed to be turned. So a layer REGISTERS itself here and this works out the one answer —
 * route, plus anything open over it, plus whether somebody is typing.
 *
 * EVERY WAY OF ARRIVING AND LEAVING lands on this effect:
 *  - deep link straight onto a turning screen, or a hard reload on one → the first run, on mount,
 *    which also ASKS the shell which way the phone is being held right now
 *  - walking off it, the back gesture, a tab switch → pathname changes
 *  - opening or closing a document over it → `layers` changes
 *  - turning the phone while standing still → the shell's own report
 * and leaving while turned cannot strand anyone: the layout goes back to portrait the same frame the
 * route changes, because portrait is what the glass is already showing.
 */

/**
 * The full-screen layers open right now, innermost last. An ARRAY, not a flag: two viewers can be
 * open at once (a lightbox over a lightbox), and the one that closes first must not take the other
 * one's permission with it.
 */
const openLayers: ScreenThatTurns[] = [];
const layerWatchers = new Set<() => void>();

/**
 * A FULL-SCREEN LAYER SAYS IT MAY BE TURNED SIDEWAYS. For a viewer that covers the screen instead of
 * being a route of its own — today the photo/PDF lightbox. The name must be one declared in
 * screens-that-turn.ts with a reason, so a layer cannot slip in without one either.
 */
export function useTurnsSidewaysLayer(screen: ScreenThatTurns) {
  useEffect(() => {
    openLayers.push(screen);
    for (const w of layerWatchers) w();
    return () => {
      const at = openLayers.lastIndexOf(screen);
      if (at >= 0) openLayers.splice(at, 1);
      for (const w of layerWatchers) w();
    };
  }, [screen]);
}

// ── THE ANSWER, published to everything that draws ──────────────────────────────────────────────

/**
 * `bottomChrome` is how many pixels at the bottom of the scrolling middle the DOCK is sitting over.
 * The dock floats (fixed, inset-x-2, bottom-2) rather than taking a row of its own, so the middle's
 * box runs underneath it; a rotated region that used the whole box would draw the last strip of a
 * document under the glass. MEASURED off the real dock, never a number copied out of dock.tsx.
 */
export type TurnAnswer = { readonly held: Held; readonly bottomChrome: number };

const UPRIGHT: TurnAnswer = { held: "upright", bottomChrome: 0 };
let answer: TurnAnswer = UPRIGHT;
const answerWatchers = new Set<() => void>();

function publish(next: TurnAnswer) {
  if (next.held === answer.held && next.bottomChrome === answer.bottomChrome) return;
  answer = next;
  for (const w of answerWatchers) w();
}

function subscribeToTheTurn(fn: () => void): () => void {
  answerWatchers.add(fn);
  return () => {
    answerWatchers.delete(fn);
  };
}

/** How the screen is turned right now. Upright during server rendering and on the first paint. */
export function useTheTurn(): TurnAnswer {
  return useSyncExternalStore(
    subscribeToTheTurn,
    () => answer,
    () => UPRIGHT,
  );
}

/** How much of the middle the dock covers, measured. Exported for the test, not for a call site. */
export function dockCoverage(dockTop: number | null, viewportHeight: number): number {
  if (dockTop === null || !Number.isFinite(dockTop) || !Number.isFinite(viewportHeight)) return 0;
  return Math.max(0, Math.round(viewportHeight - dockTop));
}

function measureTheDock(): number {
  if (typeof document === "undefined") return 0;
  const dock = document.querySelector(".app-dock");
  if (!dock) return 0; // /print/* has no dock, and neither does a desktop window
  const box = dock.getBoundingClientRect();
  if (box.height === 0) return 0; // hidden behind a modal
  return dockCoverage(box.top, window.innerHeight);
}

/**
 * IS THE PERSON TYPING? The iOS keyboard comes up in the DEVICE's orientation, which with the
 * interface locked to portrait means it rises from the phone's bottom edge — the person's left or
 * right hand side — and sits over the dock. Typing into a box drawn a quarter turn away from the
 * keyboard is miserable, and two of the four screens that turn do have boxes: /schedule's "Why?" line
 * (autofocused, place-rail.tsx) and /price-list's search and its inline price cells.
 *
 * So the turn SUSPENDS while a text box has focus: the screen comes upright, the keyboard matches it,
 * and the moment the box is left the screen turns back if the phone is still sideways. NOT a select
 * or a checkbox — iOS draws those in its own sheet and they are fine either way.
 */
export function typingInto(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === "textarea") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (tag !== "input") return false;
  const type = ((el as HTMLInputElement).type || "text").toLowerCase();
  return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image"].includes(type);
}

/**
 * THE WHOLE DECISION, as one pure answer: which way is the screen drawn right now?
 *
 * Pure on purpose, because this is the line that decides and therefore the line that has to be tested
 * — every way of arriving at a turned screen and every way of leaving one goes through here:
 *  - a deep link or a hard reload onto a listed screen while the phone is already sideways
 *  - turning the phone while standing on one
 *  - walking off it, the back gesture, a tab switch → `pathname` is not a listed screen any more, so
 *    this answers upright and the screen is upright the same frame, with nothing to wait for
 *  - a full-screen viewer opening over a screen that is NOT listed (it turns), and closing again (the
 *    screen underneath gets its own answer back, which is what `layers` is for)
 *  - somebody tapping into a text box → upright, so the keyboard is usable
 * NOTHING STUCK falls straight out of that: there is no state here to get stuck IN.
 */
export function whichWayToDraw(at: {
  pathname: string;
  layers: number;
  held: Held;
  typing: boolean;
}): Held {
  if (at.typing) return "upright";
  return mayTurnSideways(at.pathname, at.layers) ? at.held : "upright";
}

export function TurnsSideways() {
  const pathname = usePathname();
  const [layers, setLayers] = useState(0);
  const [held, setHeld] = useState<Held>("upright");
  const [typing, setTyping] = useState(false);
  // What we last PUT ON THE DOCUMENT, so an ordinary navigation between two screens that both stay
  // upright never touches the DOM at all.
  const wrote = useRef<Held | null>(null);

  useEffect(() => {
    const tell = () => setLayers(openLayers.length);
    layerWatchers.add(tell);
    // A layer that mounted before this watcher did (it can't today — this is in the root layout —
    // but a count read once at mount is cheaper than a rule nobody can see).
    tell();
    return () => {
      layerWatchers.delete(tell);
    };
  }, []);

  useEffect(() => watchHowThePhoneIsHeld(setHeld), []);

  useEffect(() => {
    const on = (e: FocusEvent) => setTyping(typingInto(e.target as Element | null));
    // THE ELEMENT FOCUS IS GOING TO, not "nothing". Tabbing from one box to the next fires focusout
    // and then focusin as two separate events, so reading this as a plain "stopped typing" would turn
    // the screen between two keystrokes and turn it back — a flash in the middle of filling a row in.
    // `relatedTarget` is where focus is landing, and is null when it is landing nowhere.
    const off = (e: FocusEvent) => setTyping(typingInto(e.relatedTarget as Element | null));
    window.addEventListener("focusin", on);
    window.addEventListener("focusout", off);
    return () => {
      window.removeEventListener("focusin", on);
      window.removeEventListener("focusout", off);
    };
  }, []);

  useEffect(() => {
    const now = whichWayToDraw({ pathname, layers, held, typing });
    if (wrote.current === now) return;
    wrote.current = now;
    const root = document.documentElement;
    if (isTurned(now)) {
      // ONE number, from lib/turned-geometry.ts, read by the stylesheet rule that paints every square
      // chrome control's face. The attribute is what that rule keys on.
      root.style.setProperty("--turn-deg", uprightTurn(now));
      root.dataset.phoneHeld = now;
    } else {
      delete root.dataset.phoneHeld;
      root.style.removeProperty("--turn-deg");
    }
    publish({ held: now, bottomChrome: isTurned(now) ? measureTheDock() : 0 });
    // THE DOCUMENT PREVIEW REDRAWS ON THIS. A drawn PDF page is a bitmap and does not re-flow, and
    // with the interface locked the window never resizes when the phone turns, so `resize` and
    // `orientationchange` — the two the viewer used to listen on — never fire. This is the event that
    // says "the room changed" now.
    window.dispatchEvent(new Event("cn:screen-turned"));
  }, [pathname, layers, held, typing]);

  return null;
}
