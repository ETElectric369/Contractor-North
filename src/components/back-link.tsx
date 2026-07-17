"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/**
 * THE back breadcrumb — one smart component instead of a hardcoded
 * "Back to <parent list>" on every detail page.
 *
 * The complaint it fixes: arriving at a quote FROM A JOB and tapping
 * "Back to Quotes" lands on /quotes — a page you never visited. A back
 * control should retrace your steps; the parent list is only the right
 * destination when there are no steps to retrace (deep link, reload,
 * new tab).
 *
 * Behavior:
 * - Real in-app history exists → label "Back" (the only truthful label —
 *   we don't know WHICH page is behind us), click = router.back().
 * - Cold entry → label "Back to X", click navigates to the explicit
 *   parent fallback. Never a dead/frozen button, never exits the app.
 *
 * "In-app history exists" is detected with two signals, because
 * window.history.length lies (it counts cross-site entries and never
 * shrinks, so it can't distinguish "came from inside the app" from
 * "came from Google"):
 * 1. A module-level flag flipped by <BackLinkTracker/> (mounted once in
 *    the ROOT layout so it never unmounts, and covers /print/* too) on
 *    the first client-side route change. Module scope survives route
 *    changes within one document and resets on hard reload — exactly
 *    the lifetime of the history we can vouch for.
 * 2. A same-origin document.referrer — covers fresh document loads that
 *    still came from inside the app (e.g. window.open into a print
 *    page), where history.back() is still safe. history.length > 1
 *    guards the opened-in-a-new-tab case, where there is no entry to
 *    pop and back() would look frozen.
 * False negatives just mean the fallback link — today's behavior.
 */

let initialPathname: string | null = null;
let navigatedInApp = false;

/** The tracker's brain, pure so it's testable. Exported for tests only. */
export function trackPathnameForBackLink(pathname: string) {
  if (initialPathname === null) initialPathname = pathname;
  else if (pathname !== initialPathname) navigatedInApp = true;
}

/** Test-only: module state otherwise persists across cases. */
export function resetBackLinkTrackingForTests() {
  initialPathname = null;
  navigatedInApp = false;
}

/** True when history.back() verifiably stays inside the app. Client-only. */
export function hasInAppHistory(): boolean {
  if (typeof window === "undefined") return false;
  // The one-way flag can vouch only for pages we pushed AFTER the cold entry. Standing
  // on the INITIAL pathname again (you navigated in, then retraced Back to where the
  // document entered), the entry behind you is the pre-app referrer — claiming "Back"
  // here would pop out to Google. Fall through to the referrer signal instead, which
  // correctly answers both cold-entry shapes (external referrer → fallback link;
  // same-origin referrer → back() still stays in the app).
  if (navigatedInApp && window.location.pathname !== initialPathname) return true;
  if (window.history.length <= 1) return false; // new tab: nothing to pop
  // Parse rather than startsWith: "https://ours.com.evil.io" startsWith our origin.
  try {
    return new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false; // empty/malformed referrer = cold entry
  }
}

/** Mounted once in the root layout. Renders nothing; just watches navigation. */
export function BackLinkTracker() {
  const pathname = usePathname();
  useEffect(() => {
    trackPathnameForBackLink(pathname);
  }, [pathname]);
  return null;
}

export function BackLink({
  fallback,
  fallbackLabel,
  className = "mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800",
}: {
  /** Where to go on a cold entry (deep link / reload / new tab). */
  fallback: string;
  /** Honest label for that destination, e.g. "Back to Estimates". */
  fallbackLabel: string;
  /** Full class override — default matches the detail-page breadcrumb style. */
  className?: string;
}) {
  const router = useRouter();
  // Decided post-mount: SSR and the first client render must agree (both show
  // the fallback), then the effect flips to "Back" when history is real.
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    setCanGoBack(hasInAppHistory());
  }, []);

  return (
    <Link
      href={fallback}
      className={className}
      onClick={(e) => {
        // Modifier/middle clicks keep native Link behavior (fallback in new tab).
        if (!canGoBack || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        router.back();
      }}
    >
      <ArrowLeft className="h-4 w-4 shrink-0" /> {canGoBack ? "Back" : fallbackLabel}
    </Link>
  );
}
