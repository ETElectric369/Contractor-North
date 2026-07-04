"use client";

import { Trash2 } from "lucide-react";
import { useServerAction } from "@/lib/use-server-action";

/**
 * The standard row-delete affordance: a Trash2 ghost button that confirm()s, runs the action
 * through useServerAction (toast + refresh), and disables while pending. For the ~15 inline
 * copies of this exact shape. Callers with bespoke confirms (an alert() with legal/OSHA copy,
 * or a cascade warning) keep their own button — this is the common case, not a mandate.
 */
export function DeleteButton({
  action,
  confirm,
  done,
  label = "Delete",
  className,
}: {
  action: () => Promise<{ ok: boolean; error?: string }>;
  /** The confirm() prompt. */
  confirm: string;
  /** Success toast (omit for a silent delete). */
  done?: string;
  label?: string;
  className?: string;
}) {
  const { pending, run } = useServerAction();
  return (
    <button
      type="button"
      onClick={() => {
        if (window.confirm(confirm)) run(action, { success: done });
      }}
      disabled={pending}
      aria-label={label}
      title={label}
      className={
        className ??
        "rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
      }
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}
