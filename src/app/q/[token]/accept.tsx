"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { notifyQuoteAccepted } from "./actions";

type Outcome = "open" | "accepted" | "declined";

export function PublicQuoteAccept({
  token,
  accepted,
  declined,
  brand,
  docLabel = "Quote",
}: {
  token: string;
  accepted: boolean;
  declined?: boolean;
  brand: string;
  /** "Estimate" or "Quote" — so the button/outcome copy matches the doc type. */
  docLabel?: string;
}) {
  const lower = docLabel.toLowerCase();
  const [outcome, setOutcome] = useState<Outcome>(accepted ? "accepted" : declined ? "declined" : "open");
  const [busy, setBusy] = useState<null | "accept" | "decline">(null);
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setBusy("accept");
    setErr(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("accept_public_quote", { p_token: token });
    if (error || !data?.ok) {
      setErr(error?.message ?? data?.error ?? "Could not accept. Please try again.");
      setBusy(null);
      return;
    }
    setOutcome("accepted");
    setBusy(null);
    void notifyQuoteAccepted(token); // fire-and-forget office ping (best-effort)
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
      <div className="no-print flex items-center justify-center gap-2 rounded-xl bg-green-50 px-4 py-3 text-sm font-medium text-green-700">
        <Check className="h-5 w-5" /> {docLabel} accepted — thank you! We'll be in touch to schedule.
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
        Accept this {lower}
      </button>
      <p className="mt-1.5 text-xs text-slate-400">Accepting lets us schedule your work.</p>
      <button
        onClick={decline}
        disabled={busy !== null}
        className="mt-3 inline-flex items-center gap-1.5 text-sm text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline disabled:opacity-60"
      >
        {busy === "decline" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        No thanks, decline this {lower}
      </button>
    </div>
  );
}
