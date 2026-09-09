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

async function plugin(): Promise<PushPlugin | null> {
  if (!isNativeShell()) return null;
  try {
    const mod = await import("@capacitor/push-notifications");
    return mod.PushNotifications as unknown as PushPlugin;
  } catch {
    return null; // an older shell without the plugin — the caller degrades to "not available"
  }
}

/** Has this phone already been asked, and what did it say? */
export async function nativePushPermission(): Promise<"granted" | "denied" | "prompt" | null> {
  const p = await plugin();
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
  return new Promise(async (resolve) => {
    const p = await plugin();
    if (!p) return resolve({ ok: false, error: "Notifications aren't available in this app build." });
    let settled = false;
    const finish = (r: { ok: true; token: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      let perm = await p.checkPermissions();
      if (perm.receive !== "granted") perm = await p.requestPermissions();
      if (perm.receive !== "granted") {
        return finish({
          ok: false,
          error: "Notifications are turned off for North. Turn them on in iPhone Settings → North → Notifications.",
        });
      }
      await p.addListener("registration", (t: { value: string }) => {
        if (t?.value) finish({ ok: true, token: t.value });
      });
      await p.addListener("registrationError", (e: { error?: string }) =>
        finish({ ok: false, error: e?.error || "iOS wouldn't register this phone for notifications." }),
      );
      await p.register();
      setTimeout(
        () => finish({ ok: false, error: "Apple didn't answer — check your connection and try again." }),
        15_000,
      );
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : "Couldn't turn notifications on." });
    }
  });
}

/**
 * Tapping a notification should open the thing it is ABOUT. The APNs payload carries the same
 * `url` the Web Push service worker reads, so both transports land on the same screen.
 * Returns a teardown so the mounting component can clean up.
 */
export async function onNativePushTap(go: (url: string) => void): Promise<() => void> {
  const p = await plugin();
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
