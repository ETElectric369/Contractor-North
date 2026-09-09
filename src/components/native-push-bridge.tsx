"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isNativeShell } from "@/lib/native-shell";
import { nativePushPermission, registerForNativePush, onNativePushTap } from "@/lib/native-push";
import { saveDeviceToken } from "@/app/(app)/settings/push-actions";

/**
 * The native shell's two push jobs, mounted once in the app shell (2026-09-09).
 *
 * 1. A TAP OPENS THE THING IT IS ABOUT. The APNs payload carries the same `url` the Web Push
 *    service worker reads, so both transports land on the same screen.
 *
 * 2. THE TOKEN STAYS FRESH. APNs re-issues a device token after a reinstall, a restore, or
 *    sometimes an OS update, and the old one starts failing silently — the crew would simply
 *    stop getting alerts with nothing to see. Re-registering on launch costs one round trip and
 *    keeps the row current (saveDeviceToken replaces by token, so this can't pile up rows).
 *
 *    ONLY when permission is ALREADY granted: register() would otherwise raise the system
 *    prompt, and a permission dialog nobody asked for on app open is the fastest way to get a
 *    permanent "Don't Allow" — the one answer iOS gives no second chance at.
 *
 * Renders nothing, and no-ops entirely outside the shell.
 */
export function NativePushBridge() {
  const router = useRouter();

  useEffect(() => {
    if (!isNativeShell()) return;
    let teardown = () => {};
    let live = true;

    onNativePushTap((url) => router.push(url)).then((off) => {
      if (live) teardown = off;
      else off();
    });

    nativePushPermission().then(async (perm) => {
      if (!live || perm !== "granted") return;
      const r = await registerForNativePush();
      if (live && r.ok) await saveDeviceToken(r.token, navigator.userAgent);
    });

    return () => {
      live = false;
      teardown();
    };
  }, [router]);

  return null;
}
