"use client";

import { isNativeShell } from "@/lib/native-shell";

/**
 * APNs registration, from the web app running inside the native shell (2026-09-09).
 *
 * The UI is served from app.contractornorth.com, not bundled — but Capacitor injects its bridge
 * into the WebView for whatever page it loads (that is how live-reload works), so
 * `window.Capacitor.Plugins.PushNotifications` is there. The plugin package is imported
 * DYNAMICALLY so its module never enters the browser/PWA bundle's critical path, and every entry
 * point below no-ops off-shell rather than throwing "not implemented".
 */

type PushPlugin = {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: string, cb: (data: any) => void): Promise<{ remove: () => Promise<void> }>;
  removeAllListeners(): Promise<void>;
};

/**
 * THE PLUGIN, FROM THE BRIDGE — NOT FROM A DYNAMIC IMPORT (2026-09-09).
 *
 * This used to `await import("@capacitor/push-notifications")`. On the phone that import HUNG:
 * never resolved, never rejected, so Enable sat forever and then timed out at stage "starting".
 * The package is still a dependency — the iOS project resolves its Swift target out of
 * node_modules — but importing it in the BROWSER bundle was always pointless here: the UI is
 * served over the network into a WKWebView, and all the JS package does is forward to the bridge
 * Capacitor already injected at `window.Capacitor.Plugins`. So read the bridge directly.
 *
 * It's also a better failure mode. No chunk to fetch means nothing to hang, and a build without
 * the native plugin simply has no `PushNotifications` key — which returns null immediately and
 * says so, instead of stalling.
 */
function plugin(): PushPlugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const p = cap?.Plugins?.PushNotifications;
  return (p as PushPlugin | undefined) ?? null;
}

/** Has this phone already been asked, and what did it say? */
export async function nativePushPermission(): Promise<"granted" | "denied" | "prompt" | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const r = await p.checkPermissions();
    return r.receive === "granted" ? "granted" : r.receive === "denied" ? "denied" : "prompt";
  } catch {
    return null;
  }
}

/**
 * Ask the OS, then register with APNs and hand the token back.
 *
 * `register()` resolves as soon as the request is made, NOT when the token arrives — the token
 * comes back through the `registration` listener, so the promise below is settled by whichever
 * happens first: the token, an error, or a timeout. Without the timeout a phone in airplane mode
 * leaves the Enable button spinning forever with nothing said, which is the dead end the
 * NOT-ANNOYING rule exists to prevent.
 */
export function registerForNativePush(): Promise<
  { ok: true; token: string } | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    let settled = false;
    // WHERE it got stuck, so a hang names itself instead of spinning forever.
    let stage = "starting";
    const finish = (r: { ok: true; token: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    // ARM THE TIMEOUT FIRST — before anything that can hang (2026-09-09: the first cut set it
    // AFTER `await register()`, so when that call never came back the timer was never created,
    // the promise never settled, and the Enable button sat on "…" forever with nothing said.
    // Any await below can hang: a bridge call into a plugin the running build doesn't have
    // simply never answers. The rescue has to exist before the risk does.
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: `Notifications didn't finish turning on (stuck at: ${stage}). If this app was just updated, fully close it and reopen, then try again.`,
        }),
      15_000,
    );

    void (async () => {
      try {
        const p = plugin();
        if (!p) {
          return finish({ ok: false, error: "Notifications aren't available in this app build." });
        }
        stage = "checking permission";
        let perm = await p.checkPermissions();
        if (perm.receive !== "granted") {
          stage = "asking permission";
          perm = await p.requestPermissions();
        }
        if (perm.receive !== "granted") {
          return finish({
            ok: false,
            error: "Notifications are turned off for North. Turn them on in iPhone Settings → North → Notifications.",
          });
        }
        stage = "waiting for Apple";
        await p.addListener("registration", (t: { value: string }) => {
          if (t?.value) finish({ ok: true, token: t.value });
        });
        await p.addListener("registrationError", (e: { error?: string }) =>
          finish({ ok: false, error: e?.error || "iOS wouldn't register this phone for notifications." }),
        );
        await p.register();
      } catch (e) {
        finish({ ok: false, error: e instanceof Error ? e.message : "Couldn't turn notifications on." });
      }
    })();
  });
}

/**
 * Tapping a notification should open the thing it is ABOUT. The APNs payload carries the same
 * `url` the Web Push service worker reads, so both transports land on the same screen.
 * Returns a teardown so the mounting component can clean up.
 */
export async function onNativePushTap(go: (url: string) => void): Promise<() => void> {
  const p = plugin();
  if (!p) return () => {};
  try {
    const sub = await p.addListener("pushNotificationActionPerformed", (a: any) => {
      const url = a?.notification?.data?.url;
      // Only ever navigate INSIDE the app: the payload is data from the network, and a bare
      // href from it would let a malformed push send the crew to another origin.
      if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) go(url);
    });
    return () => void sub.remove();
  } catch {
    return () => {};
  }
}
