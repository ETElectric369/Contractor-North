"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (installable + offline) and — crucially — reloads
 * the page once when a freshly-deployed service worker takes over, so an open
 * app (desktop tab or installed PWA) never keeps running stale code after a
 * deploy. It also polls for updates on an interval and on window focus so a new
 * build is picked up promptly.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const hadController = !!navigator.serviceWorker.controller;
    let sawFirstClaim = false;
    let refreshing = false;
    const onControllerChange = () => {
      // On a fresh, uncontrolled first load the very first controllerchange is
      // just the SW claiming this page — not an update. Skip that one only.
      if (!hadController && !sawFirstClaim) {
        sawFirstClaim = true;
        return;
      }
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    let interval: ReturnType<typeof setInterval> | undefined;
    let onFocus: (() => void) | undefined;
    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          const check = () => {
            reg.update().catch(() => {});
          };
          interval = setInterval(check, 60_000);
          onFocus = check;
          window.addEventListener("focus", onFocus);
        })
        .catch(() => {
          /* registration is best-effort; the app works fine without it */
        });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("load", onLoad);
      if (interval) clearInterval(interval);
      if (onFocus) window.removeEventListener("focus", onFocus);
    };
  }, []);
  return null;
}
