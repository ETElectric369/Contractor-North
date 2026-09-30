"use client";

/* eslint-disable @next/next/no-img-element -- the QRs are data URLs and the Tap to Pay symbol is a 4KB static PNG; next/image adds nothing */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeDollarSign, Check, Copy, Loader2, Mail, MessageSquare, QrCode, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { useToast } from "@/components/toast";
import { collectArtifacts, emailInvoice, invoiceCollectStatus, recordPayment, settleUp, textInvoice, venmoQrFor } from "@/app/(app)/billing/actions";
import { invoiceBalance } from "@/lib/invoice-math";
import { sendFirstDetail, sendFirstQuestion } from "@/lib/pay-door-words";
import { TEXTS_NOT_READY_LINE } from "@/lib/sms-readiness";
import { paymentMethodKey } from "@/lib/payment-method";
import { cancelTapPaymentIntent, createTapPaymentIntent, tapPaymentVerdict, tapToPayContext, type TapPaymentVerdict } from "@/app/(app)/billing/tap-actions";
import {
  cancelTapPayment,
  collectTapPayment,
  enableTapToPay,
  noteTapIdentity,
  onTapProgress,
  showHowToTap,
  tapToPayAccountLinked,
  tapToPayDeviceStatus,
  tapToPayPluginPresent,
  type TapProgress,
} from "@/lib/native-tap";

/**
 * ONE GET PAID SHEET (W1-26, 2026-09-27). Pay Now and Record Payment were two buttons with two sheets
 * side by side on the invoice, the job hub and the visit; they are two PANELS of one sheet now, "Get
 * Paid $<balance>", with their state machines composed exactly as they were (the gen / closed-sheet
 * guard, ensureInvoice, settleUp at the doorstep, venmoQrFor writing nothing). Top to bottom:
 *
 *   1. the card, only where the company takes cards: Tap to Pay FIRST - primary, full width, on the
 *      first paint, never greyed (Apple 5.1/5.2/5.3) - then Show Card QR / Text The Pay Link, which
 *      watches until the webhook writes the payment;
 *   2. "Or They Paid Another Way": the amount, the company's non-card methods, Date Paid and Note,
 *      saved with Record It (Venmo keeps Show Venmo QR);
 *   3. the sentences a person must read before money moves: the draft's "Send INV-0xx as the bill
 *      first?" and a bank transfer on its way ("don't record it by hand").
 *
 * What follows is the history of the two halves, kept because every rule in it still holds.
 *
 * TWO VERBS, SPLIT BY WHERE THE MONEY MOVES (Erik 2026-09-10: "the pay now button should have the
 * credit card stuff and the record payment is everything else").
 *
 *   PAY NOW         → card. Opens the CARD CONTROL SCREEN: the balance, a QR the customer scans
 *                     into Stripe checkout on their phone, the same link to text or copy — and then
 *                     it WATCHES, polling the invoice until the webhook writes the payment, so the
 *                     tech sees "Paid" land without refreshing. TAP TO PAY sits ON TOP of the QR
 *                     (Erik 2026-09-10; Apple 5.2) on a phone that can do it: the iPhone is the
 *                     reader, the customer holds their card to it, the same webhook writes the
 *                     same row. The button exists only where src/lib/native-tap.ts says yes —
 *                     nowhere else is anything different.
 *   RECORD PAYMENT  → everything else. Cash, check, transfer, Venmo. Money that moves outside
 *                     Stripe and has to be written down by a person, with the date it happened
 *                     and a note (check #). Venmo shows the org's QR right here, then "They paid".
 *
 * Both are SHEETS, both the same size, both in the same row — the invoice header, the job hub,
 * the appointment page. They used to be one inline widget with five chips that defaulted to
 * Cash → "Record It", sitting INSIDE the invoice page's own record-payment form: two amount
 * boxes, two record buttons, one card, and a "Card" chip that either charged nothing or built a
 * QR onto a draft's read-only view.
 *
 * Two mounting modes, one plumbing:
 *   source: appointment/job — settles the chain first (invoice + line + sent + visit completed +
 *                             lead won) via settleUp, then collects.
 *   source: invoice         — the invoice exists; collect against its balance.
 *
 * APPLE'S CHECKOUT LAWS THIS SCREEN CARRIES (Tap to Pay on iPhone App Requirements v1.7, 2026-09-11):
 *   5.1/5.2  Tap to Pay is the FIRST option, primary, full width, no scrolling: on top of the QR
 *            button before the QR exists, on top of the QR itself once it does. In the iPhone
 *            app an invoice no longer builds its QR on open — the phone is the reader first and
 *            the QR is one press away; off the shell (web, PWA) the QR is the only card door and
 *            still builds on open.
 *   5.3      never greyed out. Pressing it before the company has accepted Apple's terms opens
 *            them (3.5/3.7) for an owner/admin; anyone else is told to ask one (3.8/3.8.1).
 *   4.2      terms accepted from this screen → Apple's own how-to sheet (showHowToTap) comes up
 *            before the card does; where that sheet can't (iOS < 18), the card comes anyway.
 *   5.4/5.5  the button says "Tap to Pay" (Apple's short form) and wears Apple's own symbol,
 *            wave.3.right.circle.fill — every sentence around it says "Tap to Pay on iPhone".
 *   5.7/5.8  live "initializing" progress from the bridge while the phone is being configured,
 *            a "processing" line while Stripe confirms.
 *   5.9/5.10 the outcome is named — approved, declined, timed out — and a receipt can be sent
 *            for a paid OR a declined tap: a text from the business's SMS service, the business's
 *            email, the iOS share sheet, the QR of the paid invoice.
 *   1.4      an iOS too old for it is told to update, in place of the button.
 *
 * A CLOSED SHEET TAPS NOTHING. Every async step here belongs to one OPEN of the sheet (`gen`,
 * below); the reader answering, Apple's terms or guide sheet closing, a PaymentIntent arriving —
 * after the person hit Done — finds the number moved and stops, silently, where it is.
 */
type Mode =
  | { source: "appointment" | "job"; id: string; invoiceId?: never; balance?: never }
  | { source: "invoice"; invoiceId: string; balance: number; id?: never };

type Art = { payUrl?: string; invoiceUrl?: string; payQr?: string; venmoQr?: string; venmoHandle?: string; balance?: number; invoiceNumber?: string | null };

/**
 * THE DOOR: the PaymentIntent this screen is holding open on the tenant's Stripe account.
 * `amount` is integer CENTS straight off the mint — Stripe's own copy of what this card will be
 * charged, and therefore the ONLY figure allowed to reach the card prompt. Anything else (the
 * balance the page was rendered with, a number captured before Apple's sheets went up) is a
 * figure that can have moved since.
 */
type TapDoor = { invoiceId: string; clientSecret: string; paymentIntentId: string; amount: number };

/**
 * How a tap ended when it didn't go through (Apple 5.9 wants approved / declined / timed out
 * named; the rest is our own bookkeeping for what to offer next):
 *   declined     the card said no — Try Again on the same PaymentIntent, and a receipt (5.10)
 *   timed-out    the bridge's clock ran out (its sentence says at which stage) — Try Again
 *   failed       the reader/SDK refused mid-flow — the sentence names the fix
 *   not-enabled  Apple's terms aren't accepted for this company and this person can't accept them
 *   setup        it never reached the card (no invoice, no PaymentIntent, terms declined)
 */
type TapOutcome = "declined" | "timed-out" | "failed" | "not-enabled" | "setup";

/** Where a tap is: nothing / the phone is at it (`phase` says who owns the screen — the reader,
 *  Apple's terms sheet, or Apple's how-to guide right after the terms) / the phone said the card
 *  went through and the webhook is writing it (`stripe` says whether Stripe itself agreed;
 *  `slow` that the webhook is taking longer than it should) / it stopped, with the sentence
 *  that says why. */
export type TapState =
  | { kind: "idle" }
  | { kind: "busy"; label: string; phase: "pay" | "enable" | "guide" }
  | { kind: "confirmed"; paymentIntentId: string; stripe: "charged" | "unchecked"; since: number; slow: boolean }
  | { kind: "error"; error: string; outcome: TapOutcome };

/** How long "Card approved" may wait on the webhook before the screen says it is slow. */
const WEBHOOK_SLOW_MS = 60_000;

/**
 * THE PHONE'S "CONFIRMED" IS NOT A CHARGE (Rich Seiler, INV-083, 2026-09-29).
 *
 * The bridge answers ok when the plugin's confirm call resolves, and the plugin resolves without
 * reading the intent's status — so this screen said "Card approved — recording it on the
 * invoice…" for a $420 charge Stripe never made, and sat on that spinner until Rich paid by the
 * link an hour later. Stripe is the only one who knows, so Stripe is asked (tapPaymentVerdict)
 * the moment the phone says confirmed, and again every few seconds while the webhook is awaited.
 * This turns Stripe's answer into the screen: what to show, and whether to keep the door.
 *
 *   charged      Stripe has the money: the webhook writes it, the watch flips the screen. The
 *                door is let go of (nothing to cancel; Stripe refuses anyway). Past WEBHOOK_SLOW_MS
 *                the screen says so, with the payment id, so the office can act instead of wait.
 *   not_charged  The intent is still waiting for a card: nothing was taken. The SAME door stays
 *                (Try Again re-uses it, exactly like a decline) and the sentence says the truth.
 *   cancelled    Stripe let it go: nothing was taken, and a fresh door is needed.
 *   unreadable   (null / a failed read) The phone's word stands, said as the phone's word, not as
 *                Stripe's; the door is kept so a close still cancels an intent nobody charged.
 */
