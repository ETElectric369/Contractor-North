"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

/**
 * A PAGE SAYS WHERE IT LIVES IN THE DOCK.
 *
 * The shell finds the lit cluster and its sub-nav from the URL alone (lib/dock activeSection), which
 * is right for every page whose address says what it is. A visit's does not: /appointments/<id> is an
 * inspection under Sales › Inspections, or a booking on the Schedule, and only the row knows which.
 * So that page lit nothing and the sub-nav vanished the moment an inspection was opened (Erik,
 * 2026-11-10: "the sub-nav disappears when an inspection is clicked"). The shell may not read the
 * database on every navigation to find out; the page has already read the row. So the page says:
 *
 *     <NavHome id={home.nav} />        // a dock row's id (lib/dock), from the server page
 *
 * and the one matcher (lib/dock activeNav) uses it ONLY when the pathname matches no cluster on its
 * own. A page a cluster owns can render this and nothing changes.
 *
 * THE DECLARATION IS TIED TO THE PATHNAME IT WAS MADE ON. The shell re-renders for the next page
 * before this one's effects are cleaned up, so a bare "current home" would light the last page's
 * cluster on the next one for a frame. The reader (app-shell/use-nav-at) takes a declaration only for
 * the pathname it is standing on; taking it back on the way out is tidiness, not the guard.
 *
 * ONE STORE, MODULE-LEVEL, the way the turn is published (components/turns-sideways): the page and
 * the shell are different client islands of one layout, with no provider between them that the page
 * could reach. Nothing here runs on the server (effects only), so nothing is shared across requests;
 * the server and the first paint read null, and the home arrives with the page's first commit.
 */
export type DeclaredHome = { readonly id: string; readonly pathname: string };

let declared: DeclaredHome | null = null;
const watchers = new Set<() => void>();

function publish(next: DeclaredHome | null) {
  declared = next;
  for (const w of watchers) w();
}

/**
 * The page at `pathname` lives under the dock row `id`. The answer is the way to take it back, and it
 * takes back only its own: a page that mounts before the last one has finished leaving is not undone
 * by that one's goodbye.
 */
export function declareNavHome(id: string, pathname: string): () => void {
  const mine: DeclaredHome = { id, pathname };
  publish(mine);
  return () => {
    if (declared === mine) publish(null);
  };
}

/** What is declared right now (for the store's snapshot, and the test). */
export function declaredNavHome(): DeclaredHome | null {
  return declared;
}

/** Be told when the declaration changes; the answer stops the telling. */
export function watchNavHome(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

/** The declaration, with the pathname it was made on. Null on the server and on the first paint. */
export function useDeclaredNavHome(): DeclaredHome | null {
  return useSyncExternalStore(watchNavHome, declaredNavHome, () => null);
}

/**
 * Rendered by a page (a server page may: this is the client leaf) to name the dock row it lives
 * under. Draws nothing. A layout effect, so on a soft navigation the home lands in the same frame as
 * the page and the nav never shows a frame without it.
 */
export function NavHome({ id }: { id: string }) {
  const pathname = usePathname();
  useLayoutEffect(() => declareNavHome(id, pathname), [id, pathname]);
  return null;
}
