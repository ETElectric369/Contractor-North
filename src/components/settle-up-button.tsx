"use client";

/* eslint-disable @next/next/no-img-element -- the QRs are data URLs and the Tap to Pay symbol is a 4KB static PNG; next/image adds nothing */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeDollarSign, Check, Copy, CreditCard, Loader2, Mail, MessageSquare, QrCode, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { collectArtifacts, emailInvoice, invoiceCollectStatus, recordPayment, settleUp, textInvoice } from "@/app/(app)/billing/actions";
import { cancelTapPaymentIntent, createTapPaymentIntent, tapToPayContext } from "@/app/(app)/billing/tap-actions";
import {
  cancelTapPayment,
  collectTapPayment,
  enableTapToPay,
  onTapProgress,
  showHowToTap,
  tapToPayAccountLinked,
  tapToPayDeviceStatus,
  tapToPayPluginPresent,
  type TapProgress,
} from "@/lib/native-tap";

/**
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

type Art = { payUrl?: string; payQr?: string; venmoQr?: string; venmoHandle?: string; balance?: number; invoiceNumber?: string | null };

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
 *  Apple's terms sheet, or Apple's how-to guide right after the terms) / Stripe said yes and the
 *  webhook is writing it / it stopped, with the sentence that says why. */
type TapState =
  | { kind: "idle" }
  | { kind: "busy"; label: string; phase: "pay" | "enable" | "guide" }
  | { kind: "confirmed" }
  | { kind: "error"; error: string; outcome: TapOutcome };

/** The receipt door (Apple 5.10): the public invoice link and what the text names. null = not
 *  fetched yet for this open of the screen. */
type Receipt = { link: string; business: string; invoiceNumber: string | null } | { error: string };

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
 * The QR's pay door is `${base}/api/pay/<token>` (collectArtifacts); the invoice itself lives at
 * `${base}/i/<token>` on the same host. A paid invoice on that page IS the receipt; a declined
 * one is the "still open, nothing charged" record. Same token, one path swap — no new server
 * door. null when the shape isn't the one we know (never guess a customer-facing link).
 */
