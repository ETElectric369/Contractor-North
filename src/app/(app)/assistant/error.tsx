"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { reportClientError } from "@/app/report-client-error";
import { recoverFromChunkError } from "@/lib/chunk-reload";

/** Segment error boundary for the assistant. A render crash anywhere in the chat / Estimator
 *  now shows this graceful fallback (with a reset) instead of blanking the whole app. The crash
 *  is forwarded to reportClientError → the error_events ops log, so it stops being invisible. */
export default function AssistantError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (recoverFromChunkError(error)) return; // stale Estimator/chat chunk after a deploy → reload fresh
    // Surface it in the console too, alongside the error_events forward below.
    console.error("Assistant crashed:", error);
    void reportClientError("assistant-boundary", error?.message ?? String(error), {
      digest: error?.digest,
      url: typeof window !== "undefined" ? window.location.pathname : undefined,
    });
  }, [error]);

  return (
    <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50">
        <AlertTriangle className="h-6 w-6 text-amber-500" />
      </div>
      <h2 className="text-lg font-semibold text-slate-900">The assistant hit a snag</h2>
      <p className="mt-2 text-sm text-slate-500">
        Something went wrong mid-conversation. Your data is safe — nothing was lost. Start it back up
        and pick up where you left off.
      </p>
      <button
        onClick={reset}
        className="mt-5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
      >
        Restart Nort
      </button>
    </div>
  );
}
