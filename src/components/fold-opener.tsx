"use client";

import { useEffect } from "react";

/**
 * A LINK INTO A FOLD OPENS THE FOLD (Bills plan, Wave B). /bills keeps everything below Needs You
 * folded, and a link to something folded away ("#bill-...", "#ced-import", "/bills#supplier-
 * invoices-...") would otherwise land on a closed box: a dead door. This opens every <details>
 * around the target, then brings it into view. Runs on arrival, on a hash change, and on a tap of
 * any in-page "#..." link (Next's own navigation does not fire hashchange).
 */
export function openFoldsTo(id: string): boolean {
  if (typeof document === "undefined" || !id) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  for (let el: HTMLElement | null = target; el; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
  }
  requestAnimationFrame(() => target.scrollIntoView({ block: "start", behavior: "smooth" }));
  return true;
}

const idOfHash = (hash: string) => {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return hash.replace(/^#/, "");
  }
};

export function FoldOpener() {
  useEffect(() => {
    const fromLocation = () => openFoldsTo(idOfHash(window.location.hash));
    fromLocation();
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const url = new URL(a.href, window.location.href);
      if (url.pathname !== window.location.pathname || !url.hash) return;
      // After the browser (or Next) has moved the hash, so both agree on where he is.
      setTimeout(() => openFoldsTo(idOfHash(url.hash)), 0);
    };
    window.addEventListener("hashchange", fromLocation);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", fromLocation);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return null;
}
