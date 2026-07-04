"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";

type RunOptions = {
  /** Toast this on success. Omit for a silent success. */
  success?: string;
  /** Toast this if the action returns { ok:false } with no `error` of its own. */
  errorFallback?: string;
  /** Run this AFTER success INSTEAD of the default router.refresh() — e.g. router.push,
   *  close a modal, reset a form. When set, the caller owns what happens next. */
  onSuccess?: () => void;
};

/**
 * THE submit-a-server-action idiom, extracted from the ~25 client components that hand-rolled
 * it: wrap an action in a transition, toast its {ok,error} result, and router.refresh() (or a
 * caller-supplied onSuccess). Returns the result so a caller can branch further.
 *
 *   const { pending, run } = useServerAction();
 *   <button disabled={pending} onClick={() => run(() => deleteThing(id), { success: "Deleted." })}>
 *
 * Callers whose success path genuinely diverges (inline setError, multi-step flows) keep their
 * own useTransition — this hook is for the common toast-then-refresh shape, not a mandate.
 */
export function useServerAction() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  function run<T extends { ok: boolean; error?: string }>(
    action: () => Promise<T>,
    opts: RunOptions = {},
  ): void {
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        toast(res.error ?? opts.errorFallback ?? "Something went wrong — try again.", "error");
        return;
      }
      if (opts.success) toast(opts.success, "success");
      if (opts.onSuccess) opts.onSuccess();
      else router.refresh();
    });
  }

  return { pending, run };
}
