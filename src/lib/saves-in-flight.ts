"use client";

import { useLayoutEffect } from "react";

/**
 * SAVES STILL ON THEIR WAY, AS ONE COUNT A PAGE CAN ASK (cn-v1157).
 *
 * The estimate and the invoice save themselves as a person leaves a box (NOT-annoying: no save game),
 * and Preview now stands in the header beside Send — one tap from the box. A tap on Preview blurs the
 * box, the box's save goes out, and the link left in the same instant: the PDF was then drawn from
 * whatever the server held when its own request arrived, which on a slow connection is the document
 * WITHOUT the change just typed. Nothing failed and nothing said so; the paper was simply one edit
 * old — the kind of thing that makes a person stop trusting a preview.
 *
 * So a page that saves on its own says when a save is out (useSaveInFlight, fed by the flag it
 * already keeps), and a door that shows what the server holds asks first (savesInFlight) and waits
 * for the quiet (whenSavesSettle). One count for the whole window: the saver and the door need not
 * know each other, which is what lets the header's button (drawn by the server page) wait for a box
 * inside a client editor further down.
 *
 * The count is the window's, not a record's: a tab shows one document. It is never persisted, never
 * sent, and a reload starts it at zero.
 */
let count = 0;
const listeners = new Set<() => void>();
const tell = () => {
  for (const l of [...listeners]) l();
};

/** A save has gone out. Call what this returns when it lands, either way; calling it twice counts once. */
export function beginSave(): () => void {
  count += 1;
  tell();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    count = Math.max(0, count - 1);
    tell();
  };
}

/** How many saves are on their way right now. Read at the moment of a tap, never from a render. */
export const savesInFlight = (): number => count;

export function subscribeSaves(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How long nothing must be on its way before the page counts as saved. A write queued behind
 *  another goes out a moment after the first lands; that gap is not quiet. */
export const SAVES_QUIET_MS = 150;
/** How long a door waits for the quiet before it gives up and SAYS so (never a stale paper, never a
 *  button stuck on Saving…). The editors' own write timeout is 20 s; a save that slow has its own words. */
export const SAVES_WAIT_CAP_MS = 12_000;

/**
 * Resolves true once nothing has been on its way for `quietMs` in a row, or false when `capMs`
 * passes first. With nothing in flight it still waits the one quiet beat, so a save that starts in
 * the same instant is seen.
 */
export function whenSavesSettle(quietMs: number = SAVES_QUIET_MS, capMs: number = SAVES_WAIT_CAP_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let over = false;
    const finish = (settled: boolean) => {
      if (over) return;
      over = true;
      if (quiet) clearTimeout(quiet);
      clearTimeout(cap);
      off();
      resolve(settled);
    };
    const check = () => {
      if (quiet) {
        clearTimeout(quiet);
        quiet = null;
      }
      if (count === 0) quiet = setTimeout(() => finish(true), quietMs);
    };
    const off = subscribeSaves(check);
    const cap = setTimeout(() => finish(false), capMs);
    check();
  });
}

/**
 * A component's own "a save is out" flag, counted while it is true (the estimate editor's write on
 * the wire, the invoice's transition and its description save). The flag turns true inside the blur
 * that starts the save; that update renders at once (it comes from a tap), and a LAYOUT effect runs
 * inside that same commit — so the count is already up when the click that follows the blur arrives.
 * A passive effect would usually be in time too; this does not lean on "usually". Unmounting lets go.
 */
export function useSaveInFlight(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    return beginSave();
  }, [active]);
}
