"use client";

/* eslint-disable @next/next/no-img-element -- the QRs are data URLs; next/image adds nothing */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeDollarSign, Check, Copy, CreditCard, Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { collectArtifacts, invoiceCollectStatus, recordPayment, settleUp } from "@/app/(app)/billing/actions";

/**
 * TWO VERBS, SPLIT BY WHERE THE MONEY MOVES (Erik 2026-09-10: "the pay now button should have the
 * credit card stuff and the record payment is everything else").
 *
 *   PAY NOW         → card. Opens the CARD CONTROL SCREEN: the balance, a QR the customer scans
 *                     into Stripe checkout on their phone, the same link to text or copy — and then
 *                     it WATCHES, polling the invoice until the webhook writes the payment, so the
 *                     tech sees "Paid" land without refreshing. Tap to Pay slots in here.
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
 */
type Mode =
  | { source: "appointment" | "job"; id: string; invoiceId?: never; balance?: never }
  | { source: "invoice"; invoiceId: string; balance: number; id?: never };

type Art = { payUrl?: string; payQr?: string; venmoQr?: string; venmoHandle?: string; balance?: number; invoiceNumber?: string | null };

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

  /** Build the door: for a visit/job that means minting AND sending the bill first (so it's an
   *  explicit tap, never a side effect of opening the screen); for an invoice it's one read. */
  function prepare() {
    start(async () => {
      const id = await ensureInvoice(props, "card", "later", 0, "", null, toast, (other) => router.push(`/billing/${other}`));
      if (!id) return;
      const a = await collectArtifacts(id);
      if (!a.ok) { toast(a.error ?? "Couldn't build the payment code.", "error"); return; }
      if (!a.payQr) {
        toast("Card payments aren't switched on yet — Settings → Getting Paid → Set Up Card Payments.", "error");
        return;
      }
      balanceRef.current = a.balance ?? balanceRef.current;
      setInvoiceId(id);
      setArt(a);
    });
  }

  // THE WATCH. Stripe's webhook writes the payment; nothing on this screen does. Poll the invoice
  // while the QR is up so the person holding the phone sees it land, then stop — a screen that
  // keeps polling after "Paid" is a battery drain in a truck.
  useEffect(() => {
    if (!open || !art || !invoiceId || paid != null) return;
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
  }, [open, art, invoiceId, paid, router, toast]);

  function close() {
    setOpen(false);
    setArt(null);
    setPaid(null);
    setCopied(false);
    router.refresh();
  }

  const amount = art?.balance ?? balanceRef.current;
  const smsBody = art?.payUrl
    ? encodeURIComponent(`${art.invoiceNumber ? `Invoice ${art.invoiceNumber} — ` : ""}${money(amount)}. Pay by card here: ${art.payUrl}`)
    : "";

  return (
    <>
      <Button
        size={props.compact ? "sm" : "md"}
        variant={props.compact ? "outline" : "primary"}
        onClick={() => {
          setOpen(true);
          // An invoice's door can be built the moment the screen opens — one read, no side
          // effects. A visit/job waits for the explicit tap, because building it SENDS a bill.
          if (props.cardEnabled && props.source === "invoice" && !art) prepare();
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
            <Button size="sm" className="mt-2" onClick={close}>Done</Button>
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
            <Button className="w-full" onClick={prepare} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
              {pending ? "Getting it ready…" : props.source === "invoice" ? "Show the QR" : "Send the bill & show the QR"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="text-sm font-semibold text-slate-900">Scan to pay — {money(amount)}</div>
            <img src={art.payQr} alt="Scan to pay by card" className="h-56 w-56 rounded-lg" />
            <p className="max-w-64 text-center text-xs text-slate-500">
              Card, Apple Pay or Google Pay on their phone. It records itself the moment it lands.
            </p>
            <div className="flex w-full flex-wrap justify-center gap-2">
              <a
                href={`sms:?body=${smsBody}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
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
