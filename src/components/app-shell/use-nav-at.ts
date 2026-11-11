"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { awaitsHome, navDrawnAt, type DockSection, type NavAt } from "@/lib/dock";
import { useDeclaredNavHome } from "@/components/nav-home";

/**
 * THE LOCATION THE SHELL'S NAV IS DRAWN FOR — one hook for the dock (rail, phone bar, page column)
 * and the section strip, so the two can never light different places.
 *
 * It is where the router says we are, plus the home the page standing there declared
 * (components/nav-home), taken only when it was declared on THIS pathname. One exception, and it is
 * the reason this is a hook and not three lines in each renderer: a visit's page says where it lives
 * only once it has arrived, and between the tap and the page there is the loading spinner, already
 * on the new URL. For that stretch (lib/dock awaitsHome) the nav stays on the last location that had
 * settled, so opening an inspection from the Inspections list changes nothing in the sub-nav at
 * all, instead of blinking it out and back.
 *
 * `settled` is module-level on purpose: the dock and the strip are two components, and one answer
 * between them is the point. It is written in an effect (never on the server, never during a
 * render that might be thrown away) and only while this location is not itself waiting.
 */
let settled: NavAt | null = null;

export function useNavAt(sections: DockSection[]): NavAt {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const declared = useDeclaredNavHome();
  const now: NavAt = {
    pathname,
    current: pathname + (query ? `?${query}` : ""),
    home: declared && declared.pathname === pathname ? declared.id : null,
  };
  const waiting = awaitsHome(now, sections);
  useEffect(() => {
    if (!waiting) settled = now;
  });
  return navDrawnAt(now, settled, sections);
}
