"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Mail, MessageSquare, Send } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { formatCurrency } from "@/lib/utils";
import { previewSend, sendReviewed } from "@/app/(app)/send-actions";
import { textNotReadyRefusal } from "@/lib/sms-readiness";
import {
  SMS_TOTAL_MAX,
  checkSendMessage,
  smsCount,
  type PreviewResult,
  type SendChannel,
  type SendKind,
  type SendMessage,
  type SendPreview,
} from "@/lib/send-review";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { SENT_MESSAGES_EVENT } from "@/components/sent-messages-list";

/**
 * THE SEND SHEET (W1-26, review mode cn-v1155): one door that puts a bill, an estimate, a contract,
 * a portal link or a receipt in the customer's hands. On open it asks the server for the words it
 * WOULD send (previewSend) and stamps nothing. The company's Send Without Review switch decides what
 * comes next:
 *
 *   on  - the one-tap sheet it always was: the sentence (who, how much, how many lines, "This marks
 *         it Sent" on an invoice) and two 44px choices, Email It and Text It.
 *   off - Email or Text, then the address (editable), the subject (email), the message (editable),
 *         the fixed part that carries the link (read-only), Copy Me (email) and, for a text, how many
 *         texts it makes. Only a field the owner CHANGED goes back; an untouched one stays absent so
 *         the server keeps its own words, and a present blank is refused (lib/send-review).
 *
 * Text keeps its not-ready refusal in place (lib/sms-readiness): shown where the button is, never a
 * promise the server refuses. Nothing sends without Email It or Text It; Cancel changes nothing. The
 * customer reads English whatever the owner's language, and a Spanish owner is told so.
 */
export type SendSheetProps = {
  kind: SendKind;
  id: string;
  number?: string | null;
  customerName?: string | null;
  amount?: number | null;
  /** How many lines go out, when the caller knows (a Needs You row does; the invoice page does). */
  lineCount?: number | null;
  /** smsReadiness(org).ready, from the page. false: Text says why in place and sends nothing. */
  textReady?: boolean;
  /** Adds "Open It First" (the document, to look at before it goes). */
  openHref?: string | null;
  /** Which channel the review opens on (a Text Receipt door opens on Text). Email when absent. */
  via?: "email" | "text";
  /** After a send landed: how it went out. The sheet has already refreshed the page. */
  onSent?: (how: "email" | "text") => void;
};

const NAMES: Record<SendKind, string> = {
  invoice: "sn_thisInvoice",
  receipt: "sn_thisReceipt",
  quote: "sn_thisEstimate",
  contract: "sn_thisContract",
  portal: "sn_thisPortal",
};

/** The one sentence the sheet asks: who, how much, how many lines - and on an invoice, that
 *  sending marks it Sent. Words come from the catalog (English unless a translator is handed). */
export function sendConfirmSentence(
  p: Pick<SendSheetProps, "kind" | "number" | "customerName" | "amount" | "lineCount">,
  t: (key: string) => string = translator("en"),
): string {
  const doc = p.number?.trim() || t(NAMES[p.kind]);
  const who = p.customerName?.trim() || t("sn_theCustomer");
  const money = p.amount != null && Number.isFinite(p.amount) ? fillText(t("sn_forMoney"), { amount: formatCurrency(Number(p.amount)) }) : "";
  const lines =
    p.lineCount != null && p.lineCount >= 0 ? (p.lineCount === 1 ? t("sn_oneLine") : fillText(t("sn_nLines"), { n: String(p.lineCount) })) : "";
  const sentence = fillText(t("sn_confirm"), { doc, money, lines, who });
  return p.kind === "invoice" ? `${sentence} ${t("sn_marksSent")}` : sentence;
}

/** What the owner typed, per channel. */
export type ReviewFields = { to: string; subject: string; body: string; copyMe: boolean };

/**
 * THE MESSAGE THE SHEET SENDS BACK: only the fields he CHANGED (an unchanged one stays absent so the
 * server keeps its own words), run through the same check the server runs. A refusal comes back as
 * the catalog key of its sentence.
 */
export function reviewMessage(
  preview: SendPreview,
  channel: SendChannel,
  f: ReviewFields,
): { ok: true; message: SendMessage } | { ok: false; key: string } {
  const msg: SendMessage = {};
  const to = f.to.trim();
  if (to !== ((channel === "email" ? preview.to : preview.phone) ?? "").trim()) msg.to = to;
  if (channel === "email" && f.subject.trim() !== preview.subject.trim()) msg.subject = f.subject;
  if (f.body.trim() !== (channel === "email" ? preview.body : preview.smsBody).trim()) msg.body = f.body;
  if (channel === "email" && f.copyMe !== preview.copyMe) msg.copyMe = f.copyMe;
  const check = checkSendMessage(msg, channel, (channel === "email" ? preview.tail.email : preview.tail.sms).length);
  if (check.ok) return { ok: true, message: check.message };
  const key =
    check.why === "to" ? (channel === "email" ? "sn_badEmail" : "sn_badPhone") : check.why === "subject" ? "sn_badSubject" : check.why === "body" ? "sn_badBody" : "sn_tooLong";
  return { ok: false, key };
}

