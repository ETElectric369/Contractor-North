"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInvoiceForJob } from "../jobs/actions";

/** One tap from "done, not invoiced" → a draft invoice (labor + materials pulled in), then straight to it. */
export function InvoiceJobButton({ jobId }: { jobId: string }) {
  const router = useRouter();
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
            if (res.ok && res.id) router.push(`/billing/${res.id}`);
            else setError(res.error ?? "Couldn't create it.");
          })
        }
        disabled={pending}
        className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create invoice →"}
      </button>
    </div>
  );
}
