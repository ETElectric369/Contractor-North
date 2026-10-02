"use client";

import { isNativeShell } from "@/lib/native-shell";
import { type Held } from "@/lib/turned-geometry";

/**
 * WHICH WAY THE PHONE IS BEING HELD — REPORTED, not permitted.
 *
 * Erik, 2026-10-01: "On the app rotation is it possible to lock the top bar and the dock positions
 * and just rotate the buttons while the internal screen rotates?"
 *
 * THIS FILE CHANGED JOBS. It used to ask the shell to UNLOCK the interface so iOS would rotate the
 * whole view — and iOS rotating the whole view is exactly what carried the top bar and the dock
 * around with it, which is the thing he reported. The shell is portrait-locked on the iPhone again
 * (Info.plist), and the native side's job now is to TELL the page which way the device is physically
 * held. iOS reports the DEVICE's orientation (UIDevice.orientation / the device-orientation
 * notification) even while the INTERFACE is locked to portrait, so there is no question of whether a
 * web page can detect a turn from behind a lock: it does not have to, the shell says.
 *
 * ONE CHANNEL, THE ONE THE SHELL ALREADY USES. ScreenTurnPlugin.swift evaluates
 * `window.dispatchEvent(new CustomEvent("cn:phone-held", { detail: { held } }))`, the same way
 * NavigationFailureRelay tells the page a navigation failed. A plain window event, so a build
 * without the plugin simply never fires one and this reports "upright" forever — which is what every
 * browser gets too, and is the right answer there (a browser tab rotates natively and always did).
 *
 * THE BRIDGE, NEVER AN IMPORT (the native-push.ts / native-tap.ts lesson): on the phone an
 * `await import()` of a Capacitor package HUNG. There is no package for this one — ScreenTurn is a
 * local plugin compiled into the shell — so a missing key means an older build and this returns
 * straight away instead of stalling.
 *
 * AN UNKNOWN WORD MEANS UPRIGHT. The old rule was "an unknown answer LOCKS"; this is the same rule
 * in the new shape — nothing we cannot read is ever treated as a turn, so the worst a bad message
 * can do is leave the screen exactly as it is today.
 */

/** The event the shell fires. One name, used by the plugin and by the watcher below. */
export const HELD_EVENT = "cn:phone-held";

/** Who actually answered. Reported, never guessed at a call site. */
export type HeldReporter = "shell" | "nobody";

/** The one reader of a word off the wire. Anything that is not a turn we recognise is upright. */
export function heldFromWord(word: unknown): Held {
  return word === "clockwise" || word === "counterclockwise" ? word : "upright";
}

type ScreenTurnPlugin = { read?(): Promise<{ held?: unknown }> };

function plugin(): ScreenTurnPlugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const p = cap?.Plugins?.ScreenTurn;
  return (p as ScreenTurnPlugin | undefined) ?? null;
}

/**
 * WATCH HOW THE PHONE IS HELD. Calls back with every change, and once at the start with whatever the
 * phone is doing RIGHT NOW — which is what makes a hard reload while already turned land on the
 * turned layout instead of waiting for the person to turn the phone again.
 *
 * Returns the teardown. Never throws: a screen that cannot know which way the phone is held has to
 * keep working exactly as it does today.
 */
export function watchHowThePhoneIsHeld(onHeld: (held: Held) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ held?: unknown }>).detail;
    onHeld(heldFromWord(detail?.held));
  };
  window.addEventListener(HELD_EVENT, listener);
  // ASK ONCE, for the state that already happened before this mounted. An old shell has no `read`,
  // a browser has no plugin at all; both leave the answer at upright without a word.
  let live = true;
  const p = plugin();
  if (p && typeof p.read === "function") {
    Promise.resolve()
      .then(() => p.read!())
      .then((r) => {
        if (live) onHeld(heldFromWord(r?.held));
      })
      .catch(() => {
        /* an old build, or a bridge call that failed: upright, quietly */
      });
  }
  return () => {
    live = false;
    window.removeEventListener(HELD_EVENT, listener);
  };
}

/** Who is going to be answering on this device. For a report, and for the one test that pins it. */
export function whoReportsTheTurn(): HeldReporter {
  const p = plugin();
  return p && typeof p.read === "function" ? "shell" : "nobody";
}
