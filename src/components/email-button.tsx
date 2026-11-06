"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquare, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { emailQuote, textQuote } from "@/app/(app)/quotes/actions";
import { emailInvoice, textInvoice } from "@/app/(app)/billing/actions";
import { textNotReadyRefusal } from "@/lib/sms-readiness";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

/** `notReady`: texting isn't set up (lib/sms-readiness). Nothing was sent; the refusal names the
 *  doors that work, and is said as information, not as a failure of his. */
type Result = { ok: boolean; error?: string; notReady?: boolean };

function SendChip({
  label,
  icon: Icon,
  run,
  confirmText,
  successText,
  onDone,
  primary = false,
  notActive,
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
  /** This door can't work yet (texting isn't set up): the chip shows as not active and a tap says
   *  this, where he tapped, with no confirm that promises a send and no trip to the server. */
  notActive?: string;
}) {
  const toast = useToast();
  const t = translator(useLang());
  // Busy state only — success/failure now report through the app-wide toast so a
  // stale green check can't keep claiming "Sent" after the page state moves on.
  const [busy, setBusy] = useState(false);

  async function go() {
    if (notActive) {
      toast(notActive, "info");
      return;
    }
    if (!confirm(confirmText ?? `${label}?`)) return;
    setBusy(true);
    try {
      const res = await run();
      if (!res?.ok) {
        toast(res?.error ?? t("qt_couldntSendTryAgain"), res?.notReady ? "info" : "error");
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
      aria-disabled={notActive ? true : undefined}
      title={notActive}
      className={
        notActive
          ? "inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 text-sm font-medium text-slate-400"
          : primary
          ? "inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-60"
          : "inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
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
  textReady = true,
}: {
  id: string;
  kind: "quote" | "invoice";
  /** Invoice only: customer + amount spelled into the confirm prompt. */
  customerName?: string | null;
  amount?: number | null;
  /** Can this org text (smsReadiness(org).ready, asked by the page)? false: the Text chip shows as
   *  not active and says why when tapped, instead of asking "Text this invoice to Nora?" first. */
  textReady?: boolean;
}) {
  const router = useRouter();
  const lang = useLang();
  const t = translator(lang);
  const isInvoice = kind === "invoice";
  const money =
    amount != null
      ? amount.toLocaleString(undefined, { style: "currency", currency: "USD" })
      : null;
  const who = customerName?.trim() || t("qt_theCustomer");
  // A quote's chips ask "Email?" / "Text?" (the chip's own word and a question mark), said here so
  // the question follows the person's language too.
  const emailConfirm = isInvoice
    ? fillText(t(money ? "qt_confirmEmailInvoiceAmount" : "qt_confirmEmailInvoice"), { money: money ?? "", who })
    : t("qt_confirmEmail");
  const textConfirm = isInvoice
    ? fillText(t(money ? "qt_confirmTextInvoiceAmount" : "qt_confirmTextInvoice"), { money: money ?? "", who })
    : t("qt_confirmText");

  return (
    <div className="flex items-center gap-2">
      <SendChip
        label={isInvoice ? t("qt_btn_sendInvoice") : t("qt_btn_email")}
        icon={Mail}
        primary={isInvoice}
        confirmText={emailConfirm}
        successText={isInvoice ? t("qt_invoiceEmailed") : t("qt_estimateEmailed")}
        onDone={isInvoice ? () => router.refresh() : undefined}
        run={() => (kind === "quote" ? emailQuote(id) : emailInvoice(id))}
      />
      <SendChip
        label={t("qt_btn_text")}
        icon={MessageSquare}
        confirmText={textConfirm}
        successText={isInvoice ? t("qt_invoiceTexted") : t("qt_estimateTexted")}
        notActive={textReady ? undefined : textNotReadyRefusal(lang, t)}
        onDone={isInvoice ? () => router.refresh() : undefined}
        run={() => (kind === "quote" ? textQuote(id) : textInvoice(id))}
      />
    </div>
  );
}
