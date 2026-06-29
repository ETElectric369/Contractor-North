"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquare, Check, Loader2 } from "lucide-react";
import { emailQuote, textQuote } from "@/app/(app)/quotes/actions";
import { emailInvoice, textInvoice } from "@/app/(app)/billing/actions";

type Result = { ok: boolean; error?: string };

function SendChip({
  label,
  icon: Icon,
  run,
  confirmText,
  onDone,
  primary = false,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => Promise<Result>;
  /** Spelled-out confirm (e.g. "Email this $1,240.00 invoice to Acme Co?"). */
  confirmText?: string;
  /** Called after a successful send so the caller can refresh status. */
  onDone?: () => void;
  /** Render as a filled primary action instead of an outlined chip. */
  primary?: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function go() {
    if (!confirm(confirmText ?? `${label}?`)) return;
    setState("busy");
    setMsg(null);
    const res = await run();
    if (res.ok) {
      setState("done");
      onDone?.();
    } else {
      setState("error");
      setMsg(res.error ?? "Could not send.");
    }
  }

  return (
    <div className="relative">
      <button
        onClick={go}
        disabled={state === "busy"}
        className={
          primary
            ? "inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
            : "inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
        }
      >
        {state === "busy" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : state === "done" ? (
          <Check className={`h-4 w-4 ${primary ? "text-white" : "text-green-600"}`} />
        ) : (
          <Icon className="h-4 w-4" />
        )}
        {state === "done" && primary ? "Sent" : label}
      </button>
      {state === "error" && msg && (
        <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
          {msg}
        </div>
      )}
    </div>
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
        label={isInvoice ? "Send invoice" : "Email"}
        icon={Mail}
        primary={isInvoice}
        confirmText={emailConfirm}
        onDone={isInvoice ? () => router.refresh() : undefined}
        run={() => (kind === "quote" ? emailQuote(id) : emailInvoice(id))}
      />
      <SendChip
        label="Text"
        icon={MessageSquare}
        confirmText={textConfirm}
        onDone={isInvoice ? () => router.refresh() : undefined}
        run={() => (kind === "quote" ? textQuote(id) : textInvoice(id))}
      />
    </div>
  );
}
