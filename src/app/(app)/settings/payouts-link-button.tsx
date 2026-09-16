"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { payoutsDashboardLink } from "./billing-actions";

/**
 * THE DOOR THAT DOESN'T CLOSE BEHIND YOU.
 *
 * Stripe's Express dashboard is where a contractor's payouts, fees and bank account actually live,
 * and it is the one destination in this app that offers no way back — no return_url, no link home.
 * Walking the tab into it stranded Erik there. So the app never walks: it opens Stripe beside
 * itself and stays put.
 *
 * `window.open` without "noopener" on purpose — with it the call returns null even on success, and
 * the null is the only signal a browser gives that it blocked the popup. Blocked, we fall back to
 * the old same-tab behaviour rather than doing nothing, and we leave a plain link on screen so
 * there is always something to tap.
 */
export function PayoutsLinkButton() {
  const [pending, start] = useTransition();
  const [fallback, setFallback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function open() {
    setError(null);
    setFallback(null);
    // Started inside the click's own transition so Safari treats it as the gesture's own window.
    start(async () => {
      const res = await payoutsDashboardLink();
      if (!res.url) {
        setError(res.error ?? "Couldn't open your Stripe account.");
        return;
      }
      try {
        const w = window.open(res.url, "_blank");
        if (!w) {
          setFallback(res.url);
          window.location.href = res.url;
        }
      } catch {
        setFallback(res.url);
        window.location.href = res.url;
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        onClick={open}
        disabled={pending}
        title="Opens your own Stripe account in a separate tab — payouts, fees, and the bank account they land in. This app stays open behind it."
      >
        <ExternalLink className="h-4 w-4" /> {pending ? "Opening Stripe…" : "View Payouts"}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
      {fallback && (
        <a href={fallback} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand hover:underline">
          Stripe didn&apos;t open — tap here
        </a>
      )}
    </div>
  );
}
