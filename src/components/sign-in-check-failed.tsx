"use client";

import { Button } from "@/components/ui/button";

/** The sign-in check got no answer (lib/supabase/user-check: unreachable, 5xx, a gateway page).
 *  This is NOT a sign-out, so the login screen is the wrong door: say what happened and go back
 *  on a tap. Served from /sign-in-check (its own URL, so the offline cache never keeps it as a
 *  page the person had open). */
export function SignInCheckFailed() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Couldn&apos;t check your sign-in just now</h1>
      <p className="mt-1 max-w-md text-sm text-slate-500">Nothing was lost. Try again in a moment.</p>
      <Button
        className="mt-4 min-h-11"
        onClick={() => {
          if (window.history.length > 1) window.history.back();
          else window.location.replace("/planner");
        }}
      >
        Try Again
      </Button>
    </div>
  );
}
