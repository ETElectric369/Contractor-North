"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/** Keeps a server-rendered page current across devices — without realtime infra:
 *  - refetches when the tab/app becomes VISIBLE again (you reopen the PWA / return to the tab), and
 *  - while visible, POLLS every `pollMs` so a change made on ANOTHER device (you schedule from the
 *    laptop while Brian's phone sits open on My Day) shows up within ~`pollMs`, even if this screen
 *    never left.
 *  A backgrounded tab doesn't poll — the visibility refetch covers the return, which keeps it cheap.
 *  `minIntervalMs` throttles so rapid focus toggles don't hammer the server. Mount once per page. */
export function RefreshOnVisible({
  pollMs = 45000,
  minIntervalMs = 12000,
}: {
  pollMs?: number;
  minIntervalMs?: number;
}) {
  const router = useRouter();
  const last = useRef(0);

  useEffect(() => {
    last.current = Date.now(); // arm from mount — the page is already fresh
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last.current < minIntervalMs) return;
      last.current = now;
      router.refresh();
    };
    document.addEventListener("visibilitychange", maybeRefresh);
    window.addEventListener("focus", maybeRefresh);
    const poll = setInterval(maybeRefresh, pollMs);
    return () => {
      document.removeEventListener("visibilitychange", maybeRefresh);
      window.removeEventListener("focus", maybeRefresh);
      clearInterval(poll);
    };
  }, [router, pollMs, minIntervalMs]);

  return null;
}
