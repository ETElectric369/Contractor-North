import { useTransition, type TransitionStartFunction } from "react";
import { useRouter } from "next/navigation";

/**
 * TRY AGAIN, FOR REAL (audit v1018, class 9). An error page's `reset` only clears the boundary's
 * error state: it re-renders the SAME cached server payload, which still holds the throw, so the card
 * came straight back on every tap (a failed invoice read stayed failed after the lock cleared). The
 * page has to be fetched again first: router.refresh(), then reset(), in one transition, so the
 * boundary swaps back only once the fresh payload is in.
 *
 * The one rule every error page shares (src/app error.tsx / global-error.tsx; tests/try-again.test.ts
 * reads them all).
 */
export function tryAgain(router: { refresh: () => void }, reset: () => void, startTransition: TransitionStartFunction): void {
  startTransition(() => {
    router.refresh();
    reset();
  });
}

/** `tryAgain` for an error page's button, and whether the fresh fetch is still on its way. */
export function useTryAgain(reset: () => void): { tryAgain: () => void; trying: boolean } {
  const router = useRouter();
  const [trying, startTransition] = useTransition();
  return { tryAgain: () => tryAgain(router, reset, startTransition), trying };
}
