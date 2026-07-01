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

    // A deploy reload must never eat what the user is typing. If a modal is up
    // (`modal-open` on <body> — every overlay sets it via modal-lock) or any
    // field has focus, HOLD the reload and retry on a short interval — it then
    // fires the moment the user is between screens instead of mid-form. The
    // typed content itself is also draft-persisted (useDraft), but not every
    // form is wired, so the gate is the first line of defense.
    const midTyping = () => {
      if (document.body.classList.contains("modal-open")) return true;
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      return (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      );
    };
    let deferredReload: ReturnType<typeof setInterval> | undefined;
    const reloadWhenSafe = () => {
      if (!midTyping()) {
        window.location.reload();
        return;
      }
      deferredReload = setInterval(() => {
        if (midTyping()) return;
        clearInterval(deferredReload);
        window.location.reload();
      }, 3000);
    };

    const onControllerChange = () => {
      // On a fresh, uncontrolled first load the very first controllerchange is
      // just the SW claiming this page — not an update. Skip that one only.
      if (!hadController && !sawFirstClaim) {
        sawFirstClaim = true;
        return;
      }
      if (refreshing) return;
      refreshing = true;
      reloadWhenSafe();
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
          // Check for a freshly-deployed build IMMEDIATELY on load (not only
          // after 60s / on focus) — so reopening the PWA after a deploy picks up
          // the new service worker right away instead of running stale code.
          check();
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
      if (deferredReload) clearInterval(deferredReload);
    };
  }, []);
  return null;
}
