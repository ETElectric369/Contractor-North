"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Mail, MessageSquare, Send } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { emailInvoice, textInvoice } from "@/app/(app)/billing/actions";
import { emailQuote, textQuote } from "@/app/(app)/quotes/actions";
import { TEXT_NOT_READY_REFUSAL } from "@/lib/sms-readiness";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";

/**
 * THE SEND SHEET (W1-26): one door that puts a bill or an estimate in the customer's hands, built
 * generic so the invoice header, its ⋯ Send Again, the holding-an-older-bill notice and (next
 * wave) a Needs You row all open the same thing. The sheet IS the confirm: it names who gets it,
 * for how much and, when given, how many lines, and on an invoice keeps "This marks it Sent" - a
 * send is never one stray tap. Two 44px choices, Email It and Text It. Text It keeps its not-ready
 * refusal in place (lib/sms-readiness): shown where the button is, never a promise the server
 * refuses. Nothing sends without one of those two taps.
 *
 * The props are the contract lane 5 builds on: kind, id, number, customer name, amount, line count
 * (optional), textReady, openHref (optional: adds an Open It First link) and onSent.
 */
export type SendSheetProps = {
  kind: "invoice" | "quote";
  id: string;
  number?: string | null;
  customerName?: string | null;
  amount?: number | null;
  /** How many lines go out, when the caller knows (a Needs You row does; the invoice page does). */
  lineCount?: number | null;
  /** smsReadiness(org).ready, from the page. false: Text It says why in place and sends nothing. */
  textReady?: boolean;
  /** Adds "Open It First" (the document, to look at before it goes). */
  openHref?: string | null;
  /** After a send landed: how it went out. The sheet has already refreshed the page. */
  onSent?: (how: "email" | "text") => void;
};

/** The one sentence the sheet asks: who, how much, how many lines - and on an invoice, that
 *  sending marks it Sent. */
export function sendConfirmSentence(p: Pick<SendSheetProps, "kind" | "number" | "customerName" | "amount" | "lineCount">): string {
  const doc = p.number?.trim() || (p.kind === "invoice" ? "this invoice" : "this estimate");
  const who = p.customerName?.trim() || "the customer";
  const money = p.amount != null && Number.isFinite(p.amount) ? ` for ${formatCurrency(Number(p.amount))}` : "";
  const lines = p.lineCount != null && p.lineCount >= 0 ? ` (${p.lineCount} ${p.lineCount === 1 ? "line" : "lines"})` : "";
  return `Send ${doc}${money}${lines} to ${who}?${p.kind === "invoice" ? " This marks it Sent." : ""}`;
}

const CHOICE_CLS =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold disabled:opacity-60";

export function SendSheet({ open, onClose, ...p }: SendSheetProps & { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [how, setHow] = useState<"email" | "text" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textReady = p.textReady !== false;
  const isInvoice = p.kind === "invoice";

  function send(via: "email" | "text") {
    setError(null);
    if (via === "text" && !textReady) {
      // In place, not a trip to the server: texting isn't set up, so nothing can go.
      toast(TEXT_NOT_READY_REFUSAL, "info");
      return;
    }
    setHow(via);
    start(async () => {
      const run = isInvoice ? (via === "email" ? emailInvoice : textInvoice) : via === "email" ? emailQuote : textQuote;
      const res: { ok: boolean; error?: string; notReady?: boolean } = await run(p.id).catch(() => ({
        ok: false,
        error: "That didn't reach the server - check your connection and try again.",
      }));
      setHow(null);
      if (!res?.ok) {
        // Said where it was tapped, and the sheet stays: the send didn't happen.
        setError(res?.error ?? "It didn't send - try again.");
        return;
      }
      toast(`${isInvoice ? "Invoice" : "Estimate"} ${via === "email" ? "emailed" : "texted"}`, "success");
      onClose();
      p.onSent?.(via);
      router.refresh();
    });
  }

  return (
    <Modal open={open} onClose={onClose} title={isInvoice ? "Send Invoice" : "Send Estimate"} size="sm" portal holdOpen={pending}>
      <div className="space-y-4">
        <p className="text-sm text-slate-700">{sendConfirmSentence(p)}</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => send("email")}
            disabled={pending}
            className={`${CHOICE_CLS} border-transparent bg-[rgb(var(--glass-ink))] text-white hover:bg-[rgb(var(--glass-ink))]/90`}
          >
            {pending && how === "email" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Email It
          </button>
          <button
            type="button"
            onClick={() => send("text")}
            disabled={pending}
            aria-disabled={textReady ? undefined : true}
            className={`${CHOICE_CLS} ${textReady ? "border-slate-300 bg-white text-slate-800 hover:bg-slate-50" : "border-dashed border-slate-300 bg-white text-slate-400"}`}
          >
            {pending && how === "text" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />} Text It
          </button>
        </div>
        {!textReady && <p className="text-xs text-slate-500">{TEXT_NOT_READY_REFUSAL}</p>}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {p.openHref && (
          <Link href={p.openHref} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
            Open It First
          </Link>
        )}
      </div>
    </Modal>
  );
}

/**
 * The sheet with its own trigger: the header's primary "Send $1,572.27", a ⋯ row (Send Again), or
 * an outline button inside a notice. `label` is the trigger's words.
 */
export function SendButton({
  label,
  variant = "primary",
  className,
  ...p
}: SendSheetProps & { label: string; variant?: "primary" | "outline" | "menuItem"; className?: string }) {
  const [open, setOpen] = useState(false);
  const trigger =
    variant === "menuItem" ? (
      <button type="button" onClick={() => setOpen(true)} className={ACTIONS_ROW_CLS}>
        <Send className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {label}
      </button>
    ) : (
      <Button type="button" variant={variant === "outline" ? "outline" : "primary"} onClick={() => setOpen(true)} className={className}>
        <Send className="h-4 w-4" /> {label}
      </Button>
    );
  return (
    <>
      {trigger}
      <SendSheet {...p} open={open} onClose={() => setOpen(false)} />
    </>
  );
}