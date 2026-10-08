"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { recordStripeRefund } from "../actions";

/**
 * RECORD THIS REFUND (item C, 2026-10-07): the one tap the refund notice leads to. The server reads
 * the refunded amount back from Stripe on the company's own connected account (never from the
 * link), caps it at what the invoice's payment was, and writes the refund row once per charge.
 * The invoice stays paid; Collected comes down by it, as a hand-recorded refund does today.
 */
export function RecordRefundButton({ invoiceId, chargeId }: { invoiceId: string; chargeId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await recordStripeRefund({ invoiceId, chargeId });
            if (!res.ok) {
              setError(res.error ?? "Couldn't record it.");
              return;
            }
            toast(res.message ?? "Recorded.", "info");
            router.replace(`/billing/${invoiceId}`);
            router.refresh();
          })
        }
        disabled={pending}
        className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record This Refund"}
      </button>
      {error && (
        <span className="text-sm text-red-600" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