const CHOICE_CLS =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold disabled:opacity-60";
const FIELD_CLS = "w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900";
const LABEL_CLS = "mb-1 block text-xs font-medium text-slate-600";
const FORM_ID = "send-review-form";

/** The sheet asks for today's words each time it opens (nothing is written by asking), then hands them
 *  to the view, which starts from them. A fresh `round` remounts the view so its fields start clean. */
export function SendSheet({ open, onClose, ...p }: SendSheetProps & { open: boolean; onClose: () => void }) {
  const t = translator(useLang());
  const [asked, setAsked] = useState<PreviewResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setAsked(null);
    previewSend(p.kind, p.id)
      .catch((): PreviewResult => ({ ok: false, error: t("sn_noReach") }))
      .then((res) => {
        if (!live) return;
        setAsked(res ?? { ok: false, error: t("sn_didntSend") });
      });
    return () => {
      live = false;
    };
    // Asked on open and on a change of document; the language only re-words an error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, p.kind, p.id]);

  // ONE VIEW FOR THE WHOLE OPEN, NEVER REMOUNTED (no key). The view holds the one Modal, and a Modal
  // that remounts while open closes itself: the old instance steps history back to take its entry
  // off, the new instance has just pushed its own, and that step pops the NEW entry, which the new
  // instance reads as the system Back (overlay-history). cn-v1155 keyed the view on the answer's
  // round so its fields would start clean, and the sheet flashed and was gone before anyone could
  // read it (Erik, INV-093, 2026-11-08). The view resets its own fields when a new answer lands.
  return <SendSheetView {...p} open={open} onClose={onClose} asked={asked} />;
}

/**
 * The fields the review starts from: the server's words once it answered, blank while it is still
 * asking or when it failed; Text first only when the door asked for Text and texting is set up.
 */
export function fieldsFrom(preview: SendPreview | null, via: "email" | "text" | undefined, textReady: boolean) {
  return {
    channel: (via === "text" && textReady ? "sms" : "email") as SendChannel,
    emailTo: preview?.to ?? "",
    phoneTo: preview?.phone ?? "",
    subject: preview?.subject ?? "",
    emailBody: preview?.body ?? "",
    smsBody: preview?.smsBody ?? "",
    copyMe: preview?.copyMe ?? false,
  };
}

