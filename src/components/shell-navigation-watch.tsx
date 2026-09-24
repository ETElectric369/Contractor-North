"use client";

import { useEffect, useRef, useState } from "react";
import { isNativeShell } from "@/lib/native-shell";
import { reportClientError } from "@/app/report-client-error";

/**
 * THE TAP THAT DID NOTHING (the 09-23 sweep, "Didn't open new job").
 *
 * On a dropped signal Next's page fetch fails and it falls back to a full navigation. In the iOS
 * shell that navigation fails too, and the page he tapped on simply stays: no error, no spinner,
 * nothing. Worse, Capacitor wiped every native listener when the navigation started, so the page
 * still on screen had quietly stopped hearing the card reader and notification taps.
 *
 * The shell's NavigationFailureRelay now tells the page (`cn:navigation-failed`). This says so on
 * screen, where the tap happened, and puts a row in the ops log. The listeners recover on their
 * own: the Tap to Pay bridge re-registers on every turn and the push tap on every return to the
 * foreground, so there is nothing else to do here.
 *
 * Mounted beside OfflineDrain, outside the toast provider, so it draws its own notice. Renders
 * nothing outside the shell.
 */
export function ShellNavigationWatch() {
  const [shown, setShown] = useState(false);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** One ops row per path per minute: a flaky afternoon is one story, not forty rows. */
  const lastReported = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!isNativeShell()) return;
    const onFail = (e: Event) => {
      const d = ((e as CustomEvent).detail ?? {}) as { domain?: string; code?: number; url?: string };
      let path = "";
      try {
        path = d.url ? new URL(d.url).pathname : ""; // the path only: a query string can carry names
      } catch {
        /* an unparseable URL is still a failed navigation */
      }
      const now = Date.now();
      if (now - (lastReported.current.get(path) ?? 0) > 60_000) {
        lastReported.current.set(path, now);
        void reportClientError("shell-navigation", `navigation failed: ${d.domain ?? "unknown"} ${d.code ?? ""}`.trim(), {
          path,
          domain: String(d.domain ?? ""),
          code: String(d.code ?? ""),
        }).catch(() => {});
      }
      setShown(true);
      clearTimeout(hide.current);
      hide.current = setTimeout(() => setShown(false), 6000);
    };
    window.addEventListener("cn:navigation-failed", onFail);
    return () => {
      window.removeEventListener("cn:navigation-failed", onFail);
      clearTimeout(hide.current);
    };
  }, []);

  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-3 shell:bottom-4">
      <button
        type="button"
        role="status"
        aria-live="polite"
        onClick={() => setShown(false)}
        className="pointer-events-auto min-h-11 max-w-sm rounded-2xl border border-amber-200 bg-white px-4 py-2 text-sm text-amber-900 shadow-lg"
      >
        That page didn&apos;t load. Check your signal and tap it again.
      </button>
    </div>
  );
}
