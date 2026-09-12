"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { createInvoiceForJob } from "../jobs/actions";

/** One tap from "done, not invoiced" → a draft invoice (labor + materials pulled in), then straight
 *  to it. The server's note — an existing draft opened, an import that couldn't run — is toasted
 *  BEFORE the redirect (this row used to drop it, so why you landed where you landed was never
 *  said). A refusal stays on the row; when everything is already billed on one invoice, the toast
 *  carries the door to it instead of a dead sentence. */
export function InvoiceJobButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex shrink-0 items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await createInvoiceForJob(jobId);
            if (!res.ok || !res.id) {
              const door = res.billedOn;
              if (door) {
                toast(res.error ?? "Nothing new to bill.", "error", { label: `Open ${door.number}`, onClick: () => router.push(`/billing/${door.id}`) });
              } else {
                setError(res.error ?? "Couldn't create it.");
              }
              return;
            }
            if (res.importWarning) toast(res.importWarning, "info");
            router.push(`/billing/${res.id}`);
          })
        }
        disabled={pending}
        className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create Invoice →"}
      </button>
    </div>
  );
}