/** The sheet itself, drawn from the server's answer (null while it is on its way). */
export function SendSheetView({
  open,
  onClose,
  asked,
  ...p
}: SendSheetProps & { open: boolean; onClose: () => void; asked: PreviewResult | null }) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const [pending, start] = useTransition();
  const [how, setHow] = useState<"email" | "text" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = asked?.ok ? asked.preview : null;
  const textReady = p.textReady !== false;
  const fresh = fieldsFrom(first, p.via, textReady);
  const [channel, setChannel] = useState<SendChannel>(fresh.channel);
  const [emailTo, setEmailTo] = useState(fresh.emailTo);
  const [phoneTo, setPhoneTo] = useState(fresh.phoneTo);
  const [subject, setSubject] = useState(fresh.subject);
  const [emailBody, setEmailBody] = useState(fresh.emailBody);
  const [smsBody, setSmsBody] = useState(fresh.smsBody);
  const [copyMe, setCopyMe] = useState(fresh.copyMe);
  // A NEW ANSWER STARTS THE FIELDS CLEAN, IN PLACE. The sheet asks again each time it opens, and the
  // asking (null) and then the answer arrive as a new `asked`; the fields follow it here, during the
  // render, so the Modal stays mounted (see SendSheet). React's own pattern for state that follows a
  // prop: set it while rendering, and the render is redone before anything is shown.
  const [seen, setSeen] = useState<PreviewResult | null>(asked);
  if (asked !== seen) {
    setSeen(asked);
    setChannel(fresh.channel);
    setEmailTo(fresh.emailTo);
    setPhoneTo(fresh.phoneTo);
    setSubject(fresh.subject);
    setEmailBody(fresh.emailBody);
    setSmsBody(fresh.smsBody);
    setCopyMe(fresh.copyMe);
    setError(null);
    setHow(null);
  }

  const preview: SendPreview | null = asked?.ok ? asked.preview : null;
  const refusal = textNotReadyRefusal(lang, t);

  function landed(via: "email" | "text", to: string) {
    toast(fillText(t(via === "email" ? "sn_sentEmail" : "sn_sentText"), { to }), "success");
    onClose();
    // Every Sent Messages list on the page reads again: the record has a new row.
    window.dispatchEvent(new Event(SENT_MESSAGES_EVENT));
    p.onSent?.(via);
    router.refresh();
  }

  function go(via: "email" | "text", message: SendMessage, to: string) {
    setError(null);
    setHow(via);
    start(async () => {
      const res = await sendReviewed(p.kind, p.id, via === "email" ? "email" : "sms", message).catch(() => ({
        ok: false as const,
        error: t("sn_noReach"),
      }));
      setHow(null);
      if (!res?.ok) {
        // Said where it was tapped, and the sheet stays: the send didn't happen.
        setError(res?.error ?? t("sn_didntSend"));
        return;
      }
      landed(via, to);
    });
  }

  /** The one-tap path (Send Without Review is on): nothing to edit, the server's own words go. */
  function sendOneTap(via: "email" | "text") {
    if (via === "text" && !textReady) {
      // In place, not a trip to the server: texting isn't set up, so nothing can go.
      toast(refusal, "info");
      return;
    }
    go(via, {}, (via === "email" ? preview?.to : preview?.phone) || p.customerName || t("sn_theCustomer"));
  }

  /** The reviewed path: only what he changed goes back, checked here the way the server will. */
  function sendReviewedMessage() {
    if (!preview) return;
    const via: "email" | "text" = channel === "email" ? "email" : "text";
    if (via === "text" && !textReady) {
      toast(refusal, "info");
      return;
    }
    const to = (channel === "email" ? emailTo : phoneTo).trim();
    const check = reviewMessage(preview, channel, { to, subject, body: channel === "email" ? emailBody : smsBody, copyMe });
    if (!check.ok) {
      setError(t(check.key));
      return;
    }
    go(via, check.message, to);
  }

  const openFirst = p.openHref ? (
    <Link href={p.openHref} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
      {t("sn_btn_openFirst")}
    </Link>
  ) : null;
  const errorBox = error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null;

  let body: React.ReactNode;
  let footer: React.ReactNode = undefined;
  let title = t(`sn_title_${p.kind}`);

  if (!asked) {
    body = (
      <p className="flex items-center gap-2 text-sm text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("sn_loading")}
      </p>
    );
  } else if (!preview) {
    // The preview itself failed: its sentence, in the error box, and a way out.
    body = (
      <div className="space-y-3">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{asked.ok ? "" : asked.error}</p>
        <button type="button" onClick={onClose} className={`${CHOICE_CLS} border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>
          {t("sn_btn_cancel")}
        </button>
      </div>
    );
  } else if (preview.reviewOff) {
    // TODAY'S PATH, unchanged in words and taps.
    body = (
      <div className="space-y-4">
        <p className="text-sm text-slate-700">{sendConfirmSentence(p, t)}</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => sendOneTap("email")}
            disabled={pending}
            className={`${CHOICE_CLS} border-transparent bg-[rgb(var(--glass-ink))] text-white hover:bg-[rgb(var(--glass-ink))]/90`}
          >
            {pending && how === "email" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} {t("sn_btn_emailIt")}
          </button>
          <button
            type="button"
            onClick={() => sendOneTap("text")}
            disabled={pending}
            aria-disabled={textReady ? undefined : true}
            className={`${CHOICE_CLS} ${textReady ? "border-slate-300 bg-white text-slate-800 hover:bg-slate-50" : "border-dashed border-slate-300 bg-white text-slate-400"}`}
          >
            {pending && how === "text" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />} {t("sn_btn_textIt")}
          </button>
        </div>
        {!textReady && <p className="text-xs text-slate-500">{refusal}</p>}
        {errorBox}
        {openFirst}
      </div>
    );
  } else {
    const isEmail = channel === "email";
    const to = isEmail ? emailTo : phoneTo;
    const prefill = isEmail ? preview.body : preview.smsBody;
    const text = isEmail ? emailBody : smsBody;
    const tail = isEmail ? preview.tail.email : preview.tail.sms;
    const count = smsCount(text, preview.tail.sms.length);
    const tooLong = !isEmail && count.chars > SMS_TOTAL_MAX;
    title = t(isEmail ? "sn_title_email" : "sn_title_text");
    const canText = textReady && preview.textReady !== false;
    const greetingName = (preview.customerName ?? p.customerName ?? "").trim();
    body = (
      <form
        id={FORM_ID}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          sendReviewedMessage();
        }}
      >
        <p className="text-sm text-slate-700">{sendConfirmSentence(p, t)}</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setChannel("email")}
            aria-pressed={isEmail}
            className={`${CHOICE_CLS} ${isEmail ? "border-transparent bg-[rgb(var(--glass-ink))] text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
          >
            <Mail className="h-4 w-4" /> {t("sn_channelEmail")}
          </button>
          <button
            type="button"
            onClick={() => (canText ? setChannel("sms") : toast(refusal, "info"))}
            aria-pressed={!isEmail}
            aria-disabled={canText ? undefined : true}
            className={`${CHOICE_CLS} ${!isEmail ? "border-transparent bg-[rgb(var(--glass-ink))] text-white" : canText ? "border-slate-300 bg-white text-slate-800 hover:bg-slate-50" : "border-dashed border-slate-300 bg-white text-slate-400"}`}
          >
            <MessageSquare className="h-4 w-4" /> {t("sn_channelText")}
          </button>
        </div>
        {!canText && <p className="text-xs text-slate-500">{refusal}</p>}

        <div>
          <label htmlFor="send-to" className={LABEL_CLS}>
            {t("sn_to")}
          </label>
          <input
            id="send-to"
            type={isEmail ? "email" : "tel"}
            autoComplete={isEmail ? "email" : "tel"}
            value={to}
            onChange={(e) => (isEmail ? setEmailTo(e.target.value) : setPhoneTo(e.target.value))}
            className={`${FIELD_CLS} h-11`}
          />
          {!to.trim() && <p className="mt-1 text-xs text-amber-700">{t(isEmail ? "sn_noEmail" : "sn_noPhone")}</p>}
        </div>

        {isEmail && (
          <div>
            <label htmlFor="send-subject" className={LABEL_CLS}>
              {t("sn_subject")}
            </label>
            <input id="send-subject" type="text" autoComplete="off" value={subject} onChange={(e) => setSubject(e.target.value)} className={`${FIELD_CLS} h-11`} />
          </div>
        )}

        <div>
          <label htmlFor="send-body" className={LABEL_CLS}>
            {t("sn_message")}
          </label>
          {/* The greeting the email renderer prints above the words, read-only: the customer reads it in English. */}
          {isEmail && greetingName && <p className="mb-1 text-sm text-slate-600">{fillText(t("sn_greetingPreview"), { name: greetingName })}</p>}
          <textarea
            id="send-body"
            rows={5}
            value={text}
            onChange={(e) => (isEmail ? setEmailBody(e.target.value) : setSmsBody(e.target.value))}
            className={`${FIELD_CLS} py-2`}
          />
          {text.trim() !== prefill.trim() && (
            <button
              type="button"
              onClick={() => (isEmail ? setEmailBody(prefill) : setSmsBody(prefill))}
              className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
            >
              {t("sn_btn_todaysWords")}
            </button>
          )}
        </div>

        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <p className="whitespace-pre-wrap break-words text-xs text-slate-600">{tail}</p>
          <p className="mt-1 text-xs text-slate-500">{t("sn_fixedTail")}</p>
        </div>

        {isEmail ? (
          preview.copyTo ? (
            <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={copyMe} onChange={(e) => setCopyMe(e.target.checked)} className="h-5 w-5" />
              <span>
                {t("sn_copyMe")} <span className="text-xs text-slate-500">{fillText(t("sn_copyTo"), { email: preview.copyTo })}</span>
              </span>
            </label>
          ) : null
        ) : (
          <p className="text-xs text-slate-500">{t("sn_noCopyText")}</p>
        )}

        {!isEmail && (
          <p className={`text-xs ${tooLong ? "text-red-700" : "text-slate-500"}`}>
            {tooLong ? t("sn_tooLong") : fillText(t("sn_counter"), { chars: String(count.chars), texts: String(count.texts) })}
          </p>
        )}
        {preview.viewerLang === "es" && <p className="text-xs text-slate-500">{t("sn_customerReadsEnglish")}</p>}
        {errorBox}
        {openFirst}
      </form>
    );
    footer = (
      <ModalActions
        onCancel={onClose}
        submit
        formId={FORM_ID}
        saving={pending}
        disabled={pending || !to.trim() || tooLong || (!isEmail && !canText)}
        saveLabel={pending ? t("sn_sending") : t(isEmail ? "sn_btn_emailIt" : "sn_btn_textIt")}
        cancelLabel={t("sn_btn_cancel")}
      />
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" portal holdOpen={pending} footer={footer}>
      {body}
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