export function tapConfirmedNext(
  paymentIntentId: string,
  v: TapPaymentVerdict | null,
  since: number,
  now: number,
): { tap: TapState; keepDoor: boolean } {
  const slow = now - since >= WEBHOOK_SLOW_MS;
  if (v?.ok && v.verdict === "not_charged") {
    return {
      keepDoor: true,
      tap: {
        kind: "error",
        outcome: "failed",
        error: `The phone said the card was read, but Stripe never charged it (Stripe: ${v.status.replace(/_/g, " ")}). Nothing was taken. Try Again takes the same card again, or send them the pay link.`,
      },
    };
  }
  if (v?.ok && v.verdict === "cancelled") {
    return {
      keepDoor: false,
      tap: {
        kind: "error",
        outcome: "failed",
        error: "Stripe let this payment go before the card was charged. Nothing was taken. Press Tap to Pay to start a new one.",
      },
    };
  }
  if (v?.ok) return { keepDoor: false, tap: { kind: "confirmed", paymentIntentId, stripe: "charged", since, slow } };
  return { keepDoor: true, tap: { kind: "confirmed", paymentIntentId, stripe: "unchecked", since, slow } };
}

/** The receipt door (Apple 5.10): the public invoice link and what the text names. null = not
 *  fetched yet for this open of the screen. */
type Receipt = { link: string; business: string; invoiceNumber: string | null } | { error: string };

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The last thing WE say before Apple owns the screen, and it carries the figure read straight off
 * the PaymentIntent — never off a balance captured earlier in the flow. A label built from a
 * stale number is how a tech reads "$500" aloud while the reader is armed for something else.
 */
export const holdCardLine = (cents: number) => `Hold their card to the top of the phone: ${money(cents / 100)}`;

/** What invoiceCollectStatus answers with: the one row this screen re-checks the money against. */
type LiveBalance = { ok: boolean; total?: number; amountPaid?: number } | null;

/**
 * IS THIS DOOR STILL GOOD FOR WHAT THE INVOICE SAYS RIGHT NOW? To the cent, or it isn't.
 *
 * A read that didn't answer is FALSE, not true: not knowing what the invoice says is not the same
 * as knowing it agrees, and the cost of being wrong here is a card charged a figure nobody typed.
 * The door is cheap to replace (one Stripe call); the wrong charge is not.
 */
export function doorAmountStillMatches(cents: number, live: LiveBalance): boolean {
  if (!live?.ok) return false;
  return Math.round(invoiceBalance(live.total, live.amountPaid) * 100) === cents;
}

/** Apple 3.8.1, word for word what a non-admin needs to hear. */
const ASK_ADMIN = "Ask an owner or admin to enable Tap to Pay on iPhone first.";
/** Apple 1.4, in place of the button on an iPhone whose iOS can't run it. */
const UPDATE_IOS = "Update iOS to use Tap to Pay on iPhone.";

/**
 * The bridge returns sentences, not codes (native-tap.ts: the plugin drops the SDK's code), so
 * the outcome is read off its own words: "declined" is the decline sentence's word, "stuck at:"
 * is the timeout's. A rewording there degrades to "failed" — the sentence still shows, Try Again
 * still works from the Tap to Pay button.
 */
function outcomeOf(error: string): TapOutcome {
  if (/\bdeclined\b/i.test(error)) return "declined";
  if (/stuck at:/i.test(error)) return "timed-out";
  return "failed";
}

/**
 * SF Symbol `wave.3.right.circle.fill` — the one symbol Apple permits on a Tap to Pay on iPhone
 * button (Apple 5.5; HIG "Tap to Pay on iPhone"). The symbol is Apple's: the Xcode SLA permits
 * SF Symbols in apps on Apple platforms, and this control only ever renders inside the iOS app
 * (`tapOk` needs the shell's bridge). A WKWebView can't load SF Symbols — no installed font
 * carries the private-use glyphs — so /tap-to-pay-symbol.png is the system font's OWN rendering
 * of the symbol (AppKit, 96×96, white on transparent): never redrawn, never recoloured, never an
 * approximation. White is why it lives ONLY inside the primary (dark) Tap to Pay button. 16px to
 * sit level with the lucide icons beside it — Button's [&_svg]:size-4 doesn't reach an <img>,
 * hence the classes here.
 */
function TapToPayGlyph() {
  return <img src="/tap-to-pay-symbol.png" alt="" aria-hidden="true" width={16} height={16} className="h-4 w-4 shrink-0" draggable={false} />;
}

/** Mint (and send) the invoice a visit/job is being collected on; a plain pass-through for an
 *  invoice source. `collect: "later"` leaves the balance open for the card/Venmo door. */
async function ensureInvoice(
  props: Mode,
  method: string,
  collect: "record" | "later",
  amount: number,
  note: string,
  paidAt: string | null,
  toast: (m: string, k?: "success" | "error" | "info") => void,
  onOtherInvoice: (id: string) => void,
  /** The card door on a job whose open bill is a draft: the person has said yes to sending it. */
  sendIt = false,
  /** The server asked "Send INV-0xx as the bill first?" — the sheet asks the person, nothing moved. */
  onNeedsSend?: (invoiceNumber: string | null) => void,
): Promise<string | null> {
  if (props.source === "invoice") {
    if (collect === "record") {
      const r = await recordPayment({ invoice_id: props.invoiceId, amount, method, note, paid_at: paidAt });
      if (!r.ok) { toast(r.error ?? "Couldn't record that.", "error"); return null; }
    }
    return props.invoiceId;
  }
  const res = await settleUp({ source: props.source, id: props.id, amount, method, note, collect, sendIt }).catch(() => ({
    ok: false as const,
    error: "That didn't reach the server — check your connection and try again.",
  }));
  if (!res.ok) {
    if ("needsSend" in res && res.needsSend && onNeedsSend) {
      onNeedsSend(("invoiceNumber" in res ? res.invoiceNumber : null) ?? null);
      return null;
    }
    toast(res.error ?? "Couldn't settle that.", "error");
    if ("invoiceId" in res && res.invoiceId) onOtherInvoice(res.invoiceId);
    return null;
  }
  return res.invoiceId ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PAY NOW — the card control screen
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the busy screen says, from the bridge's live progress (Apple 5.7: an "initializing"
 * screen while the phone is still being configured; 3.9.1: the SDK's own percent while it is;
 * 5.8: a "processing" line after the card is read). The stage strings are native-tap.ts's
 * published vocabulary. "ready"/"not ready"/nothing yet fall back to the step's own label.
 */
function busyLine(label: string, p: TapProgress | null): { title: string; detail: string | null; percent: number | null } {
  const stage = p?.stage;
  switch (stage) {
    case "configuring the reader":
      return {
        title: `Getting Tap to Pay on iPhone ready… ${p?.percent ?? 0}%`,
        detail: "Apple is setting this iPhone up as a card reader — the first time takes a minute or two.",
        percent: p?.percent ?? null,
      };
    case "waiting for the tap":
      // Apple owns the screen from here; the label already says to hold the card to the phone.
      return { title: label, detail: null, percent: null };
    case "confirming with Stripe":
      return { title: "Processing the payment…", detail: "Confirming with Stripe — a few seconds.", percent: null };
    case "ready":
    case "not ready":
    case undefined:
      return { title: label, detail: null, percent: null };
    default:
      return { title: "Getting Tap to Pay on iPhone ready…", detail: stage ? `${stage[0].toUpperCase()}${stage.slice(1)}…` : null, percent: null };
  }
}

/**
 * THE RECEIPT ROW (Apple 5.10: "regardless of whether a transaction is approved or declined, it
 * must be possible to send a confidential digital receipt"; the review checklist counts a text
 * only when it comes "from a SMS service, not from the merchant phone number", an email only
 * from an email service, and "iOS Share" as a method of its own). Every door lands on the same
 * public invoice page — the paid invoice IS the receipt; a declined one is the record that
 * nothing was charged and the bill is still open:
 *   Text Receipt          textInvoice — the business's own SMS service, to the customer's number
 *                         on file. Its body is the invoice line + link, which on a paid invoice
 *                         reads "balance $0.00" and lands on the receipt. A customer with no
 *                         number is said so in one line, and the door becomes Text From This
 *                         Phone.
 *   Text From This Phone  this phone's Messages, body = one line (business, invoice, amount,
 *                         outcome, date) + the link. Same honesty as Text the Link: it goes from
 *                         THIS number.
 *   Email Receipt         emailInvoice — the business's own email service sends the invoice.
 *   Share                 navigator.share — the iOS share sheet (Apple's "Activity view"):
 *                         AirDrop, Mail, Messages, whatever the customer is standing next to.
 *                         Hidden where there is no share sheet.
 *   Show QR               only on a PAID invoice, and only when the pay QR already exists:
 *                         /api/pay on a zero balance lands on the invoice page marked paid, so
 *                         the QR that was on this screen a moment ago now scans to the receipt.
 *                         On a declined tap that same QR would open Stripe Checkout — a pay
 *                         door, not a receipt — so it is not offered.
 *
 * DECLINED gets Text From This Phone and Share, NOT the service doors: textInvoice and
 * emailInvoice (deliverInvoiceEmail under it) take an invoice id and nothing else — no message,
 * no note — so through them the customer would get "Invoice 1042, balance $150.00. View/pay:",
 * a bill with no word that their card was refused and nothing charged. Only the two doors that
 * carry OUR sentence can carry the decline. (A `note` on those two actions is the follow-up; it
 * lives in billing/actions.ts, not here.)
 */
