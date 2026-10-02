"use client";

import { isNativeShell } from "@/lib/native-shell";

/**
 * MAY THIS SCREEN BE TURNED SIDEWAYS? One answer, asked per screen.
 *
 * Erik, 2026-10-01, from /schedule: "I'd like to be able to turn the phone sideways to see the
 * calendar in full, but it would be nice to also keep the buttons for the top bar and the dock
 * exactly where they are while spinning everything in between only."
 *
 * PORTRAIT EVERYWHERE, SIDEWAYS WHERE IT HELPS. Unlocking the app would hand every screen about
 * 400pt of height to work in, which is a surface nobody has drawn for (see the note in
 * timecards/timecard-stack.tsx). So the shell allows sideways at all, and the WEB APP says, screen
 * by screen, which ones can use the width. WHICH ONES IS NOT DECIDED HERE: this file only carries
 * the answer to the phone. The list — and the reason each screen is on it — lives in
 * lib/screens-that-turn.ts, and components/turns-sideways.tsx is the one thing that calls this.
 *
 * THREE PLACES CAN SAY NO, and this file tells them apart so the report can be honest:
 *  - "shell"   — the App Store app. The native side decides (ScreenTurnPlugin.swift), and it can
 *                also turn the phone BACK when a screen stops allowing sideways. Needs the rebuilt
 *                shell: the orientation list is in Info.plist, which is compiled into the app.
 *  - "browser" — a browser with the Screen Orientation API (Android Chrome). lock()/unlock() do the
 *                same job, one screen at a time — but only where the page is allowed to lock at
 *                all, which in practice means installed or full screen.
 *  - "no"      — nobody could be asked. The common case, and a quiet one: iOS Safari has no Screen
 *                Orientation API at all, and an ordinary mobile browser TAB cannot lock. There the
 *                phone turns on every screen, as it already does today, and the `turned:` rules in
 *                globals.css are what keep the top bar and the dock where they are when it does.
 *
 * THE PLUGIN COMES FROM THE BRIDGE, NEVER FROM AN IMPORT (the native-push.ts / native-tap.ts
 * lesson): on the phone an `await import()` of a Capacitor package HUNG. There is no package here
 * anyway — ScreenTurn is a local plugin in the shell — so a missing key simply means a build that
 * doesn't have it, and this returns null straight away instead of stalling.
 */

export type Turn = "sideways" | "portrait";

/** Who actually answered. Reported, never guessed at a call site. */
export type TurnAnswer = "shell" | "browser" | "no";

type ScreenTurnPlugin = { allow(o: { turn: Turn }): Promise<{ turn: string }> };

function plugin(): ScreenTurnPlugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const p = cap?.Plugins?.ScreenTurn;
  return (p as ScreenTurnPlugin | undefined) ?? null;
}

/**
 * The browser half. `screen.orientation` is absent on iOS, and `lock()` rejects in plenty of
 * ordinary situations (not installed, not fullscreen, a desktop) — none of which is worth a word to
 * anyone, so every one of them is swallowed and reported as "nobody could be asked".
 *
 * Deliberately NOT a fallback that fights the native one: inside the shell the plugin answers and
 * this is never reached.
 */
type WebOrientation = {
  lock?: (o: string) => Promise<void> | void;
  unlock?: () => void;
};

function webOrientation(): WebOrientation | null {
  if (typeof screen === "undefined") return null;
  // ONLY WHERE A LOCK IS ALLOWED AT ALL. The Screen Orientation API refuses to lock a plain browser
  // TAB — it wants the page installed or full screen — so asking from one is a rejected promise on
  // every single page load, including every visit to a company's public site. That is noise, not a
  // fallback: a tab turns on every screen already, and the `turned:` rules in globals.css are what
  // keep the chrome put when it does. A build with no matchMedia at all (a test, a server) is asked
  // nothing and answers "no".
  const installed =
    typeof matchMedia === "function" &&
    ["standalone", "fullscreen", "minimal-ui"].some((mode) => {
      try {
        return matchMedia(`(display-mode: ${mode})`).matches;
      } catch {
        return false;
      }
    });
  if (!installed) return null;
  const o = (screen as unknown as { orientation?: WebOrientation }).orientation;
  return o && (typeof o.lock === "function" || typeof o.unlock === "function") ? o : null;
}

/**
 * Say whether the screen now on the phone can be used sideways. Resolves with WHO answered, so a
 * caller (and a report) can tell "the shell turned it on" from "there was nobody to ask".
 *
 * Never throws and never rejects: an orientation is a convenience, and a screen that cannot be
 * rotated has to keep working exactly as it does today.
 */
export async function letTheScreenTurn(turn: Turn): Promise<TurnAnswer> {
  const p = plugin();
  if (p) {
    try {
      await p.allow({ turn });
      return "shell";
    } catch {
      // The shell is here but the call failed (an old build without the plugin answers this way
      // too). Fall through: the browser API is absent inside the WKWebView, so this lands on "no".
    }
  }
  const o = webOrientation();
  if (!o) return "no";
  try {
    if (turn === "sideways") {
      o.unlock?.();
      return "browser";
    }
    const r = o.lock?.("portrait");
    // lock() returns a promise in Chrome and nothing in older implementations.
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
    return "browser";
  } catch {
    return "no";
  }
}
