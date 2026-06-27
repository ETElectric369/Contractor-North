"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/** Keeps a server-rendered page current without a manual reload. When the tab/app becomes
 *  visible again — e.g. you pull your phone out and reopen the PWA — it refetches the RSC so
 *  anything scheduled elsewhere (a new job on My Day, a moved appointment) shows up immediately
 *  instead of sitting stale until you happen to navigate. Throttled so rapid focus toggles
 *  don't hammer the server. Mount once on a page that should always be current. */
export function RefreshOnVisible({ minIntervalMs = 12000 }: { minIntervalMs?: number }) {
  const router = useRouter();
  const last = useRef(0);

  useEffect(() => {
    // Don't fire on the initial mount (the page is already fresh); arm from now.
    last.current = Date.now();
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last.current < minIntervalMs) return;
      last.current = now;
      router.refresh();
    };
    document.addEventListener("visibilitychange", maybeRefresh);
    window.addEventListener("focus", maybeRefresh);
    return () => {
      document.removeEventListener("visibilitychange", maybeRefresh);
      window.removeEventListener("focus", maybeRefresh);
    };
  }, [router, minIntervalMs]);

  return null;
}
