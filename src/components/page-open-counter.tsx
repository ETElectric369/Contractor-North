"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { pagePattern } from "@/lib/page-pattern";

/**
 * THE PAGE-OPEN COUNTER (0353). One call per navigation: the route with its ids taken out
 * (lib/page-pattern), counted for the signed-in person's company by bump_page_open. No user id
 * goes with it and none is stored.
 *
 * Mounted once in the (app) layout, beside SectionSubnav, not in ShellNavigationWatch: that one
 * returns early outside the iOS shell, and the office's desktop opens count too. A job-tab switch
 * is a navigation here (UrlSyncedTabs writes ?tab= through the router).
 *
 * It is telemetry: a failed count is ignored, never shown, never retried, and nothing here throws.
 */
export function PageOpenCounter() {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const last = useRef<string | null>(null);

  useEffect(() => {
    const key = `${pathname}?${tab ?? ""}`;
    if (key === last.current) return; // the same URL again (a dev double effect), not an open
    last.current = key;
    const page = pagePattern(pathname, tab);
    if (!page) return;
    try {
      void createClient()
        .rpc("bump_page_open", { p_page: page })
        .then(
          () => undefined,
          () => undefined,
        );
    } catch {
      /* telemetry never breaks a page */
    }
  }, [pathname, tab]);

  return null;
}
