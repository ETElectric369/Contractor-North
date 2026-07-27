"use client";

import { useEffect } from "react";

/**
 * CLEAR THE OFFLINE PAGE CACHE WHEN NOBODY IS SIGNED IN.
 *
 * The service worker keeps every page you visited so a dead zone shows the real page instead of
 * the offline screen. Those pages are rendered HTML — one org's customers, jobs, and money — so
 * they must not outlive the session. Sign-out is a server action and can't talk to the service
 * worker, but every sign-out lands on /login, so mounting this here is the reliable hook.
 *
 * It also covers the case that actually worries me: a crew phone handed to someone else. They open
 * the app, see the login screen, and there is nothing cached to page back into.
 *
 * Static assets are impersonal and deliberately survive — that's what keeps the login screen
 * itself loading instantly on a bad connection.
 */
export function PurgePageCache() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ type: "purge-pages" }))
      .catch(() => {
        /* best-effort: no service worker means no cached pages to purge */
      });
  }, []);
  return null;
}
