"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissResendNotice, restoreResendNotice } from "./resend-notice-actions";

/**
 * DISMISS, AND THE WAY BACK (Erik, 2026-11-22; 0419): "I know its been revised and I don't want to send
 * it again, can we put a dismiss button on those please".
 *
 * One button, two doors: Dismiss puts the send-again notice away until the bill is sent again; Bring
 * the Notice Back clears that. A 44px target, disabled while it runs, the page refreshed on success,
 * and a refusal said beside the button (never a toast that is gone before it is read).
 *
 * ON THE INVOICES PAGE IT IS A SIBLING OF THE ROW'S LINK, NEVER INSIDE IT: a button inside an <a> is
 * invalid markup, and a tap on it would open the invoice as well.
 */
export function DismissResendButton({ invoiceId, restore = false, className = "" }: { invoiceId: string; /** true = Bring the Notice Back */ restore?: boolean; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = restore ? "Bring the Notice Back" : "Dismiss";
  return (
    <span className={`inline-flex shrink-0 flex-wrap items-center justify-end gap-2 ${className}`}>
      {error && (
        <span className="text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = restore ? await restoreResendNotice(invoiceId) : await dismissResendNotice(invoiceId);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            router.refresh();
          })
        }
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        {pending ? (restore ? "Bringing It Back…" : "Dismissing…") : label}
      </button>
    </span>
  );
}