function ReceiptRow({
  outcome,
  receipt,
  invoiceId,
  amount,
  qr,
  toast,
  textReady = true,
}: {
  outcome: "paid" | "declined";
  receipt: Receipt | null;
  invoiceId: string;
  amount: number;
  qr?: string;
  toast: (m: string, k?: "success" | "error" | "info") => void;
  /** Can the business text (smsReadiness(org).ready, from the page)? false: the row leads with
   *  Text From This Phone and never offers Text Receipt, which could only refuse. */
  textReady?: boolean;
}) {
  const [texting, setTexting] = useState(false);
  const [texted, setTexted] = useState(false);
  /** The SMS service said this customer has no number: the text door becomes this phone's. */
  const [noPhone, setNoPhone] = useState(false);
  /** The server said texting isn't set up (the page's answer went stale since it rendered). */
  const [notReadySeen, setNotReadySeen] = useState(false);
  /** The business's own text door works: texting is set up, as far as anyone has said. */
  const serviceText = textReady && !notReadySeen;
  const [emailing, setEmailing] = useState(false);
  const [emailed, setEmailed] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  // Read at render, not in an effect: this row only ever mounts on the client, after an outcome
  // (never in the server render), so there is no hydration split to protect against.
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  /** The text door from this phone: the decline always (see above); paid only once the service
   *  has said there is no number to send to. */
  const fromThisPhone = outcome === "declined" || noPhone || !serviceText;
  const offerServiceText = outcome === "paid" && !noPhone && serviceText;

  async function textIt() {
    if (texting) return;
    setTexting(true);
    try {
      const r = await textInvoice(invoiceId);
      if (r.ok) {
        setTexted(true);
        toast("Receipt texted — the paid invoice, from the business's number.", "success");
        return;
      }
      // The one refusal with a door behind it. textInvoice's sentence is the key ("This customer
      // has no phone number."); a rewording there degrades to the plain toast, never to silence.
      if (/no phone/i.test(r.error ?? "")) {
        setNoPhone(true);
        return;
      }
      // Texting isn't set up: say so here, where he tapped, and hand him the door that works.
      if (r.notReady) {
        setNotReadySeen(true);
        toast("Texting isn't set up yet, so the business can't text it. Text From This Phone sends it from yours.", "info");
        return;
      }
      toast(r.error ?? "The text didn't send — open the invoice and send it from there.", "error");
    } catch {
      toast("The text didn't reach the server — check your connection and try again.", "error");
    } finally {
      setTexting(false);
    }
  }

  async function emailIt() {
    if (emailing) return;
    setEmailing(true);
    try {
      const r = await emailInvoice(invoiceId);
      if (r.ok) {
        setEmailed(true);
        toast("Receipt emailed — the paid invoice.", "success");
      } else {
        toast(r.error ?? "The email didn't send — open the invoice and send it from there.", "error");
      }
    } catch {
      toast("The email didn't reach the server — check your connection and try again.", "error");
    } finally {
      setEmailing(false);
    }
  }

  // The one sentence every door from this phone carries: who, which invoice, how much, what
  // happened, when. The link rides separately (the share sheet wants it as `url`).
  let line = "";
  let title = "";
  let link = "";
  if (receipt && "link" in receipt) {
    const who = receipt.business ? `${receipt.business}: ` : "";
    const inv = receipt.invoiceNumber ? `Invoice ${receipt.invoiceNumber}` : "Your invoice";
    link = receipt.link;
    title = `${outcome === "paid" ? "Receipt" : "Card declined"} — ${inv}`;
    line =
      outcome === "paid"
        ? `${who}${inv} — ${money(amount)} paid by card on ${date}. Your receipt:`
        : `${who}${inv} — ${money(amount)} card payment declined on ${date}; nothing was charged. The invoice is still open:`;
  }

  async function shareIt() {
    if (!link) return;
    try {
      await navigator.share({ title, text: line, url: link });
    } catch (e) {
      // Closing the sheet without picking anything rejects with AbortError — that is a choice,
      // not a failure. Anything else is said.
      if (e instanceof Error && e.name === "AbortError") return;
      toast("Couldn't open the share sheet — use Text or Email instead.", "error");
    }
  }

  const note = [
    offerServiceText && "Text Receipt sends from the business’s number.",
    fromThisPhone && "Text From This Phone sends from this phone’s number.",
    outcome === "paid" && "Email Receipt sends from the business’s email.",
    canShare && "Share opens this phone’s share sheet.",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="w-full space-y-2 text-center">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Receipt</div>
      {receipt === null ? (
        <p className="text-xs text-slate-400">Getting the receipt link…</p>
      ) : "error" in receipt ? (
        <p className="text-xs text-rose-600">{receipt.error}</p>
      ) : (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {offerServiceText && (
              <Button size="sm" variant="outline" onClick={() => void textIt()} disabled={texting}>
                {texted ? <Check className="h-4 w-4 text-emerald-600" /> : texting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
                {texted ? "Texted" : texting ? "Sending…" : "Text Receipt"}
              </Button>
            )}
            {fromThisPhone && (
              <a
                href={`sms:?body=${encodeURIComponent(`${line} ${link}`)}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                <MessageSquare className="h-4 w-4" /> Text From This Phone
              </a>
            )}
            {outcome === "paid" && (
              <Button size="sm" variant="outline" onClick={() => void emailIt()} disabled={emailing}>
                {emailed ? <Check className="h-4 w-4 text-emerald-600" /> : emailing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {emailed ? "Emailed" : emailing ? "Sending…" : "Email Receipt"}
              </Button>
            )}
            {canShare && (
              <Button size="sm" variant="outline" onClick={() => void shareIt()}>
                <Share className="h-4 w-4" /> Share
              </Button>
            )}
            {outcome === "paid" && qr && (
              <Button size="sm" variant="outline" onClick={() => setShowQr((v) => !v)}>
                <QrCode className="h-4 w-4" /> {showQr ? "Hide QR" : "Show QR"}
              </Button>
            )}
          </div>
          {noPhone && <p className="text-xs text-slate-500">No phone number on file for this customer — text it from this phone instead.</p>}
          {outcome === "paid" && !noPhone && !serviceText && (
            <p className="text-xs text-slate-500">{TEXTS_NOT_READY_LINE} Until then, text it from this phone.</p>
          )}
        </>
      )}
      {showQr && outcome === "paid" && qr && <img src={qr} alt="Scan for the receipt" className="mx-auto h-40 w-40 rounded-lg" />}
      {note && <p className="text-[11px] text-slate-400">{note}</p>}
    </div>
  );
}

/** The outcome, named (Apple 5.9), with the bridge's sentence and — for a declined or timed-out
 *  card — Try Again on the SAME PaymentIntent (Stripe: re-use it, never mint a second door). */
function TapOutcomeBox({ tap, onRetry }: { tap: Extract<TapState, { kind: "error" }>; onRetry: (() => void) | null }) {
  const heading =
    tap.outcome === "declined"
      ? "Declined"
      : tap.outcome === "timed-out"
        ? "Timed out"
        : tap.outcome === "not-enabled"
          ? "Not enabled yet"
          : "Didn't go through";
  return (
    <div className="w-full space-y-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-left text-sm text-rose-700">
      <div className="font-semibold">{heading}</div>
      <p>{tap.error}</p>
      {/* A timeout is NOT a decline. The clock can run out at "confirming with Stripe" with the
          confirm still landing a moment later — so no receipt that says "nothing was charged",
          no Try Again on a payment that may already be through. The watch is still running: a
          charge that went through flips this screen to Paid on its own. */}
      {tap.outcome === "timed-out" && (
        <p className="text-rose-600">
          If the card was read, this flips to Paid on its own within a minute. If it doesn&rsquo;t, press Tap to Pay again.
        </p>
      )}
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try Again
        </Button>
      )}
    </div>
  );
}

/**
 * THE CARD PANEL'S STATE MACHINE - Pay Now's, composed into the Get Paid sheet unchanged in what it
 * does. `open` is the sheet's; `onOpen` is what the old Pay Now button did when pressed, `reset`
 * what its close did (the sheet itself closes and refreshes); `onDone` closes the sheet (Done after
 * a card is paid).
 */
function useCardDoor(
  props: Mode & {
    /** canAcceptPayments(org) from the page. False = no card panel; nothing is minted, sent or recorded. */
    cardEnabled: boolean;
    /** smsReadiness(org).ready from the page: the receipt row's Text door reads it. */
    textReady?: boolean;
  },
  open: boolean,
  onDone: () => void,
) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [art, setArt] = useState<Art | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(props.source === "invoice" ? props.invoiceId : null);
  const [paid, setPaid] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const balanceRef = useRef<number>(props.source === "invoice" ? props.balance : 0);

  // TAP TO PAY. `tapOk` is DEVICE CAPABILITY, not enablement: true the moment the screen opens
  // on the iPhone app (the plugin's presence on the bridge is a synchronous fact), then taken
  // back only if the phone itself can't — too old a model, too old an iOS (1.4: `tapNote` says
  // "update iOS" where the button stood). So on the web and in the PWA none of this renders,
  // and in the app the button is on the first paint and never greyed (Apple 5.1/5.3): whether
  // the company has accepted Apple's terms is decided when it is PRESSED, not by hiding it.
  // `tapStarted` means a PaymentIntent exists for this open of the screen: the watch below runs
  // from then on, because a tap that Stripe confirmed lands on the invoice through the webhook,
  // not through us.
  const [tapOk, setTapOk] = useState(false);
  const [tapNote, setTapNote] = useState<string | null>(null);
  const [tap, setTap] = useState<TapState>({ kind: "idle" });
  const [tapStarted, setTapStarted] = useState(false);
  const [progress, setProgress] = useState<TapProgress | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  /** The PaymentIntent for THIS open of the screen. A declined card retries on the SAME one —
   *  Stripe re-uses it; a fresh one per attempt would be a second door onto the same balance. */
  const tapPi = useRef<TapDoor | null>(null);
  /** The device probe from opening. ONE SDK conversation at a time from this screen: a tap
   *  pressed before the probe answers waits for it rather than talking over it. */
  const probe = useRef<Promise<void> | null>(null);
  /** Apple 5.6 — the reader's UI within a second of the press. The reader is warm (warmup.tsx);
   *  the other second was ours: minting the PaymentIntent on the press. So on an invoice it is
   *  minted the moment the phone says it can tap, and the press only has the SDK left to do.
   *  A door nobody walked through is cancelled — on close, on unmount, and by the mint itself
   *  when it lands after the sheet has gone. It is minted at the balance of THAT MOMENT, so the
   *  press re-reads the live balance before re-using it: a payment, a credit or an edited line
   *  landing under an open sheet must move the figure on the card, not just the one on screen. */
  const preMint = useRef<Promise<void> | null>(null);
  /** The invoice door in flight or already opened. The QR button and Tap to Pay both need the
   *  bill minted and SENT first; sharing one promise means pressing Tap to Pay while the QR is
   *  still preparing (5.3: it is never disabled) can't settle a visit twice. Cleared when the
   *  mint fails so the next press can try again. */
  const door = useRef<Promise<string | null> | null>(null);
  /** WHICH OPEN of the sheet an async step belongs to. Bumped on OPEN and on CLOSE; every step in
   *  tapToPay / termsGate / prepare reads it back after each await and stops, silently, when it
   *  has moved — so the reader answering after Done, Apple's sheet closing after the person
   *  left, a PaymentIntent arriving late, can't paint a Declined box or arm a card read on a
   *  sheet that isn't there (or on the next one). */
  const gen = useRef(0);

  /**
   * "SEND INV-078 AS THE BILL FIRST?" (Connected North Phase 1). A card is taken on a bill, and a
   * draft becomes a bill when a PERSON sends it — never because a pay sheet opened (INV-069) or a
   * card landed (the webhook used to flip it). Every server door this sheet calls answers a draft
   * with needsSend and writes nothing; the sheet asks here, and only the yes (`sendOk`, for this
   * open of the sheet) goes back with `sendIt`. `then` is what the person was doing when it asked:
   * building the QR, tapping, or the open-time mint.
   */
  const [ask, setAsk] = useState<{ invoiceNumber: string | null; then: "qr" | "tap" } | null>(null);
  /** The open-time mint found a DRAFT (needsSend): no sheet is taken over for it (W1-26) - the one
   *  line under the card buttons says a card asks first, and Tap to Pay / Show Card QR ask. */
  const [draftAtOpen, setDraftAtOpen] = useState<string | null | undefined>(undefined);
  const sendOk = useRef(false);
  /** settleUp's needsSend for a job's open draft, carried out of invoiceDoor to whoever awaited it. */
  const askFromDoor = useRef<string | null | undefined>(undefined);

  function invoiceDoor(): Promise<string | null> {
    if (!door.current) {
      door.current = ensureInvoice(props, "card", "later", 0, "", null, toast, (other) => router.push(`/billing/${other}`), sendOk.current, (n) => {
        askFromDoor.current = n;
      }).then(
        (id) => {
          if (id) setInvoiceId(id);
          else door.current = null;
          return id;
        },
        (e) => {
          door.current = null;
          throw e;
        },
      );
    }
    return door.current;
  }

  /** Build the door: for a visit/job that means minting AND sending the bill first (so it's an
   *  explicit tap, never a side effect of opening the screen); for an invoice it's one read. */
  function prepare() {
    const g = gen.current;
    start(async () => {
      const id = await invoiceDoor();
      // The sheet closed under it: the door (if minted) is kept for the next open, its QR is not.
      if (gen.current !== g) return;
      if (!id) {
        if (askFromDoor.current !== undefined) setAsk({ invoiceNumber: askFromDoor.current, then: "qr" });
        askFromDoor.current = undefined;
        return;
      }
      const a = await collectArtifacts(id, undefined, { sendIt: sendOk.current });
      if (gen.current !== g) return;
      if (!a.ok && a.needsSend) { setAsk({ invoiceNumber: a.invoiceNumber ?? null, then: "qr" }); return; }
      if (!a.ok) { toast(a.error ?? "Couldn't build the payment code.", "error"); return; }
      if (!a.payQr) {
        toast("Card payments aren't switched on yet — Settings → Getting Paid → Set Up Card Payments.", "error");
        return;
      }
      balanceRef.current = a.balance ?? balanceRef.current;
      setArt(a);
    });
  }

  /**
   * PRESSED BEFORE THE COMPANY ACCEPTED APPLE'S TERMS (the bridge refused to connect: notEnabled).
   * Apple 5.3: the press itself opens the terms — for someone allowed to sign them (3.8: owner or
   * admin, the server's word via tapToPayContext), enableTapToPay presents Apple's sheet and the
   * tap resumes when it's accepted. Anyone else gets the 3.8.1 sentence — after Apple's own
   * answer (tapToPayAccountLinked, never a cached flag: 1.6) has confirmed the terms really are
   * unaccepted; a reader that turns out to be on the line means the tap can simply go on.
   *
   * `g` is the open this gate belongs to; "stale" means the sheet closed while Apple's terms (or
   * the role read) were up — the caller stops there, and nothing is painted.
   */
  async function termsGate(bridgeSentence: string, g: number): Promise<"retry" | "stale" | { error: string; outcome: TapOutcome }> {
    const ctx = await tapToPayContext().catch(() => null);
    if (gen.current !== g) return "stale";
    if (ctx?.ok && ctx.canEnable) {
      setTap({ kind: "busy", phase: "enable", label: "Turning on Tap to Pay on iPhone — Apple's terms come up first." });
      const en = await enableTapToPay();
      if (gen.current !== g) return "stale";
      return en.ok ? "retry" : { error: en.error, outcome: "setup" };
    }
    const linked = await tapToPayAccountLinked();
    if (gen.current !== g) return "stale";
    if (linked === true) return "retry";
    if (linked === false) return { error: ASK_ADMIN, outcome: "not-enabled" };
    // Couldn't be known on this build/iOS — the bridge's sentence already names the Settings door.
    return { error: bridgeSentence, outcome: "not-enabled" };
  }

  /** The phone as the reader. Same door-building as the QR for a visit/job (settleUp mints the
   *  bill and sends it, because collecting on a visit means there has to BE a bill), then Stripe's
   *  PaymentIntent on the tenant's account, then the bridge: Apple takes the screen while the
   *  customer holds their card to the phone. On an invoice the door is the invoice itself; a DRAFT
   *  is asked about first ("Send INV-078 as the bill first?") and sent only on the yes. */
  async function tapToPay() {
    const g = gen.current;
    const press = ++tapPress.current;
    /** Has the sheet this tap belongs to closed (or reopened), or was this press cancelled before
     *  its collect began? `armed` = the await we just came back from was the reader's: only the
     *  sheet closing counts then (the reader's own answer decides a Cancel), and the reader is
     *  told to stand down as well; the bridge's cancel is a no-op when nothing is listening. */
    const stale = (armed = false): boolean => {
      const retired = !armed && tapPress.current !== press;
      if (gen.current === g && !retired) return false;
      if (armed) void cancelTapPayment();
      return true;
    };
    const collect = async (door: Parameters<typeof collectTapPayment>[0]) => {
      tapCollecting.current = true;
      try {
        return await collectTapPayment(door);
      } finally {
        tapCollecting.current = false;
      }
    };
    /**
     * THE DOOR ONTO THIS INVOICE, GOOD FOR THE FIGURE THE INVOICE SAYS RIGHT NOW.
     *
     * NEVER CHARGE A FIGURE THE INVOICE NO LONGER SAYS. A PaymentIntent is fixed at the balance
     * of the moment it was minted; a payment landing, a credit applied, a line edited from the
     * office while this sheet sat open leaves the card reading the old number. So the live
     * balance is read before the reader is ever armed and the two must agree to the cent. They
     * don't — or the read didn't answer, which is the same as not knowing — and that door is
     * cancelled and a fresh one minted, which re-reads the balance on the server. One row, no
     * Stripe call: it is the only thing between the press and the reader (5.6).
     *
     * THIS IS A FUNCTION BECAUSE THERE ARE TWO WAYS TO THE READER, NOT ONE. The check used to sit
     * inline at the press, and the second way — the retry after Apple's terms and how-to sheets —
     * walked straight past it, re-using the `pi` captured before any of that happened. That
     * branch only ever runs on a company's FIRST tap, where the connect alone is allowed eight
     * minutes and Apple's guide ten more: a quarter of an hour in which the office does not know
     * this screen is up, and the invoice is exactly the one they're most likely to still be
     * touching. One door-builder, called from both, or the next new way in skips it too.
     *
     * Returns the door, and whether the one we were handed had to be thrown away because the
     * figure had moved. null = it has stopped: the sheet closed (nothing painted), or the mint
     * refused and its sentence is already on the screen.
     */
    async function doorFor(id: string): Promise<{ pi: TapDoor; moved: boolean } | null> {
      let held = tapPi.current;
      let moved = false;
      if (held && held.invoiceId !== id) {
        // A door onto a different invoice: let it go rather than leave it open on the tenant's
        // Stripe account.
        void cancelTapPaymentIntent(held.paymentIntentId).catch(() => {});
        tapPi.current = null;
        held = null;
      }
      if (held) {
        const live = await invoiceCollectStatus(id).catch(() => null);
        if (stale()) return null;
        if (!doorAmountStillMatches(held.amount, live)) {
          void cancelTapPaymentIntent(held.paymentIntentId).catch(() => {});
          tapPi.current = null;
          held = null;
          moved = true;
        }
      }
      if (!held) {
        const r = await createTapPaymentIntent(id, { sendIt: sendOk.current });
        // The sheet went while this was in flight. tapPi was still empty, so close() and the
        // unmount both found nothing to cancel and this intent would sit OPEN on the tenant's
        // Stripe account for good — a card_present door with a customer's invoice on it, live in
        // Erik's dashboard days later. So it cancels itself, the way the open-time mint already
        // does; this one (every job and appointment tap comes through here) never did.
        if (stale()) {
          if (r.ok) void cancelTapPaymentIntent(r.paymentIntentId).catch(() => {});
          return null;
        }
        if (!r.ok && r.needsSend) {
          // A draft: nothing was minted or written. Ask; the yes presses Tap to Pay again with it.
          setTap({ kind: "idle" });
          setAsk({ invoiceNumber: r.invoiceNumber, then: "tap" });
          return null;
        }
        if (!r.ok) { setTap({ kind: "error", error: r.error, outcome: "setup" }); return null; }
        // Who this phone is signed in as, straight off the answer it just got. The bridge keys
        // its page-long caches (the company's Stripe location, the role, the reader itself) to
        // this; a sign-out into another company is a soft transition, so nothing else tells it.
        noteTapIdentity(r.identity);
        held = { invoiceId: id, clientSecret: r.clientSecret, paymentIntentId: r.paymentIntentId, amount: r.amount };
        tapPi.current = held;
        balanceRef.current = r.balance;
      }
      return { pi: held, moved };
    }

    setTap({ kind: "busy", phase: "pay", label: "Getting Tap to Pay on iPhone ready…" });
    try {
      // The device probe from opening may still hold the SDK's turn — let it finish first.
      await probe.current;
      if (stale()) return;
      const id = await invoiceDoor();
      if (stale()) return;
      if (!id) {
        setTap({ kind: "idle" });
        if (askFromDoor.current !== undefined) setAsk({ invoiceNumber: askFromDoor.current, then: "tap" });
        askFromDoor.current = undefined;
        return;
      }
      // The open-time mint may still be in flight — wait for it rather than mint a second door.
      await preMint.current;
      if (stale()) return;
      const first = await doorFor(id);
      if (!first) return;
      let pi = first.pi;
      // THE WATCH RUNS FROM HERE — whichever open minted the door. It used to be switched on
      // only when THIS press minted it; the open-time mint (Apple 5.6) skipped that branch, and a
      // confirmed tap sat on "recording it…" forever while the invoice had long read Paid.
      setTapStarted(true);
      setTap({ kind: "busy", phase: "pay", label: holdCardLine(pi.amount) });
      let c = await collect(pi);
      if (stale(true)) return;
      if (!c.ok && c.notEnabled) {
        const gate = await termsGate(c.error, g);
        if (gate === "stale") return;
        if (gate !== "retry") { setTap({ kind: "error", ...gate }); return; }
        // Apple 4.2: education comes right after the terms — Apple's own how-to sheet, and the
        // card only once the person has closed it (Apple's sheet dismisses, then the reader
        // arms). Its refusal — no guide on iOS < 18, an older shell — is already a sentence for
        // the Settings door; it is no reason to hold up a customer standing there, card out.
        setTap({ kind: "busy", phase: "guide", label: "Apple's guide to Tap to Pay on iPhone is up." });
        const guide = await showHowToTap().catch(() => null);
        if (stale()) return;
        // No guide on this iOS (< 18) or this build: the written steps live in Settings, and the
        // person is told so once, under the card prompt — not a wall, the card is still next.
        if (!guide?.ok) setTapNote("Apple's guide isn't available on this iPhone — the steps are in Settings › Getting Paid › How to Tap.");
        // THE DOOR IS CHECKED AGAIN HERE, and this is the whole reason doorFor exists. Apple's
        // terms sheet and the connect behind it are allowed eight minutes; the how-to guide ten
        // more. The `pi` above was minted before any of that, at the balance of that moment, and
        // this branch is a company's very first tap — the one time the office is still editing.
        // A retry that reuses it charges the old figure at the new invoice.
        const again = await doorFor(id);
        if (!again) return;
        if (again.moved) {
          // NOT silently re-priced. The tech said a number out loud to the person holding the
          // card before Apple's sheet went up; he finds out the bill moved HERE, not from a
          // receipt afterwards. The fresh door is already minted and waiting, so the press he
          // makes next goes straight to the reader. (Apple 5.3: the button is never disabled.)
          setTap({
            kind: "error",
            outcome: "setup",
            error: "The balance changed while Apple's terms were up. Press Tap to Pay again for the new amount.",
          });
          return;
        }
        pi = again.pi;
        setTap({ kind: "busy", phase: "pay", label: holdCardLine(pi.amount) });
        c = await collect(pi);
        if (stale(true)) return;
      }
      if (c.ok) {
        // THE PHONE SAID CONFIRMED; STRIPE IS ASKED BEFORE A PERSON IS TOLD (tapConfirmedNext).
        // The invoice flips when the webhook writes it; the watch sees it land exactly as it does
        // for the QR. The door is let go of only when Stripe says the money is there.
        const since = Date.now();
        const verdict = await tapPaymentVerdict(pi.paymentIntentId).catch(() => null);
        if (stale(true)) return;
        const next = tapConfirmedNext(pi.paymentIntentId, verdict, since, Date.now());
        if (!next.keepDoor) tapPi.current = null;
        setTap(next.tap);
        return;
      }
      if (c.cancelled) { setTap({ kind: "idle" }); return; }
      setTap({ kind: "error", error: c.error, outcome: c.notEnabled ? "not-enabled" : outcomeOf(c.error) });
    } catch (e) {
      if (stale()) return;
      setTap({
        kind: "error",
        error: e instanceof Error && e.message ? e.message : "That didn't reach the server — check your connection and try again.",
        outcome: "setup",
      });
    }
  }

  // THE WATCH. Stripe's webhook writes the payment; nothing on this screen does. Poll the invoice
  // while the QR is up (or a tap has been started) so the person holding the phone sees it land,
  // then stop — a screen that keeps polling after "Paid" is a battery drain in a truck.
  useEffect(() => {
    if (!open || (!art && !tapStarted) || !invoiceId || paid != null) return;
    let live = true;
    const tick = async () => {
      const s = await invoiceCollectStatus(invoiceId).catch(() => null);
      if (!live || !s?.ok) return;
      const left = Math.max(0, (s.total ?? 0) - (s.amountPaid ?? 0));
      if (left <= 0.005 || s.status === "paid") {
        setPaid(s.amountPaid ?? balanceRef.current);
        toast(`Paid — ${money(s.amountPaid ?? balanceRef.current)} by card. Done.`, "success");
        // NO router.refresh() here. The page behind mounts this button only while a balance is
        // owed; refreshing on "paid" re-rendered the header without it, and the Paid screen —
        // the outcome and the receipt row Apple 5.9/5.10 want in front of the person — vanished
        // a second after it appeared (Erik, 2026-09-11: "then cleared"). close() refreshes.
      }
    };
    const timer = setInterval(tick, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [open, art, tapStarted, invoiceId, paid, router, toast]);

  // WHILE "CARD APPROVED" WAITS ON THE WEBHOOK, STRIPE IS ASKED AGAIN (Rich Seiler, INV-083). A
  // read that failed on the press is retried here; a charge that never happened turns the
  // spinner into words with the door still open; a charge the webhook is slow to write is said
  // as slow, with the payment id, after WEBHOOK_SLOW_MS. Stops the moment the invoice reads Paid.
  const confirmedKey = tap.kind === "confirmed" ? `${tap.paymentIntentId}:${tap.stripe}:${tap.slow}` : null;
  useEffect(() => {
    if (!open || tap.kind !== "confirmed" || paid != null) return;
    const { paymentIntentId, since } = tap;
    let live = true;
    const timer = setInterval(async () => {
      const v = await tapPaymentVerdict(paymentIntentId).catch(() => null);
      if (!live) return;
      const next = tapConfirmedNext(paymentIntentId, v, since, Date.now());
      if (!next.keepDoor) tapPi.current = null;
      // Same screen, same words: leave the state alone so this effect isn't restarted for nothing.
      if (next.tap.kind === "confirmed" && next.tap.stripe === tap.stripe && next.tap.slow === tap.slow) return;
      setTap(next.tap);
    }, 6000);
    return () => { live = false; clearInterval(timer); };
    // confirmedKey stands for the parts of `tap` this effect reads; a new object with the same
    // words must not restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, confirmedKey, paid]);

  // THE PROGRESS FEED (Apple 5.7 / 3.9.1). The bridge publishes what the reader is doing — its
  // own stages and the SDK's configuration percent — for the life of the page; this screen
  // listens only while it is open and reads it only while a tap is busy.
  useEffect(() => {
    if (!open) return;
    return onTapProgress(setProgress);
  }, [open]);

  // THE RECEIPT LINK (Apple 5.10), fetched once per open the moment there is an outcome to send —
  // paid, or a tap that was declined or timed out. Two reads: the public token (off the QR's
  // pay URL when the QR was built, else one collectArtifacts) and the business's name for the
  // text (tapToPayContext's merchantDisplayName; its "Invoice payment" fallback is not a name and
  // is left out).
  const wantsReceipt = paid != null || (tap.kind === "error" && tap.outcome === "declined");
  useEffect(() => {
    if (!open || !wantsReceipt || !invoiceId || receipt) return;
    let live = true;
    void (async () => {
      /**
       * A DECLINED TAP MUST NOT SEND THE BILL (INV-069, 2026-09-18).
       *
       * The fallback below asks collectArtifacts for the public pay link, and BUILDING that link
       * is handing the bill over — it promotes a draft on the spot, by design, because a QR in a
       * customer's hand is a delivery. On a paid invoice that promotion has already happened (the
       * webhook moved the row when the money landed), so the call changes nothing. A declined tap
       * charged nothing, and on a draft this would quietly send an invoice the owner is still
       * building — the exact move that cost Erik INV-069, one screen further along. So the draft
       * is read first, and what it gets is a sentence instead of a link: what happened, and what
       * is still his to do.
       */
      if (paid == null && !art?.payUrl) {
        const s = await invoiceCollectStatus(invoiceId).catch(() => null);
        if (!live) return;
        if (s?.ok && s.status === "draft") {
          setReceipt({
            error:
              "Nothing was charged, and this invoice is still a draft, so there's no link to send yet. Finish it and send it when you're ready.",
          });
          return;
        }
      }
      type Door = { invoiceUrl?: string; invoiceNumber: string | null };
      const [got, business] = await Promise.all<[Promise<Door | null>, Promise<string>]>([
        art?.payUrl
          ? Promise.resolve({ invoiceUrl: art.invoiceUrl, invoiceNumber: art.invoiceNumber ?? null })
          : collectArtifacts(invoiceId).then(
              (a) => (a.ok ? { invoiceUrl: a.invoiceUrl, invoiceNumber: a.invoiceNumber ?? null } : null),
              () => null,
            ),
        tapToPayContext().then((c) => (c.ok ? c.merchantDisplayName : ""), () => ""),
      ]);
      if (!live) return;
      const link = got?.invoiceUrl ?? null;
      setReceipt(
        link
          ? { link, business: business === "Invoice payment" ? "" : business, invoiceNumber: got?.invoiceNumber ?? null }
          : { error: "Couldn't get the receipt link — open the invoice and share it from there." },
      );
    })();
    return () => { live = false; };
  }, [open, wantsReceipt, invoiceId, receipt, art, paid]);

  /** Mirrors `tap.kind === "busy"` for the unmount cleanup below, which is written once and can
   *  never see the state through its own closure. */
  const tapBusy = useRef(false);
  /**
   * CANCEL BEFORE THE READER IS ASKED FOR A CARD (review of the 09-23 fix wave). The busy screen
   * shows Cancel from the moment Tap to Pay is pressed, but the press first waits on the device
   * probe (which can sit out a warm-up's connect), the invoice door and the open-time mint. That
   * Cancel only reached the bridge, the bridge reset its flag when the collect began, and the
   * reader armed anyway: Apple's card sheet came up after the person had said stop. Each press
   * gets a number; Cancel retires it, and every await BEFORE the collect checks it. Once
   * collectTapPayment is running the bridge's own cancel decides, because a card read a moment
   * before Cancel is a real charge and has to be reported as one.
   */
  const tapPress = useRef(0);
  const tapCollecting = useRef(false);
  useEffect(() => {
    tapBusy.current = tap.kind === "busy";
  }, [tap]);

  // NAVIGATING AWAY IS CLOSING THE SHEET. The same three things close() does — a new generation,
  // a reader told to stand down, a PaymentIntent nobody walked through let go — minus the
  // refresh, because the page is already leaving. Without it a connect or a card read started
  // here stays armed on the phone, and Apple's card sheet comes up minutes later on whatever
  // screen the person moved to.
  useEffect(() => {
    return () => {
      gen.current += 1;
      if (tapBusy.current) void cancelTapPayment();
      const unused = tapPi.current;
      tapPi.current = null;
      if (unused) void cancelTapPaymentIntent(unused.paymentIntentId).catch(() => {});
    };
  }, []);

  function reset() {
    // The next open is a new generation: every step still awaiting from this one stops on return.
    gen.current += 1;
    // A reader still waiting for a card must not stay armed behind a closed sheet — in ANY busy
    // phase, not only "pay": the tap after Apple's terms or guide sheet re-arms the reader the
    // moment that sheet closes, and the stale check only lands once the collect has answered.
    // The bridge's cancel is a no-op when nothing is listening, so saying it costs nothing.
    if (tap.kind === "busy") void cancelTapPayment();
    // A PaymentIntent that never met a card (minted on open, or a decline nobody retried) is
    // cancelled so the tenant's Stripe doesn't fill with open doors. Confirmed ones are already
    // let go of (tapPi is cleared the moment Stripe says yes); a cancel that arrives after a late
    // confirm is refused by Stripe and logged, never charged twice.
    const unused = tapPi.current;
    if (unused) void cancelTapPaymentIntent(unused.paymentIntentId).catch(() => {});
    setArt(null);
    setPaid(null);
    setCopied(false);
    setTap({ kind: "idle" });
    setTapStarted(false);
    setProgress(null);
    setReceipt(null);
    setAsk(null);
    setDraftAtOpen(undefined);
    sendOk.current = false;
    askFromDoor.current = undefined;
    tapPi.current = null;
    preMint.current = null;
  }

  /**
   * THE YES to "Send INV-078 as the bill first?". The send itself happens on the server, inside the
   * next call (sendIt), through the one send stamp - so it is never a separate write a lost network
   * could split from the payment door it was for. Said out loud either way.
   */
  function sendAndGo() {
    const a = ask;
    if (!a) return;
    sendOk.current = true;
    setAsk(null);
    toast(`Sending ${a.invoiceNumber ?? "the invoice"} as the bill.`, "info");
    if (a.then === "qr") { prepare(); return; }
    void tapToPay();
  }

  const amount = art?.balance ?? balanceRef.current;
  const smsBody = art?.payUrl
    ? encodeURIComponent(`${art.invoiceNumber ? `Invoice ${art.invoiceNumber} — ` : ""}${money(amount)}. Pay by card here: ${art.payUrl}`)
    : "";
  /** Try Again where the same PaymentIntent can take another card: a declined card (Apple 5.9),
   *  and a tap the reader refused before any card was read ("failed": a busy reader, a
   *  connection still finishing, a Stripe session that didn't start) — the PaymentIntent is
   *  untouched either way, and Stripe says re-use it (Erik's 2026-09-16: five refusals in a row,
   *  each one a fresh Pay Now). A timeout may already be through (see TapOutcomeBox); "setup" and
   *  "not enabled" sentences name their own door. */
  const retry = tap.kind === "error" && tapStarted && (tap.outcome === "declined" || tap.outcome === "failed") ? () => void tapToPay() : null;
  const declinedReceipt =
    tap.kind === "error" && tap.outcome === "declined" && invoiceId ? (
      <ReceiptRow outcome="declined" receipt={receipt} invoiceId={invoiceId} amount={balanceRef.current} toast={toast} textReady={props.textReady} />
    ) : null;
  const busy = tap.kind === "busy" ? busyLine(tap.label, progress) : null;

  function onOpen() {
    // A NEW GENERATION and a clean slate. Whatever the last open left — a Declined box, a
    // Confirmed spinner, a receipt link, a PaymentIntent — belongs to that open. close()
    // clears these too; this is for the open that follows a close that never finished, or
    // an outcome that landed between the two.
    const g = ++gen.current;
    setTap({ kind: "idle" });
    setTapStarted(false);
    setProgress(null);
    setReceipt(null);
    setPaid(null);
    setCopied(false);
    setAsk(null);
    sendOk.current = false;
    askFromDoor.current = undefined;
    tapPi.current = null;
    preMint.current = null;
    setDraftAtOpen(undefined);
    if (props.cardEnabled) {
      // Is this the iPhone app? Answered synchronously, so the button is on the first
      // paint (Apple 5.1/5.2). Then: can THIS phone be the reader? Never throws; when it
      // can't answer at all the button stays — a press then gets the bridge's sentence.
      const shell = tapToPayPluginPresent();
      // THE QR IS ONE PRESS AWAY, EVERYWHERE (W1-26). The card panel sits above "Or They Paid
      // Another Way" now, so a 224px code built on open would push the other half of the sheet
      // down for the customer paying cash; Show Card QR builds it (one read on an invoice). A
      // visit/job waits for the explicit tap either way, because building it SENDS a bill.
      setTapOk(shell);
      setTapNote(null);
      probe.current = shell
        ? tapToPayDeviceStatus().then(
            (d) => {
              if (gen.current !== g) return;
              // Apple 5.6: the phone can tap — mint the PaymentIntent now, so the press
              // goes straight to the reader. Invoice source only: a visit/job mints AND
              // sends its bill on the explicit tap, never on open.
              if (d.ok && d.supported && props.source === "invoice") {
                const invId = props.invoiceId;
                // OPENING A SHEET CHANGES NOTHING ON THE INVOICE (INV-069, 2026-09-18).
                // This mint used to promote a draft to sent, which is how a $6,412 invoice
                // Erik was still building became a sent bill he could not take back — from
                // a sheet he opened and closed. `send: false` was the opt-out, and it only
                // moved the promotion to the press: still a door being opened, still not a
                // payment. The mint is a Stripe call and nothing else now, and on a DRAFT it
                // mints nothing: it answers needsSend and the sheet asks "Send INV-078 as
                // the bill first?" (Connected North Phase 1 — the webhook no longer moves it).
                preMint.current = createTapPaymentIntent(invId).then(
                  (r) => {
                    // A draft mints nothing and writes nothing. The card doors ask when they are
                    // pressed; until then the panel says it in one line (draftAtOpen).
                    if (!r.ok) {
                      if (r.needsSend && gen.current === g) setDraftAtOpen(r.invoiceNumber ?? null);
                      return;
                    }
                    // Minted after the person hit Done. close() couldn't cancel it — tapPi
                    // was still empty when it ran — so this door cancels itself rather than
                    // sit open on the tenant's Stripe account.
                    if (gen.current !== g) {
                      void cancelTapPaymentIntent(r.paymentIntentId).catch(() => {});
                      return;
                    }
                    noteTapIdentity(r.identity);
                    tapPi.current = { invoiceId: invId, clientSecret: r.clientSecret, paymentIntentId: r.paymentIntentId, amount: r.amount };
                    balanceRef.current = r.balance;
                  },
                  () => {},
                );
                return;
              }
              if (!d.ok || d.supported) return;
              setTapOk(false);
              // Apple 1.4: an iOS that can't run it is told to update. A model that can't
              // simply has no button — Show Card QR is the card door on that phone.
              setTapNote(d.osTooOld ? UPDATE_IOS : null);
            },
            () => {},
          )
        : null;
    }
  }

  // ── THE VIEWS: a screen that takes the whole sheet (the phone is the reader, a card was paid,
  // the send-first question), or the panel that sits above "Or They Paid Another Way". ────────
  let takeover: React.ReactNode = null;
  if (props.cardEnabled) {
    if (paid != null) {
      takeover = (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <Check className="h-6 w-6" />
          </span>
          <div className="text-lg font-semibold text-slate-900">Paid — {money(paid)}</div>
          <p className="text-xs text-slate-500">Recorded on the invoice. The money lands in your Stripe balance.</p>
          {/* Apple 5.10: the receipt, sendable from the approved outcome — the paid invoice. */}
          {invoiceId && (
            <div className="mt-2 w-full">
              <ReceiptRow outcome="paid" receipt={receipt} invoiceId={invoiceId} amount={paid} qr={art?.payQr} toast={toast} textReady={props.textReady} />
            </div>
          )}
          <Button className="mt-2" onClick={onDone}>Done</Button>
        </div>
      );
    } else if (ask) {
      // "Send INV-078 as the bill first?" — asked when a card door was pressed, never assumed. Not
      // Now goes back to the sheet with nothing written; Send It goes on with the door pressed.
      takeover = (
        <div className="space-y-3">
          <div className="text-base font-semibold text-slate-900">{sendFirstQuestion(ask.invoiceNumber)}</div>
          <p className="text-sm text-slate-600">{sendFirstDetail(ask.invoiceNumber)}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setAsk(null)}>Not Now</Button>
            <Button onClick={sendAndGo} disabled={pending}>Send It</Button>
          </div>
        </div>
      );
    } else if (busy && tap.kind === "busy") {
      // Apple owns the screen while the card is read; this is what shows before and after —
      // and while the phone is still being configured (Apple 5.7), with the SDK's own percent
      // when it reports one (3.9.1: determinate bar) and a plain spinner when it doesn't.
      takeover = (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
          <div className="text-sm font-medium text-slate-800">{busy.title}</div>
          {busy.percent != null && (
            <div className="h-1.5 w-48 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={busy.percent}>
              <div className="h-full rounded-full bg-[rgb(var(--glass-ink))] transition-[width]" style={{ width: `${busy.percent}%` }} />
            </div>
          )}
          {busy.detail && <p className="max-w-64 text-xs text-slate-500">{busy.detail}</p>}
          {tap.phase === "pay" ? (
            <Button
              variant="outline"
              onClick={() => {
                tapPress.current += 1;
                void cancelTapPayment();
                // Before the collect nothing else will answer this press, so the sheet goes back
                // now; during it the reader's own cancelled/charged answer sets the screen.
                if (!tapCollecting.current) setTap({ kind: "idle" });
              }}
            >
              Cancel
            </Button>
          ) : tap.phase === "enable" ? (
            // Apple's terms sheet is a native screen with its own Cancel; a button here that
            // couldn't stop it would be a silent one.
            <p className="max-w-64 text-xs text-slate-500">Apple&rsquo;s sheet closes on its own once the terms are accepted or declined.</p>
          ) : (
            // Apple's how-to guide (4.2), the same: native, its own Done — and the card is
            // what comes next, so the person knows the tap hasn't been lost behind it.
            <p className="max-w-64 text-xs text-slate-500">Close Apple&rsquo;s guide when you&rsquo;re done — the card is next.</p>
          )}
        </div>
      );
    } else if (tap.kind === "confirmed") {
      // The words follow who has said what: Stripe's own yes, or only the phone's (tapConfirmedNext).
      takeover = (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
          <div className="text-sm font-medium text-slate-800">
            {tap.stripe === "charged" ? "Card approved — recording it on the invoice…" : "The phone says the card went through — checking with Stripe…"}
          </div>
          <p className="max-w-64 text-xs text-slate-500">
            {tap.stripe === "charged"
              ? "Stripe has the money. This flips to Paid the moment it lands on the invoice."
              : "Couldn't reach Stripe to double-check yet; it's asked again every few seconds. Don't take the card again until this says what happened."}
          </p>
          {tap.slow && (
            <p className="max-w-64 text-xs text-amber-700">
              {tap.stripe === "charged"
                ? `This is taking longer than usual. The charge is in Stripe (payment ${tap.paymentIntentId}); if the invoice still isn't Paid in a few minutes, the office can record it by hand as a card payment.`
                : `Still no answer from Stripe (payment ${tap.paymentIntentId}). Check the connection, or look the payment up in Stripe before charging this card again.`}
            </p>
          )}
        </div>
      );
    }
  }

  const panel: React.ReactNode = !props.cardEnabled ? null : !art ? (
    <div className="space-y-3">
      {props.source !== "invoice" && (
        <p className="text-xs text-slate-500">
          {props.source === "job"
            ? "A card is taken on the job's open bill (or writes one if there's none), then the card door goes in front of the customer."
            : "A card writes the bill, sends it, and marks the visit done — then the card door goes in front of the customer."}
        </p>
      )}
      {tap.kind === "error" && <TapOutcomeBox tap={tap} onRetry={retry} />}
      {declinedReceipt}
      {/* Apple 5.1/5.2: Tap to Pay FIRST — on top, full width, primary, and never disabled (5.3);
          Show Card QR is the outline second. Show Card QR alone (and primary) everywhere the
          phone can't be the reader; the "update iOS" line (1.4) takes the button's place. */}
      <div className="grid gap-2">
        {tapNote && <p className="text-xs text-slate-500">{tapNote}</p>}
        {tapOk && (
          <Button className="w-full" onClick={() => void tapToPay()}>
            <TapToPayGlyph /> Tap to Pay
          </Button>
        )}
        <Button className="w-full" variant={tapOk ? "outline" : "primary"} onClick={prepare} disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
          {pending ? "Getting It Ready…" : props.source === "invoice" ? "Show Card QR" : "Send The Bill & Show Card QR"}
        </Button>
        {draftAtOpen !== undefined && (
          <p className="text-xs text-slate-500">
            {`${draftAtOpen ?? "This invoice"} is still a draft, so a card asks to send it as the bill first. Money recorded below doesn't.`}
          </p>
        )}
      </div>
    </div>
  ) : (
    <div className="flex flex-col items-center gap-3">
      {/* Apple 5.1/5.2 again: ABOVE the code, full width, primary, never disabled — the phone is
          the reader first; the QR under it is for the customer who'd rather use their own. */}
      {tapOk && (
        <Button className="w-full" onClick={() => void tapToPay()}>
          <TapToPayGlyph /> Tap to Pay
        </Button>
      )}
      <div className="text-sm font-semibold text-slate-900">Scan to pay — {money(amount)}</div>
      <img src={art.payQr} alt="Scan to pay by card" className="h-56 w-56 rounded-lg" />
      <p className="max-w-64 text-center text-xs text-slate-500">
        Card, Apple Pay or Google Pay on their phone. It records itself the moment it lands.
      </p>
      {tap.kind === "error" && <TapOutcomeBox tap={tap} onRetry={retry} />}
      {declinedReceipt}
      {tapNote && <p className="text-xs text-slate-500">{tapNote}</p>}
      <div className="flex w-full flex-wrap justify-center gap-2">
        <a
          href={`sms:?body=${smsBody}`}
          className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
        >
          <MessageSquare className="h-4 w-4" /> Text The Pay Link
        </a>
        <Button
          variant="outline"
          onClick={() => {
            if (!art.payUrl) return;
            navigator.clipboard?.writeText(art.payUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy Link"}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the payment…
      </div>
      {/* Text The Pay Link opens THIS phone's messages, not the business line — same honesty the
          lead-texting doors carry. */}
      <p className="max-w-64 text-center text-[11px] text-slate-400">
        Text The Pay Link sends from this phone&rsquo;s number. Copy Link to send it from the business line.
      </p>
    </div>
  );

  return { onOpen, reset, takeover, panel };
}

/**
 * "OR THEY PAID ANOTHER WAY" - Record Payment's state machine, composed into the Get Paid sheet
 * unchanged in what it does. `onDone` closes the sheet (a payment recorded); `reset` is what its
 * close did to the form.
 */
function useOtherWay(
  props: Mode & {
    /** The org's Settings → Payment methods list. Card is filtered OUT here — it belongs to the
     *  card panel — so an org that lists "Card" can't record a phantom through this door. Filtered by
     *  KEY, not spelling: "Credit Card" or "Debit" is stored as card too (paymentMethodKey). */
    methods?: string[];
    /** false = no Venmo handle: the optional QR button is hidden; recording a Venmo payment always works. */
    venmoConfigured?: boolean;
  },
  onDone: () => void,
) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  // The QR fetch has its own pending: on an invoice it only READS, so the sheet must not say
  // "Saving…" over a payment nobody is recording.
  const [qrPending, startQr] = useTransition();
  const [amount, setAmount] = useState(props.source === "invoice" ? String(props.balance || "") : "");
  const [note, setNote] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const source = props.methods?.length ? props.methods : ["Cash", "Check", "Venmo", "Other"];
  const chips = source.filter((m) => paymentMethodKey(m) !== "card");
  const [method, setMethod] = useState(chips[0] ?? "Cash");
  const [venmo, setVenmo] = useState<{ qr: string; handle?: string; invoiceId: string; amount: number } | null>(null);
  /**
   * "SEND INV-0xx AS THE BILL FIRST?" (Connected North Phase 1). On a job whose open bill is a
   * draft, a payment that pays ALL of it would leave a draft reading $0 owed that no screen calls
   * paid, so the server writes nothing and asks (needsSend); a deposit just lands. Only the yes, for
   * this open of the sheet, goes back with `sendIt`. `then` is the button the person pressed.
   */
  const [ask, setAsk] = useState<{ invoiceNumber: string | null; then: "record" | "venmo" } | null>(null);
  const sendOk = useRef(false);

  const amt = () => Number(String(amount).replace(/[$,\s]/g, ""));
  const key = paymentMethodKey(method);
  const dirty = note.trim().length > 0 || paidAt.length > 0;

  function reset() {
    setNote("");
    setPaidAt("");
    setVenmo(null);
    setAsk(null);
    sendOk.current = false;
    setAmount(props.source === "invoice" ? String(props.balance || "") : "");
  }
  /** The recorded payment is the end of the sheet: it closes (and resets this form). */
  const close = onDone;

  /**
   * RECORD IT — every method, Venmo included (2026-09-24, INV-078). A Venmo payment that landed
   * three weeks ago is written down exactly like cash, with its paid date: no handle required, no
   * QR in the way. On an invoice source a draft stays a draft (recordPayment's paidStatus); only
   * the QR below is optional.
   */
  function go() {
    if (qrPending) return; // Enter in the amount box while the QR is still coming
    if (!Number.isFinite(amt()) || amt() <= 0) { toast("Enter what they paid.", "error"); return; }
    start(async () => {
      const id = await ensureInvoice(props, method, "record", amt(), note, paidAt || null, toast, (o) => router.push(`/billing/${o}`), sendOk.current, (n) =>
        setAsk({ invoiceNumber: n, then: "record" }),
      );
      if (!id) return;
      toast(`Paid — ${money(amt())} ${method.toLowerCase()}. Done.`, "success");
      close();
    });
  }

  /**
   * SHOW VENMO QR — the optional door for a customer standing in front of you. On an existing
   * invoice it only READS (venmoQrFor writes nothing, so a draft is not sent by showing a QR).
   * A visit/job still mints its invoice at the doorstep through settleUp, as it always has: the
   * QR needs an invoice number to ask for.
   */
  function showVenmoQr() {
    if (!Number.isFinite(amt()) || amt() <= 0) { toast("Enter what they're paying.", "error"); return; }
    startQr(async () => {
      let id: string | null;
      if (props.source === "invoice") {
        id = props.invoiceId;
      } else {
        id = await ensureInvoice(props, method, "later", amt(), note, paidAt || null, toast, (o) => router.push(`/billing/${o}`), sendOk.current, (n) =>
          setAsk({ invoiceNumber: n, then: "venmo" }),
        );
        if (!id) return;
      }
      const art = await venmoQrFor(id, amt());
      if (!art.ok || !art.venmoQr) {
        toast(art.error ?? "Add your Venmo username in Settings → Payment methods first.", "error");
        return;
      }
      setVenmo({ qr: art.venmoQr, handle: art.venmoHandle, invoiceId: id, amount: Math.min(amt(), art.balance ?? amt()) });
    });
  }

  /** THE YES: the send happens on the server inside the next call (sendIt), through the one send
   *  stamp, so it can never be split from the payment it was for. Said out loud. */
  function sendAndGo() {
    const a = ask;
    if (!a) return;
    sendOk.current = true;
    setAsk(null);
    toast(`Sending ${a.invoiceNumber ?? "the invoice"} as the bill.`, "info");
    if (a.then === "venmo") showVenmoQr();
    else go();
  }

  /** Venmo's half-blind ending: the app can't hear the payment land, so the person says so. */
  function venmoPaid() {
    if (!venmo) return;
    start(async () => {
      // The chip label as picked; recordPayment stores its key.
      const r = await recordPayment({ invoice_id: venmo.invoiceId, amount: venmo.amount, method, note, paid_at: paidAt || null });
      if (!r.ok) { toast(r.error ?? "Couldn't record that.", "error"); return; }
      toast(`Paid — ${money(venmo.amount)} Venmo. Done.`, "success");
      close();
    });
  }

  /** What the sheet opening does to this panel: an invoice's balance is the first figure. */
  function onOpen() {
    if (props.source === "invoice") setAmount(String(props.balance || ""));
  }

  // ── THE VIEWS ────────────────────────────────────────────────────────────────────────────
  let takeover: React.ReactNode = null;
  let footer: React.ReactNode = null;
  if (ask) {
    // Asked, never assumed. Not Now goes back to the sheet with nothing written.
    takeover = (
      <div className="space-y-3">
        <div className="text-base font-semibold text-slate-900">{sendFirstQuestion(ask.invoiceNumber)}</div>
        <p className="text-sm text-slate-600">{sendFirstDetail(ask.invoiceNumber, "payment")}</p>
      </div>
    );
    footer = <ModalActions onCancel={() => setAsk(null)} onSave={sendAndGo} saving={pending} saveLabel="Send It" cancelLabel="Not Now" />;
  } else if (venmo) {
    takeover = (
      <div className="flex flex-col items-center gap-2">
        <span className="text-sm font-semibold text-slate-900">Venmo @{venmo.handle} — {money(venmo.amount)}</span>
        <img src={venmo.qr} alt="Venmo QR code" className="h-56 w-56 rounded-lg" />
        <p className="max-w-64 text-center text-xs text-slate-500">
          They scan, they pay. Venmo can&apos;t tell the app when it lands — tap the button when it does.
        </p>
      </div>
    );
    footer = <ModalActions onCancel={() => setVenmo(null)} onSave={venmoPaid} saving={pending} saveLabel="They Paid — Record It" cancelLabel="Back" />;
  }

  /** The panel under the card (`underCard`), or the sheet's only half where cards aren't on. */
  function panel(underCard: boolean, transferPending?: string | null): React.ReactNode {
    return (
      <section className={`space-y-4 ${underCard ? "border-t border-slate-100 pt-4" : ""}`}>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{underCard ? "Or They Paid Another Way" : "How They Paid"}</h3>
          <p className="mt-0.5 text-xs text-slate-500">Money that moved outside Stripe — cash, a check, a transfer, Venmo.</p>
        </div>
        {/* A BANK TRANSFER ON ITS WAY (0338): recorded by hand as well, it would count twice. */}
        {transferPending && (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
            {transferPending} Don&apos;t record it by hand, or it counts twice.
          </p>
        )}
        <div>
          <label htmlFor="rp-amount" className="mb-1 block text-xs font-medium text-slate-600">Amount</label>
          <input
            id="rp-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }}
            placeholder="$ amount"
            className="h-11 w-full rounded-lg border border-slate-200 px-3 text-lg font-semibold tabular-nums"
          />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-600">How they paid</div>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold capitalize ${
                  method === m ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        {/* THE OPTIONAL QR, in the body at full width: a 44px target for a customer standing
            right there. Away from an invoice it mints and sends the bill first (settleUp at the
            doorstep), so it says so, the way the card panel's Send The Bill & Show Card QR does. */}
        {key === "venmo" && props.venmoConfigured !== false && (
          <Button type="button" variant="outline" className="w-full" onClick={showVenmoQr} disabled={pending || qrPending}>
            {qrPending ? (
              <><Loader2 className="animate-spin" /> Getting It Ready…</>
            ) : (
              <><QrCode /> {props.source === "invoice" ? "Show Venmo QR" : "Send the Bill & Show Venmo QR"}</>
            )}
          </Button>
        )}
        {/* The two bookkeeping fields the old form had: WHEN it was paid (a check that arrived
            last Tuesday) and a note (the check number). Date only means something on an
            existing invoice — a visit being settled right now was paid right now. */}
        <div className="grid grid-cols-2 gap-2">
          {props.source === "invoice" && (
            <div>
              <label htmlFor="rp-date" className="mb-1 block text-xs font-medium text-slate-600">Date Paid</label>
              <input id="rp-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="h-11 w-full rounded-lg border border-slate-200 px-2 text-sm" />
            </div>
          )}
          <div className={props.source === "invoice" ? "" : "col-span-2"}>
            <label htmlFor="rp-note" className="mb-1 block text-xs font-medium text-slate-600">Note</label>
            <input id="rp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. check #1042" className="h-11 w-full rounded-lg border border-slate-200 px-2 text-sm" />
          </div>
        </div>
        {/* RECORD IT — every method, whatever chip is picked (Venmo included, with its paid date). */}
        <Button type="button" className="w-full" onClick={go} disabled={pending || qrPending}>
          {pending ? "Saving…" : "Record It"}
        </Button>
      </section>
    );
  }

  return { onOpen, reset, dirty, takeover, footer, panel };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET PAID — the one sheet (W1-26). The invoice header, its ⋯, the job hub and the visit mount it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function GetPaidButton(
  props: Mode & {
    cardEnabled?: boolean;
    methods?: string[];
    venmoConfigured?: boolean;
    /** smsReadiness(org).ready (lib/sms-readiness): the card receipt's Text door reads it. */
    textReady?: boolean;
    /** A bank transfer on its way for this bill (lib/bank-transfer's sentence), said in the sheet. */
    transferPending?: string | null;
    /** How the door looks: the header's primary, an outline (the job hub), a ⋯ row, or the small
     *  "Getting Paid Now?" link under a draft's Send. */
    trigger?: "primary" | "outline" | "menuItem" | "link";
    label?: string;
  },
) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { cardEnabled = false, methods, venmoConfigured, textReady, transferPending, trigger = "primary", label, ...rest } = props;
  const mode = rest as Mode;
  const card = useCardDoor({ ...mode, cardEnabled, textReady }, open, close);
  const other = useOtherWay({ ...mode, methods, venmoConfigured }, close);

  function openSheet() {
    other.onOpen();
    card.onOpen();
    setOpen(true);
  }
  /** Every way out of the sheet: both halves let go of what this open held, then the page reads again. */
  function close() {
    card.reset();
    other.reset();
    setOpen(false);
    router.refresh();
  }

  const title = mode.source === "invoice" ? `Get Paid ${money(mode.balance)}` : "Get Paid";
  const words = label ?? (trigger === "link" ? "Getting Paid Now?" : "Get Paid");
  const button =
    trigger === "menuItem" ? (
      <button type="button" onClick={openSheet} className={ACTIONS_ROW_CLS}>
        <BadgeDollarSign className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {words}
      </button>
    ) : trigger === "link" ? (
      <button type="button" onClick={openSheet} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
        {words}
      </button>
    ) : (
      <Button variant={trigger === "outline" ? "outline" : "primary"} onClick={openSheet}>
        <BadgeDollarSign className="h-4 w-4" /> {words}
      </Button>
    );

  return (
    <>
      {button}
      <Modal
        open={open}
        onClose={close}
        title={title}
        size="sm"
        portal
        dirty={other.dirty && !card.takeover && !other.takeover}
        footer={card.takeover ? undefined : (other.footer ?? undefined)}
      >
        {card.takeover ?? other.takeover ?? (
          <div className="space-y-5">
            {card.panel}
            {other.panel(!!card.panel, transferPending)}
            {!cardEnabled && (
              <p className="text-xs text-slate-500">
                Cards aren&apos;t switched on for this company yet: Settings → Getting Paid → Set Up Card Payments takes about five
                minutes.
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

/**
 * THE JOB HUB'S AND THE VISIT'S DOOR, UNDER ITS OLD NAME AND PROPS (tech-doors pins it inside
 * {viewerIsStaff && …}). It renders the one Get Paid button now, so every surface opens the same
 * sheet; source modes appointment / job / invoice are unchanged.
 */
export function SettleUpButton(props: Mode & {
  cardEnabled?: boolean;
  methods?: string[];
  venmoConfigured?: boolean;
  compact?: boolean;
  /** smsReadiness(org).ready from the page (lib/sms-readiness). */
  textReady?: boolean;
}) {
  const { compact, ...rest } = props;
  return <GetPaidButton {...(rest as Mode & Omit<typeof rest, "source">)} trigger={compact ? "outline" : "primary"} />;
}
