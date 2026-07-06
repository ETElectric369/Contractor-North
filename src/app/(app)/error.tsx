"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/app/report-client-error";

/** Segment error boundary for the whole (app) shell. A render crash in any (app) PAGE now
 *  shows this recoverable card in the content area while the dock, topbar, and back nav stay
 *  alive — instead of bubbling to the root boundary that replaced the entire shell (the
 *  "back button doesn't work / can't tap the menu" symptom). Also reports the crash to our
 *  sentry_events sink so it stops being invisible. NOTE: this does NOT catch a throw in the
 *  (app) LAYOUT itself (a segment boundary can't catch its own layout) — that's why the
 *  layout guards its own awaits directly. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    void reportClientError("app-boundary", error?.message ?? String(error), {
      digest: error?.digest,
      url: typeof window !== "undefined" ? window.location.pathname : undefined,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
        <AlertTriangle className="h-6 w-6 text-red-600" />
      </div>
      <h1 className="text-lg font-semibold text-slate-900">This page hit a snag</h1>
      <p className="mt-1 max-w-md text-sm text-slate-500">
        Something went wrong loading this screen. Your data is safe — try again, or head back
        to your day.
      </p>
      <div className="mt-5 flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Link href="/planner">
          <Button variant="outline">My Day</Button>
        </Link>
      </div>
    </div>
  );
}
