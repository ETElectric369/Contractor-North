"use client";

/* eslint-disable @next/next/no-img-element -- the QRs are data URLs; next/image adds nothing */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeDollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { collectArtifacts, recordPayment, settleUp } from "@/app/(app)/billing/actions";

/**
 * PAY NOW — the last step of the critical path, forked by how money actually moves.
 *
 * Erik: "a pay now button is what we are missing and that can trigger the cc processing or if i
 * choose the others like cash then it closes, if i choose venmo then it gives me my venmo qr to
 * show the customer on the spot."
 *
 *   CASH / CHECK / OTHER → record it, close it. Money already moved; the app just writes it down.
 *   VENMO               → the org's Venmo QR, amount and invoice number filled in, held up to the
 *                          customer. Venmo can't call back, so "They paid" records it by hand.
 *   CARD                → a QR of the invoice's own Stripe checkout — the customer pays ON THEIR
 *                          PHONE (card / Apple Pay / Google Pay) and the webhook records it
 *                          itself. The socket true tap-to-pay plugs into later.
 *
 * Two mounting modes, one flow:
 *   source: appointment/job  — settles the whole chain first (invoice + line + sent + visit
 *                              completed + lead won) via settleUp, then collects.
 *   invoice                  — the invoice already exists ("done will form a total somehow");
 *                              this only collects against its balance.
 */
type Mode =
  | { source: "appointment" | "job"; id: string; invoiceId?: never; balance?: never }
  | { source: "invoice"; invoiceId: string; balance: number; id?: never };

type QrState = {
  kind: "venmo" | "card";
  qr: string;
  url?: string;
  handle?: string;
  invoiceId: string;
  amount: number;
};

