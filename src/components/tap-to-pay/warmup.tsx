"use client";

import { useEffect, useRef } from "react";
import { isNativeShell } from "@/lib/native-shell";
import { prepareTapToPay, tapToPayPluginPresent } from "@/lib/native-tap";
import { tapToPayContext } from "@/app/(app)/billing/tap-actions";

/**
 * THE WARM-UP MOUNT for Tap to Pay on iPhone (2026-09-11) — Apple 1.5 / 5.6: the reader is
 * prepared at launch and again every time the app comes back to the foreground, so that when a
 * customer is standing there the Tap to Pay on iPhone screen is up within a second instead of
 * after a connect. Stripe's own advice, word for word: connect in the background at startup and
 * lean on automatic reconnection on foreground; the reader always drops when the app backgrounds.
 *
 * Mounted once in the app shell beside the other shell-only bridges; renders nothing; no-ops off
 * the iOS shell. Nothing here can throw at React: prepareTapToPay never rejects, and the server
 * action is caught, because a warm-up is a courtesy — a failed one costs a slower first tap,
 * never a broken screen.
 *
 * NEVER AN UNINVITED TERMS SHEET (Apple 3.8) — AND THAT PROMISE IS THE BRIDGE'S, NOT THIS
 * FILE'S. The SDK raises Apple's terms inside the first connect for an unlinked account, to
 * whoever is holding the phone. prepareTapToPay connects with the terms refused: Apple says
 * "not linked" and it stops; Apple CAN'T say (an older shell build, iOS < 16.4, no answer in
 * time) and it stops too, unless the caller vouched with canEnable — which this mount never
 * passes, so an unattended warm-up cannot present the sheet whatever the phone answers. That
 * read is Apple's, fresh on every connect (1.6), and it happens inside the bridge; there is no
 * point paying for it twice, so this file no longer asks first.
 *
 * What IS here is a cheap skip. organizations.stripe_terminal_location_id is minted only when
 * someone pressed a Tap to Pay on iPhone door on this company (Enable in Settings, or a Pay Now
 * tap) — no location means nobody ever has, so there is nothing to warm and no SDK turn is
 * spent finding that out. A shortcut, not a gate: a company WITH a location still meets the
 * bridge's own refusal. The column says nothing about whether the terms are accepted; it is
 * not a stored answer to Apple's question, only a reason not to ask it.
 */

/** Two foregrounds inside half a minute are one warm-up; the bridge's own memos throttle the rest. */
const DEBOUNCE_MS = 30_000;
/** Launch waits a beat so the first paint and the push bridge go first — still "at launch". */
const LAUNCH_DELAY_MS = 1_000;

/** A timer that exists before the call it rescues; resolves `onTimeout` instead of hanging. */
function withTimeout<T>(ms: number, onTimeout: T, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(onTimeout);
    }, ms);
    run().then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

export function TapToPayWarmup() {
  const lastRun = useRef(0);
  const running = useRef(false);

  useEffect(() => {
    if (!isNativeShell() || !tapToPayPluginPresent()) return;
    let live = true;

    const warm = async () => {
      if (!live || running.current) return;
      // The reader is not reachable from the background (the SDK says so, loudly).
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRun.current < DEBOUNCE_MS) return;
      lastRun.current = now;
      running.current = true;
      try {
        // The company's side: can it take cards, and has anyone ever opened this door. Staff-only
        // on the server, so a tech's shell gets ok:false here and spends no SDK turn at all.
        const ctx = await withTimeout(10_000, null, () => tapToPayContext());
        if (!live || !ctx || !ctx.ok || !ctx.canAccept) return;
        // The cheap skip (see the header): no location, nobody has ever enabled it — nothing to warm.
        if (ctx.locationId === null) return;
        // The cheap no-op when the reader is already there; refuses (never presents) unless Apple
        // confirms the terms; memoises its own failures so a bad morning isn't retried in a loop.
        await prepareTapToPay();
      } catch {
        /* a server action that threw is not the reader's problem — the next foreground tries again */
      } finally {
        running.current = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void warm();
    };
    const t = setTimeout(() => void warm(), LAUNCH_DELAY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      live = false;
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return null;
}