function receiptLinkOf(payUrl: string | undefined): string | null {
  if (!payUrl) return null;
  const m = /^(https?:\/\/[^/]+)\/api\/pay\/([A-Za-z0-9_-]+)$/.exec(payUrl);
  return m ? `${m[1]}/i/${m[2]}` : null;
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
): Promise<string | null> {
  if (props.source === "invoice") {
    if (collect === "record") {
      const r = await recordPayment({ invoice_id: props.invoiceId, amount, method, note, paid_at: paidAt });
      if (!r.ok) { toast(r.error ?? "Couldn't record that.", "error"); return null; }
    }
    return props.invoiceId;
  }
  const res = await settleUp({ source: props.source, id: props.id, amount, method, note, collect }).catch(() => ({
    ok: false as const,
    error: "That didn't reach the server — check your connection and try again.",
  }));
  if (!res.ok) {
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
}: {
  outcome: "paid" | "declined";
  receipt: Receipt | null;
  invoiceId: string;
  amount: number;
  qr?: string;
  toast: (m: string, k?: "success" | "error" | "info") => void;
}) {
  const [texting, setTexting] = useState(false);
  const [texted, setTexted] = useState(false);
  /** The SMS service said this customer has no number: the text door becomes this phone's. */
  const [noPhone, setNoPhone] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [emailed, setEmailed] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  // Read at render, not in an effect: this row only ever mounts on the client, after an outcome
  // (never in the server render), so there is no hydration split to protect against.
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  /** The text door from this phone: the decline always (see above); paid only once the service
   *  has said there is no number to send to. */
  const fromThisPhone = outcome === "declined" || noPhone;

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
    outcome === "paid" && !noPhone && "Text Receipt sends from the business’s number.",
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
            {outcome === "paid" && !noPhone && (
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

export function PayNowButton(props: Mode & {
  /** canAcceptPayments(org) from the page. False = the screen explains where cards get switched
   *  on instead of pretending; nothing is minted, sent or recorded. */
  cardEnabled: boolean;
  compact?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
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
  const tapPi = useRef<{ invoiceId: string; clientSecret: string; paymentIntentId: string; amount: number } | null>(null);
  /** The device probe from opening. ONE SDK conversation at a time from this screen: a tap
   *  pressed before the probe answers waits for it rather than talking over it. */
  const probe = useRef<Promise<void> | null>(null);
  /** Apple 5.6 — the reader's UI within a second of the press. The reader is warm (warmup.tsx);
   *  the other second was ours: minting the PaymentIntent on the press. So on an invoice it is
   *  minted the moment the phone says it can tap, and the press only has the SDK left to do. A
   *  door nobody walked through is cancelled on close (cancelTapPaymentIntent) — the balance is
   *  fixed at open, and a balance that changes under an open sheet ends in Paid, not a stale tap. */
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

  function invoiceDoor(): Promise<string | null> {
    if (!door.current) {
      door.current = ensureInvoice(props, "card", "later", 0, "", null, toast, (other) => router.push(`/billing/${other}`)).then(
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
      if (!id) return;
      const a = await collectArtifacts(id);
      if (gen.current !== g) return;
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

  /** The phone as the reader. Same door-building as the QR for a visit/job (the bill must exist
   *  and be SENT before a card can pay it), then Stripe's PaymentIntent on the tenant's account,
   *  then the bridge: Apple takes the screen while the customer holds their card to the phone. */
  async function tapToPay() {
    const g = gen.current;
    /** Has the sheet this tap belongs to closed (or reopened)? `armed` = the await we just came
     *  back from was the reader's — tell it to stand down as well; the bridge's cancel is a no-op
     *  when nothing is listening, so it never hurts to say it. */
    const stale = (armed = false): boolean => {
      if (gen.current === g) return false;
      if (armed) void cancelTapPayment();
      return true;
    };
    setTap({ kind: "busy", phase: "pay", label: "Getting Tap to Pay on iPhone ready…" });
    try {
      // The device probe from opening may still hold the SDK's turn — let it finish first.
      await probe.current;
      if (stale()) return;
      const id = await invoiceDoor();
      if (stale()) return;
      if (!id) { setTap({ kind: "idle" }); return; }
      // The open-time mint may still be in flight — wait for it rather than mint a second door.
      await preMint.current;
      if (stale()) return;
      let pi = tapPi.current;
      if (!pi || pi.invoiceId !== id) {
        const r = await createTapPaymentIntent(id);
        if (stale()) return;
        if (!r.ok) { setTap({ kind: "error", error: r.error, outcome: "setup" }); return; }
        pi = { invoiceId: id, clientSecret: r.clientSecret, paymentIntentId: r.paymentIntentId, amount: r.amount };
        tapPi.current = pi;
        balanceRef.current = r.balance;
        setTapStarted(true);
      }
      const holdCard = `Hold their card to the top of the phone — ${money(pi.amount / 100)}`;
      setTap({ kind: "busy", phase: "pay", label: holdCard });
      let c = await collectTapPayment(pi);
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
        setTap({ kind: "busy", phase: "pay", label: holdCard });
        c = await collectTapPayment(pi);
        if (stale(true)) return;
      }
      if (c.ok) {
        // Stripe confirmed the charge. The invoice flips when the webhook writes it; the watch
        // sees it land exactly as it does for the QR.
        tapPi.current = null;
        setTap({ kind: "confirmed" });
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
        router.refresh();
      }
    };
    const timer = setInterval(tick, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [open, art, tapStarted, invoiceId, paid, router, toast]);

  // THE PROGRESS FEED (Apple 5.7 / 3.9.1). The bridge publishes what the reader is doing — its
  // own stages and the SDK's configuration percent — for the life of the page; this screen
  // listens only while it is open and reads it only while a tap is busy.
  useEffect(() => {
    if (!open) return;
    return onTapProgress(setProgress);
  }, [open]);

  // THE RECEIPT LINK (Apple 5.10), fetched once per open the moment there is an outcome to send —
  // paid, or a tap that was declined or timed out. Two reads: the public token (off the QR's
  // pay URL when the QR was built, else one collectArtifacts — the draft→sent promotion has
  // already happened by then) and the business's name for the text (tapToPayContext's
  // merchantDisplayName; its "Invoice payment" fallback is not a name and is left out).
  const wantsReceipt = paid != null || (tap.kind === "error" && tap.outcome === "declined");
  useEffect(() => {
    if (!open || !wantsReceipt || !invoiceId || receipt) return;
    let live = true;
    void (async () => {
      type Door = { payUrl?: string; invoiceNumber: string | null };
      const [got, business] = await Promise.all<[Promise<Door | null>, Promise<string>]>([
        art?.payUrl
          ? Promise.resolve({ payUrl: art.payUrl, invoiceNumber: art.invoiceNumber ?? null })
          : collectArtifacts(invoiceId).then(
              (a) => (a.ok ? { payUrl: a.payUrl, invoiceNumber: a.invoiceNumber ?? null } : null),
              () => null,
            ),
        tapToPayContext().then((c) => (c.ok ? c.merchantDisplayName : ""), () => ""),
      ]);
      if (!live) return;
      const link = receiptLinkOf(got?.payUrl);
      setReceipt(
        link
          ? { link, business: business === "Invoice payment" ? "" : business, invoiceNumber: got?.invoiceNumber ?? null }
          : { error: "Couldn't get the receipt link — open the invoice and share it from there." },
      );
    })();
    return () => { live = false; };
  }, [open, wantsReceipt, invoiceId, receipt, art]);

  function close() {
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
    setOpen(false);
    setArt(null);
    setPaid(null);
    setCopied(false);
    setTap({ kind: "idle" });
    setTapStarted(false);
    setProgress(null);
    setReceipt(null);
    tapPi.current = null;
    preMint.current = null;
    router.refresh();
  }

  const amount = art?.balance ?? balanceRef.current;
  const smsBody = art?.payUrl
    ? encodeURIComponent(`${art.invoiceNumber ? `Invoice ${art.invoiceNumber} — ` : ""}${money(amount)}. Pay by card here: ${art.payUrl}`)
    : "";
  /** Try Again only where the same PaymentIntent can take another card (Apple 5.9's declined);
   *  a timeout may already be through (see TapOutcomeBox), and every other outcome's sentence
   *  names its own fix — and Tap to Pay is right there. */
  const retry = tap.kind === "error" && tapStarted && tap.outcome === "declined" ? () => void tapToPay() : null;
  const declinedReceipt =
    tap.kind === "error" && tap.outcome === "declined" && invoiceId ? (
      <ReceiptRow outcome="declined" receipt={receipt} invoiceId={invoiceId} amount={balanceRef.current} toast={toast} />
    ) : null;
  const busy = tap.kind === "busy" ? busyLine(tap.label, progress) : null;

  return (
    <>
      <Button
        size={props.compact ? "sm" : "md"}
        variant={props.compact ? "outline" : "primary"}
        onClick={() => {
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
          tapPi.current = null;
          preMint.current = null;
          setOpen(true);
          if (props.cardEnabled) {
            // Is this the iPhone app? Answered synchronously, so the button is on the first
            // paint (Apple 5.1/5.2). Then: can THIS phone be the reader? Never throws; when it
            // can't answer at all the button stays — a press then gets the bridge's sentence.
            const shell = tapToPayPluginPresent();
            // An invoice's door can be built the moment the screen opens — one read, no side
            // effects — but only where the QR is the first card door. In the iPhone app the
            // phone is the reader (Apple 5.1/5.2: Tap to Pay first, primary, on top), so the
            // sheet opens on the two buttons and the QR is one press away; building it on open
            // would land the screen on a 224px code with Tap to Pay somewhere under it. A
            // visit/job waits for the explicit tap either way, because building it SENDS a bill.
            if (props.source === "invoice" && !art && !shell) prepare();
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
                      preMint.current = createTapPaymentIntent(invId).then(
                        (r) => {
                          if (gen.current !== g || !r.ok) return;
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
                    // simply has no button — the QR is the card door on that phone, so it is
                    // built on open the way the web builds it.
                    setTapNote(d.osTooOld ? UPDATE_IOS : null);
                    if (props.source === "invoice") prepare();
                  },
                  () => {},
                )
              : null;
          }
        }}
      >
        <CreditCard className="h-4 w-4" /> {props.label ?? "Pay Now"}
      </Button>

      <Modal open={open} onClose={close} title="Pay by card" size="sm" portal>
        {!props.cardEnabled ? (
          <div className="space-y-3 text-sm text-slate-600">
            <p>Card payments aren&apos;t switched on for this company yet.</p>
            <p>
              Settings → Getting Paid → <span className="font-medium text-slate-800">Set Up Card Payments</span> takes
              about five minutes. Until then, cash, check and Venmo go through Record Payment.
            </p>
          </div>
        ) : paid != null ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <Check className="h-6 w-6" />
            </span>
            <div className="text-lg font-semibold text-slate-900">Paid — {money(paid)}</div>
            <p className="text-xs text-slate-500">Recorded on the invoice. The money lands in your Stripe balance.</p>
            {/* Apple 5.10: the receipt, sendable from the approved outcome — the paid invoice. */}
            {invoiceId && (
              <div className="mt-2 w-full">
                <ReceiptRow outcome="paid" receipt={receipt} invoiceId={invoiceId} amount={paid} qr={art?.payQr} toast={toast} />
              </div>
            )}
            <Button size="sm" className="mt-2" onClick={close}>Done</Button>
          </div>
        ) : busy && tap.kind === "busy" ? (
          // Apple owns the screen while the card is read; this is what shows before and after —
          // and while the phone is still being configured (Apple 5.7), with the SDK's own percent
          // when it reports one (3.9.1: determinate bar) and a plain spinner when it doesn't.
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
              <Button size="sm" variant="outline" onClick={() => void cancelTapPayment()}>Cancel</Button>
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
        ) : tap.kind === "confirmed" ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            <div className="text-sm font-medium text-slate-800">Card approved — recording it on the invoice…</div>
            <p className="text-xs text-slate-500">Stripe confirmed the charge. This flips to Paid the moment it lands.</p>
          </div>
        ) : !art ? (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-500">Balance due</span>
              <span className="text-2xl font-bold tabular-nums text-slate-900">{money(balanceRef.current)}</span>
            </div>
            {props.source !== "invoice" && (
              <p className="text-xs text-slate-500">
                This writes the bill, sends it, and marks the visit done — then puts the card door in front of the customer.
              </p>
            )}
            {tap.kind === "error" && <TapOutcomeBox tap={tap} onRetry={retry} />}
            {declinedReceipt}
            {/* Apple 5.1/5.2: Tap to Pay FIRST — on top, full width, primary, the same height as
                the QR button under it, and never disabled (5.3); the QR button is the outline
                second. The QR button alone (and primary) everywhere the phone can't be the
                reader; the "update iOS" line (1.4) takes the button's place. */}
            <div className="grid gap-2">
              {tapNote && <p className="text-xs text-slate-500">{tapNote}</p>}
              {tapOk && (
                <Button className="w-full" onClick={() => void tapToPay()}>
                  <TapToPayGlyph /> Tap to Pay
                </Button>
              )}
              <Button className="w-full" variant={tapOk ? "outline" : "primary"} onClick={prepare} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                {pending ? "Getting it ready…" : props.source === "invoice" ? "Show the QR" : "Send the bill & show the QR"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {/* Apple 5.1/5.2 again: ABOVE the code, full width, primary, never disabled — the
                phone is the reader first; the QR under it is for the customer who'd rather use
                their own. */}
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
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                <MessageSquare className="h-4 w-4" /> Text the Link
              </a>
              <Button
                size="sm"
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
            {/* Text the Link opens THIS phone's messages, not the business line — same honesty
                the lead-texting doors carry. */}
            <p className="max-w-64 text-center text-[11px] text-slate-400">
              Text the Link sends from this phone&rsquo;s number. Copy Link to send it from the business line.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RECORD PAYMENT — everything that isn't a card, as a sheet the same size as Pay Now
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function RecordPaymentButton(props: Mode & {
  /** The org's Settings → Payment methods list. Card is filtered OUT here — it belongs to Pay
   *  Now — so an org that lists "Card" can't record a phantom through this door. */
  methods?: string[];
  /** false = org has no Venmo handle: the venmo tap dead-ends BEFORE minting a sent invoice. */
  venmoConfigured?: boolean;
  compact?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(props.source === "invoice" ? String(props.balance || "") : "");
  const [note, setNote] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const source = props.methods?.length ? props.methods : ["Cash", "Check", "Venmo", "Other"];
  const chips = source.filter((m) => m.toLowerCase() !== "card");
  const [method, setMethod] = useState(chips[0] ?? "Cash");
  const [venmo, setVenmo] = useState<{ qr: string; handle?: string; invoiceId: string; amount: number } | null>(null);

  const amt = () => Number(String(amount).replace(/[$,\s]/g, ""));
  const key = method.toLowerCase();
  const dirty = note.trim().length > 0 || paidAt.length > 0;

  function reset() {
    setNote("");
    setPaidAt("");
    setVenmo(null);
    setAmount(props.source === "invoice" ? String(props.balance || "") : "");
  }
  function close() {
    setOpen(false);
    reset();
    router.refresh();
  }

  function go() {
    if (!Number.isFinite(amt()) || amt() <= 0) { toast("Enter what they paid.", "error"); return; }
    if (key === "venmo" && props.venmoConfigured === false) {
      toast("Add your Venmo username in Settings → Payment methods first.", "error");
      return;
    }
    start(async () => {
      if (key === "venmo") {
        const id = await ensureInvoice(props, method, "later", amt(), note, paidAt || null, toast, (o) => router.push(`/billing/${o}`));
        if (!id) return;
        const art = await collectArtifacts(id, amt());
        if (!art.ok || !art.venmoQr) {
          toast(art.error ?? "Add your Venmo username in Settings → Payment methods first.", "error");
          return;
        }
        setVenmo({ qr: art.venmoQr, handle: art.venmoHandle, invoiceId: id, amount: Math.min(amt(), art.balance ?? amt()) });
        return;
      }
      const id = await ensureInvoice(props, method, "record", amt(), note, paidAt || null, toast, (o) => router.push(`/billing/${o}`));
      if (!id) return;
      toast(`Paid — ${money(amt())} ${method.toLowerCase()}. Done.`, "success");
      close();
    });
  }

  /** Venmo's half-blind ending: the app can't hear the payment land, so the person says so. */
  function venmoPaid() {
    if (!venmo) return;
    start(async () => {
      const r = await recordPayment({ invoice_id: venmo.invoiceId, amount: venmo.amount, method: "venmo", note, paid_at: paidAt || null });
      if (!r.ok) { toast(r.error ?? "Couldn't record that.", "error"); return; }
      toast(`Paid — ${money(venmo.amount)} Venmo. Done.`, "success");
      close();
    });
  }

  return (
    <>
      <Button
        size={props.compact ? "sm" : "md"}
        variant={props.compact ? "outline" : "primary"}
        onClick={() => {
          if (props.source === "invoice") setAmount(String(props.balance || ""));
          setOpen(true);
        }}
      >
        <BadgeDollarSign className="h-4 w-4" /> {props.label ?? "Record Payment"}
      </Button>

      <Modal
        open={open}
        onClose={close}
        title="Record Payment"
        size="sm"
        portal
        dirty={dirty}
        footer={
          venmo ? (
            <ModalActions onCancel={close} onSave={venmoPaid} saving={pending} saveLabel="They Paid — Record It" cancelLabel="Close" />
          ) : (
            <ModalActions onCancel={close} onSave={go} saving={pending} saveLabel={key === "venmo" ? "Show Venmo QR" : "Record It"} />
          )
        }
      >
        {venmo ? (
          <div className="flex flex-col items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">Venmo @{venmo.handle} — {money(venmo.amount)}</span>
            <img src={venmo.qr} alt="Venmo QR code" className="h-56 w-56 rounded-lg" />
            <p className="max-w-64 text-center text-xs text-slate-500">
              They scan, they pay. Venmo can&apos;t tell the app when it lands — tap the button when it does.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              Money that moved outside Stripe — cash, a check, a transfer, Venmo. Card payments go through Pay Now.
            </p>
            <div>
              <label htmlFor="rp-amount" className="mb-1 block text-xs font-medium text-slate-600">Amount</label>
              <input
                id="rp-amount"
                autoFocus
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
                    className={`inline-flex h-9 items-center rounded-lg border px-3 text-sm font-semibold capitalize ${
                      method === m ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {/* The two bookkeeping fields the old form had: WHEN it was paid (a check that arrived
                last Tuesday) and a note (the check number). Date only means something on an
                existing invoice — a visit being settled right now was paid right now. */}
            <div className="grid grid-cols-2 gap-2">
              {props.source === "invoice" && (
                <div>
                  <label htmlFor="rp-date" className="mb-1 block text-xs font-medium text-slate-600">Date paid</label>
                  <input id="rp-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" />
                </div>
              )}
              <div className={props.source === "invoice" ? "" : "col-span-2"}>
                <label htmlFor="rp-note" className="mb-1 block text-xs font-medium text-slate-600">Note</label>
                <input id="rp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. check #1042" className="h-10 w-full rounded-lg border border-slate-200 px-2 text-sm" />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Both verbs side by side — the job hub and the appointment page mount this.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function SettleUpButton(props: Mode & {
  cardEnabled?: boolean;
  methods?: string[];
  venmoConfigured?: boolean;
  compact?: boolean;
}) {
  const { cardEnabled = false, methods, venmoConfigured, compact, ...mode } = props;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <PayNowButton {...(mode as Mode)} cardEnabled={cardEnabled} compact={compact} />
      <RecordPaymentButton {...(mode as Mode)} methods={methods} venmoConfigured={venmoConfigured} compact={compact} />
    </span>
  );
}
