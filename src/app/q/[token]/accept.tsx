"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { acceptPublicQuote } from "./actions";

type Outcome = "open" | "accepted" | "declined";

/**
 * THE DEPOSIT, AS public_quote STATES IT (cn-v1177, 0414): the figure the estimate stored, where its
 * deposit request stands, and whether the company can take a card. "none" = no deposit stated (null,
 * 0, or an estimate saved before 0414). Read by the page (depositFromProjection) and handed down.
 */
export type PublicDeposit = {
  amount: number;
  state: "none" | "due" | "requested" | "paid";
  canTakeCard: boolean;
  /** cn-v1178 (0416): what is still owed (deposit_due, else the ask); absent = the ask. */
  owed?: number;
  /** What was already received on a partly paid request; 0 or absent = nothing yet. */
  received?: number;
  /** What the card door will charge: what is owed plus the company's card fee (cardFeeDecision). */
  charge?: number;
  /** The card fee, as the invoice's own pay page says it; null or absent = none. */
  fee?: { pct: string; amount: number } | null;
};

/**
 * What the customer reads about the deposit once the estimate is accepted. PAYING IS NEVER REQUIRED TO
 * ACCEPT: this shows only after the yes, and the yes made no money record (the card door below finds
 * or makes the one deposit bill when, and only when, the customer taps it). Customer words, English.
 */
function DepositAfterYes({ token, deposit, trouble }: { token: string; deposit: PublicDeposit; trouble?: string | null }) {
  if (deposit.state === "none" || !(deposit.amount > 0)) return null;
  if (deposit.state === "paid") {
    return <p className="mt-3 text-center text-sm font-medium text-slate-700">Deposit received. Thank you.</p>;
  }
  // WHAT THE CARD DOOR CHARGES (cn-v1178, audit B3): what is still owed, plus the card fee when the
  // company charges one; a partly paid deposit says what was received and what is left.
  const owed = typeof deposit.owed === "number" && Number.isFinite(deposit.owed) ? deposit.owed : deposit.amount;
  if (!(owed > 0.005)) return <p className="mt-3 text-center text-sm font-medium text-slate-700">Deposit received. Thank you.</p>;
  const received = deposit.received && deposit.received > 0.005 ? deposit.received : 0;
  const partly = received > 0 ? (
    <p className="mb-2 text-sm text-slate-700">
      We received {formatCurrency(received)} of your {formatCurrency(deposit.amount)} deposit. {formatCurrency(owed)} is left.
    </p>
  ) : null;
  if (!deposit.canTakeCard) {
    return (
      <div className="mt-3 text-center">
        {partly}
        <p className="text-sm text-slate-700">A deposit of {formatCurrency(owed)} is due. We&apos;ll be in touch about how to pay it.</p>
      </div>
    );
  }
  const charge = typeof deposit.charge === "number" && deposit.charge > 0 ? deposit.charge : owed;
  return (
    <div className="mt-3 text-center">
      {trouble && <p className="mb-2 text-sm text-slate-700">{trouble}</p>}
      {partly}
      <a
        href={`/api/pay/deposit/${encodeURIComponent(token)}`}
        className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-slate-800"
      >
        Pay the Deposit · {formatCurrency(charge)} by Card
      </a>
      {deposit.fee && deposit.fee.amount > 0 && (
        <p className="mt-1.5 text-xs text-slate-500">
          Includes a {deposit.fee.pct}% card processing fee of {formatCurrency(deposit.fee.amount)}.
        </p>
      )}
    </div>
  );
}

export function PublicQuoteAccept({
  token,
  accepted,
  declined,
  brand,
  docLabel = "Quote",
  deposit = { amount: 0, state: "none", canTakeCard: false },
  depositTrouble = null,
}: {
  token: string;
  accepted: boolean;
  declined?: boolean;
  brand: string;
  /** "Estimate" or "Quote" — so the button/outcome copy matches the doc type. */
  docLabel?: string;
  /** The deposit public_quote states (cn-v1177); absent = none. */
  deposit?: PublicDeposit;
  /** The card door came back refused (?deposit=unavailable): the page's one plain line. */
  depositTrouble?: string | null;
}) {
  const [outcome, setOutcome] = useState<Outcome>(accepted ? "accepted" : declined ? "declined" : "open");
  const [busy, setBusy] = useState<null | "accept" | "decline">(null);
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setBusy("accept");
    setErr(null);
    // ONE server call (cn-v1133): the RPC accepts, the job's tasks, work order and materials list are
    // born (the same rules as the office's accept) and THEN the office is pinged — all awaited on the
    // server, so closing this tab the moment the button is pressed loses none of it. The button says
    // "Accepting…" while the call is out; a refusal keeps its own words.
    let res: Awaited<ReturnType<typeof acceptPublicQuote>>;
    try {
      res = await acceptPublicQuote(token);
    } catch {
      res = { ok: false, error: "Could not accept. Please try again." };
    }
    if (!res.ok) {
      setErr(res.error);
      setBusy(null);
      return;
    }
    setOutcome("accepted");
    setBusy(null);
  }

  async function decline() {
    setBusy("decline");
    setErr(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("decline_public_quote", { p_token: token });
    if (error || !data?.ok) {
      setErr(error?.message ?? data?.error ?? "Could not decline. Please try again.");
      setBusy(null);
      return;
    }
    setOutcome("declined");
    setBusy(null);
  }

  if (outcome === "accepted") {
    return (
      <div className="no-print">
        <div className="flex items-center justify-center gap-2 rounded-xl bg-green-50 px-4 py-3 text-sm font-medium text-green-700">
          <Check className="h-5 w-5" /> {docLabel} accepted — thank you! We'll be in touch to schedule.
        </div>
        <DepositAfterYes token={token} deposit={deposit} trouble={depositTrouble} />
      </div>
    );
  }

  if (outcome === "declined") {
    return (
      <div className="no-print flex items-center justify-center gap-2 rounded-xl bg-slate-100 px-4 py-3 text-sm font-medium text-slate-600">
        <X className="h-5 w-5" /> {docLabel} declined. Thanks for letting us know — reach out if anything changes.
      </div>
    );
  }

  return (
    <div className="no-print text-center">
      {err && <p className="mb-2 text-sm text-red-600">{err}</p>}
      <button
        onClick={accept}
        disabled={busy !== null}
        className="inline-flex items-center gap-2 rounded-xl px-6 py-3 text-base font-semibold text-white shadow-sm disabled:opacity-60"
        style={{ backgroundColor: brand }}
      >
        {busy === "accept" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
        {busy === "accept" ? "Accepting…" : `Accept This ${docLabel}`}
      </button>
      <p className="mt-1.5 text-xs text-slate-400">Accepting lets us schedule your work.</p>
      <button
        onClick={decline}
        disabled={busy !== null}
        className="mt-3 inline-flex items-center gap-1.5 text-sm text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline disabled:opacity-60"
      >
        {busy === "decline" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Decline This {docLabel}
      </button>
    </div>
  );
}
