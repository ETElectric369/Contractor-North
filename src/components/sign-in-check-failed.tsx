"use client";

import { Button } from "@/components/ui/button";
import { safeNextPath } from "@/lib/safe-next";

/** Where Try Again goes: the page named in `?next=` when one is given (the login screen's same
 *  parameter; a same-app path only, so a pasted link can't send anyone off the site), else back
 *  inside the app (the page before this one, used only when it is ours: a same-site referrer, never a
 *  message or another site the link was tapped in), else My Day, which runs the same check again.
 *  Nothing here knows which page failed unless `?next=` says so. */
export function tryAgainTarget(search: string, referrer: string, origin: string): string | "back" {
  const next = safeNextPath(new URLSearchParams(search).get("next"));
  if (next && !next.startsWith("/sign-in-check")) return next;
  if (referrer && origin && referrer.startsWith(`${origin}/`)) return "back";
  return "/planner";
}

/** The sign-in check got no answer (lib/supabase/user-check: unreachable, 5xx, a gateway page).
 *  This is NOT a sign-out, so the login screen is the wrong door: say what happened and offer Try
 *  Again, which goes where tryAgainTarget says. Served from /sign-in-check (its own URL, so the
 *  offline cache never keeps it as a page the person had open). */
export function SignInCheckFailed() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Couldn&apos;t check your sign-in just now</h1>
      <p className="mt-1 max-w-md text-sm text-slate-500">Nothing was lost. Try again in a moment.</p>
      <Button
        className="mt-4 min-h-11"
        onClick={() => {
          const go = tryAgainTarget(window.location.search, document.referrer, window.location.origin);
          if (go === "back" && window.history.length > 1) window.history.back();
          else window.location.replace(go === "back" ? "/planner" : go);
        }}
      >
        Try Again
      </Button>
    </div>
  );
}
