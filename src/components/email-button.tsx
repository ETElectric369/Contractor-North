"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquare, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { emailQuote, textQuote } from "@/app/(app)/quotes/actions";
import { emailInvoice, textInvoice } from "@/app/(app)/billing/actions";

type Result = { ok: boolean; error?: string };

function SendChip({
  label,
  icon: Icon,
  run,
  confirmText,
  successText,
  onDone,
  primary = false,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => Promise<Result>;
  /** Spelled-out confirm (e.g. "Email this $1,240.00 invoice to Acme Co?"). */
  confirmText?: string;
  /** Past-tense toast on success (e.g. "Invoice emailed"). */
  successText: string;
  /** Called after a successful send so the caller can refresh status. */
  onDone?: () => void;
  /** Render as a filled primary action instead of an outlined chip. */
  primary?: boolean;
}) {
  const toast = useToast();
  // Busy state only — success/failure now report through the app-wide toast so a
  // stale green check can't keep claiming "Sent" after the page state moves on.
  const [busy, setBusy] = useState(false);

  async function go() {
    if (!confirm(confirmText ?? `${label}?`)) return;
    setBusy(true);
    try {
      const res = await run();
      if (!res?.ok) {
        toast(res?.error ?? "Couldn't send — try again.", "error");
        return;
      }
      toast(successText, "success");
      onDone?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={go}
      disabled={busy}
      className={
        primary
          ? "inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
          : "inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      }
    >
      {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Icon className="h-4 w-4 shrink-0" />}
      {label}
    </button>
  );
}

/** Email + Text send controls for a quote or invoice.
 *  For invoices the Email chip is the primary "Send invoice" action — sending is
 *  what flips the status to Sent, so we name the customer + amount in the confirm
 *  and refresh after a success so the new status shows immediately. */
export function EmailButton({
  id,
  kind,
  customerName,
  amount,
}: {
  id: string;
  kind: "quote" | "invoice";
  /** Invoice only: customer + amount spelled into the confirm prompt. */
  customerName?: string | null;
  amount?: number | null;
}) {
  const router = useRouter();
  const isInvoice = kind === "invoice";
  const money =
    amount != null
      ? amount.toLocaleString(undefined, { style: "currency", currency: "USD" })
      : null;
  const who = customerName?.trim() || "the customer";
  const emailConfirm = isInvoice
    ? `Send this ${money ? `${money} ` : ""}invoice to ${who} by email? This marks it Sent.`
    : undefined;
  const textConfirm = isInvoice
    ? `Text this ${money ? `${money} ` : ""}invoice to ${who}? This marks it Sent.`
    : undefined;

  return (
    <div className="flex items-center gap-2">
      <SendChip
        label={isInvoice ? "Send Invoice" : "Email"}
        icon={Mail}
        primary={isInvoice}
        confirmText={emailConfirm}
        successText={isInvoice ? "Invoice emailed" : "Estimate emailed"}
        onDone={isInvoice ? () => router.refresh() : undefined}
        run={() => (kind === "quote" ? emailQuote(id) : emailInvoice(id))}
      />
      <SendChip
        label="Text"
        icon={MessageSquare}
        confirmText={textConfirm}
        successText={isInvoice ? "Invoice texted" : "Estimate texted"}
        onDone={isInvoice ? () => router.refresh() : undefined}
        run={() => (kind === "quote" ? textQuote(id) : textInvoice(id))}
      />
    </div>
  );
}