export function SettleUpButton(props: Mode & { compact?: boolean; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(props.source === "invoice" ? String(props.balance || "") : "");
  const [method, setMethod] = useState("cash");
  const [qr, setQr] = useState<QrState | null>(null);

  const amt = () => Number(String(amount).replace(/[$,\s]/g, ""));

  /** The invoice this collection runs against — created on the spot for a visit/job source. */
  async function ensureInvoice(m: string, collect: "record" | "later"): Promise<string | null> {
    if (props.source === "invoice") {
      if (collect === "record") {
        const r = await recordPayment({ invoice_id: props.invoiceId, amount: amt(), method: m, note: "" });
        if (!r.ok) { toast(r.error ?? "Couldn't record that.", "error"); return null; }
      }
      return props.invoiceId;
    }
    const res = await settleUp({ source: props.source, id: props.id, amount: amt(), method: m, collect }).catch(() => ({
      ok: false as const,
      error: "That didn't reach the server — check your connection and try again.",
    }));
    if (!res.ok) {
      toast(res.error ?? "Couldn't settle that.", "error");
      if ("invoiceId" in res && res.invoiceId) router.push(`/billing/${res.invoiceId}`);
      return null;
    }
    return res.invoiceId ?? null;
  }

  function go() {
    if (!Number.isFinite(amt()) || amt() <= 0) {
      toast("Enter what they're paying.", "error");
      return;
    }
    start(async () => {
      if (method === "venmo" || method === "card") {
        // Build the bill, leave the balance open, and put the door in front of the customer.
        const invoiceId = await ensureInvoice(method, "later");
        if (!invoiceId) return;
        const art = await collectArtifacts(invoiceId, amt());
        if (!art.ok) { toast(art.error ?? "Couldn't build the payment code.", "error"); return; }
        if (method === "venmo") {
          if (!art.venmoQr) {
            toast("Add your Venmo username in Settings → Payment methods first.", "error");
            router.push(`/billing/${invoiceId}`);
            return;
          }
          setQr({ kind: "venmo", qr: art.venmoQr, handle: art.venmoHandle, invoiceId, amount: Math.min(amt(), art.balance ?? amt()) });
          return;
        }
        if (!art.payQr) {
          // Stripe isn't connected — record it as a card payment taken some other way rather
          // than dead-ending with cash in the air.
          const r = await recordPayment({ invoice_id: invoiceId, amount: amt(), method: "card", note: "" });
          toast(r.ok ? `Recorded — $${amt().toLocaleString()} card.` : (r.error ?? "Couldn't record that."), r.ok ? "success" : "error");
          if (r.ok) { setOpen(false); router.refresh(); }
          return;
        }
        // The card QR opens Stripe Checkout for the invoice's FULL BALANCE (that is what /api/pay
        // charges) — the header must say that number, not the typed one, or the screen promises
        // one figure and the customer's phone asks another.
        setQr({ kind: "card", qr: art.payQr, url: art.payUrl, invoiceId, amount: art.balance ?? amt() });
        return;
      }
      // Cash-like: money already moved, write it down, done.
      const invoiceId = await ensureInvoice(method, "record");
      if (!invoiceId) return;
      toast(`Paid — $${amt().toLocaleString()} ${method}. Done.`, "success");
      setOpen(false);
      setAmount(props.source === "invoice" ? String(props.balance || "") : "");
      router.refresh();
    });
  }

  /** Venmo's half-blind ending: the app can't hear the payment land, so the person says so. */
  function venmoPaid() {
    if (!qr) return;
    start(async () => {
      const r = await recordPayment({ invoice_id: qr.invoiceId, amount: qr.amount, method: "venmo", note: "" });
      if (!r.ok) { toast(r.error ?? "Couldn't record that.", "error"); return; }
      toast(`Paid — $${qr.amount.toLocaleString()} Venmo. Done.`, "success");
      setQr(null);
      setOpen(false);
      router.refresh();
    });
  }

  if (qr) {
    return (
      <span className="inline-flex flex-col items-center gap-2 rounded-xl border border-brand/40 bg-white p-3 shadow-lg">
        <span className="text-sm font-semibold text-slate-900">
          {qr.kind === "venmo" ? `Venmo @${qr.handle}` : "Scan to pay by card"} — ${qr.amount.toLocaleString()}
        </span>
        <img src={qr.qr} alt="Payment QR code" className="h-56 w-56 rounded-lg" />
        {qr.kind === "venmo" ? (
          <Button size="sm" onClick={venmoPaid} disabled={pending}>
            {pending ? "Recording…" : "They paid — record it"}
          </Button>
        ) : (
          <span className="max-w-56 text-center text-xs text-slate-500">
            Card, Apple Pay or Google Pay on their phone — it records itself when it lands.
          </span>
        )}
        <button
          type="button"
          onClick={() => { setQr(null); setOpen(false); router.refresh(); }}
          className="text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          Close
        </button>
      </span>
    );
  }

  if (!open) {
    return (
      <Button
        size="sm"
        variant={props.compact ? "outline" : "primary"}
        onClick={() => {
          // A partial payment refreshes the server's balance — re-seed the box on every open so
          // the prefill can't be last visit's number.
          if (props.source === "invoice") setAmount(String(props.balance || ""));
          setOpen(true);
        }}
      >
        <BadgeDollarSign className="h-4 w-4" /> {props.label ?? "Pay now"}
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
          if (e.key === "Enter") { e.preventDefault(); go(); }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="$ amount"
        aria-label="What they're paying"
        className="h-9 w-24 rounded-lg border border-slate-200 px-2 text-sm"
      />
      <span className="inline-flex overflow-hidden rounded-lg border border-slate-200">
        {(["card", "cash", "check", "venmo", "other"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMethod(m)}
            className={`px-2 py-1.5 text-xs font-semibold capitalize ${
              method === m ? "bg-brand text-white" : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            {m}
          </button>
        ))}
      </span>
      <Button size="sm" onClick={go} disabled={pending}>
        {pending ? "Working…" : method === "venmo" ? "Show QR" : method === "card" ? "Charge" : "Record it"}
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
