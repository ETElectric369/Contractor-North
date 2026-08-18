"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/app/report-client-error";
import { recoverFromChunkError } from "@/lib/chunk-reload";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A STALE TAB ACROSS A DEPLOY IS NOT AN ERROR, IT IS AN UPDATE (audit 8). This boundary
    // covers /login, /estimate, /intake, /i, /q, /portal, /print — every page a CUSTOMER sees.
    // The (app) boundary has recovered from renamed chunks since cn-v536; this one showed a
    // dead red card on the money paper instead, and reported it as a crash.
    if (recoverFromChunkError(error)) return;
    console.error(error);
    void reportClientError("error-boundary", error?.message ?? String(error), {
      digest: error?.digest,
      url: typeof window !== "undefined" ? window.location.pathname : undefined,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
        <AlertTriangle className="h-6 w-6 text-red-600" />
      </div>
      <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
      <p className="mt-1 max-w-md text-sm text-slate-500">
        An unexpected error occurred. You can try again, or head back to the
        dashboard.
      </p>
      <div className="mt-5 flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Link href="/planner">
          <Button variant="outline">Dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
