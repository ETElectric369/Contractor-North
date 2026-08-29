"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeDollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { settleUp } from "@/app/(app)/billing/actions";

/**
 * DONE & PAID — the money door, on the record itself.
 *
 * Erik: "i showed up it took me less time and i wanted a way to collect payment boom... everything
 * needs an easy way to get to the schedule get done and get paid, thats the critical path."
 *
 * One tap opens it, amount + method, one tap settles it. Inline rather than a modal — this gets
 * used standing in a driveway with cash in one hand (the 60mph law), and a modal is one more
 * surface between him and done. The method chips are the four ways a contractor actually gets
 * paid; card is here for the day Stripe's tap-to-pay lands on this same button.
 */
export function SettleUpButton({
  source,
  id,
  compact,
}: {
  source: "appointment" | "job";
  id: string;
  /** Chip-sized trigger for dense rows; full button on record pages. */
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");

  function save() {
    const amt = Number(String(amount).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amt) || amt <= 0) {
      toast("Enter what they paid.", "error");
      return;
    }
    start(async () => {
      const res = await settleUp({ source, id, amount: amt, method }).catch(() => ({
        ok: false as const,
        error: "That didn't reach the server — check your connection and try again.",
      }));
      if (!res.ok) {
        // A partial success names the invoice it made — the money record is never hidden
        // behind a bare error.
        toast(res.error ?? "Couldn't settle that.", "error");
        if ("invoiceId" in res && res.invoiceId) router.push(`/billing/${res.invoiceId}`);
        return;
      }
      toast(
        `Paid — $${amt.toLocaleString()} ${method === "cash" ? "cash" : method} recorded. Done.`,
        "success",
      );
      setOpen(false);
      setAmount("");
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button size="sm" variant={compact ? "outline" : "primary"} onClick={() => setOpen(true)}>
        <BadgeDollarSign className="h-4 w-4" /> Done &amp; paid
      </Button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-brand/40 bg-brand-light/30 p-1.5">
      <input
        autoFocus
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="$ amount"
        aria-label="What they paid"
        className="h-9 w-24 rounded-lg border border-slate-200 px-2 text-sm"
      />
      <span className="inline-flex overflow-hidden rounded-lg border border-slate-200">
        {(["cash", "check", "card", "other"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMethod(m)}
            className={`px-2.5 py-1.5 text-xs font-semibold capitalize ${
              method === m ? "bg-brand text-white" : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            {m}
          </button>
        ))}
      </span>
      <Button size="sm" onClick={save} disabled={pending}>
        {pending ? "Recording…" : "Record it"}
      </Button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="px-1 text-xs font-medium text-slate-500 hover:text-slate-800"
      >
        Cancel
      </button>
    </span>
  );
}
