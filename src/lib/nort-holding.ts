"use client";

import { useEffect, useState } from "react";
import { NO_HOLDING, type NortHolding } from "@/lib/nort/greeting";

/**
 * WHAT NORT IS HOLDING, on this phone, right now — fed by the Bell's own poll (getMyBell returns
 * it beside the unread count, so it costs no second read), read by the top bar's Nort button (the
 * red pulsing ring) and by the greeting (which names it). One store, so the ring and the words
 * can never disagree.
 */
let holding: NortHolding = NO_HOLDING;
const subs = new Set<() => void>();

export function setNortHolding(h: NortHolding | null | undefined): void {
  holding = h ?? NO_HOLDING;
  subs.forEach((cb) => cb());
}
export function getNortHolding(): NortHolding {
  return holding;
}
function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
/** useState + useEffect, not useSyncExternalStore: the top bar is also CALLED as a plain function
 *  in its tests with those two stubbed (topbar.test.ts), and the first render on either side is the
 *  empty hand, so server and client agree until the Bell's poll lands. */
export function useNortHolding(): NortHolding {
  const [h, setH] = useState<NortHolding>(getNortHolding);
  useEffect(() => {
    setH(getNortHolding());
    return subscribe(() => setH(getNortHolding()));
  }, []);
  return h;
}

/** The greeting that just played NAMED what Nort holds and asked "want them now?" — the chat's
 *  first message after it says so to the server (body.greeted), so the model answers the yes or
 *  the later instead of asking again. Consumed by the first send. */
let greeted = false;
export function markGreetedWithHolding(): void {
  greeted = true;
}
export function consumeGreeted(): boolean {
  const g = greeted;
  greeted = false;
  return g;
}
