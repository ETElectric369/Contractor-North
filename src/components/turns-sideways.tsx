"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { letTheScreenTurn, type Turn } from "@/lib/native-orientation";
import { mayTurnSideways, type ScreenThatTurns } from "@/lib/screens-that-turn";

/**
 * THE ONE THING THAT TELLS THE PHONE WHICH WAY IT MAY BE HELD.
 *
 * Mounted ONCE, in the ROOT layout, beside <BackLinkTracker /> — so it never unmounts, it sees every
 * route including /print/*, and no screen has to remember to do anything. What may turn is declared
 * in lib/screens-that-turn.ts and nowhere else; everything not named there is portrait.
 *
 * ONE WRITER, which is the whole reason this is a watcher and not a per-screen call. A full-screen
 * document viewer can open ON TOP of a screen that already turns (a receipt opened from the
 * schedule): if the viewer asked for portrait on its own way out, it would lock the screen
 * underneath that was allowed to be sideways. So a layer REGISTERS itself here and this effect works
 * out the one answer — route, plus anything open over it.
 *
 * EVERY WAY OF ARRIVING AND LEAVING lands on this effect:
 *  - deep link straight onto a turning screen, or a hard reload on one → the first run, on mount
 *  - walking off it, the back gesture, a tab switch → pathname changes
 *  - opening or closing a document over it → `layers` changes
 *  - turning the phone while standing still → nothing to do; the shell already allows it
 * and "leaving returns to portrait" is the native half: asking for portrait also turns the phone
 * back (ScreenTurnPlugin.swift), so walking off sideways never strands anyone on a portrait screen
 * squeezed into 400pt of height.
 *
 * It draws nothing, and nothing it does has to succeed — see lib/native-orientation.ts for the three
 * places that can answer and the one rule that beats them all: an unknown answer LOCKS.
 */

/**
 * The full-screen layers open right now, innermost last. An ARRAY, not a flag: two viewers can be
 * open at once (a lightbox over a lightbox), and the one that closes first must not take the other
 * one's permission with it.
 */
const openLayers: ScreenThatTurns[] = [];
const watchers = new Set<() => void>();

/**
 * A FULL-SCREEN LAYER SAYS IT MAY BE TURNED SIDEWAYS. For a viewer that covers the screen instead of
 * being a route of its own — today the photo/PDF lightbox. The name must be one declared in
 * screens-that-turn.ts with a reason, so a layer cannot slip in without one either.
 */
export function useTurnsSidewaysLayer(screen: ScreenThatTurns) {
  useEffect(() => {
    openLayers.push(screen);
    for (const w of watchers) w();
    return () => {
      const at = openLayers.lastIndexOf(screen);
      if (at >= 0) openLayers.splice(at, 1);
      for (const w of watchers) w();
    };
  }, [screen]);
}

export function TurnsSideways() {
  const pathname = usePathname();
  const [layers, setLayers] = useState(0);
  // The turn we last ASKED for. Without it every ordinary navigation between two portrait screens
  // would ask the shell to turn the phone upright again — a bridge call, and an instant where iOS is
  // being told to do something it is already doing. Null on the first run, so mounting always says
  // something: after a reload the native side's answer is whatever the last screen left it as.
  const asked = useRef<Turn | null>(null);

  useEffect(() => {
    const tell = () => setLayers(openLayers.length);
    watchers.add(tell);
    // A layer that mounted before this watcher did (it can't today — this is in the root layout —
    // but a count read once at mount is cheaper than a rule nobody can see).
    tell();
    return () => {
      watchers.delete(tell);
    };
  }, []);

  useEffect(() => {
    const turn: Turn = mayTurnSideways(pathname, layers) ? "sideways" : "portrait";
    if (asked.current === turn) return;
    asked.current = turn;
    void letTheScreenTurn(turn);
  }, [pathname, layers]);

  return null;
}
