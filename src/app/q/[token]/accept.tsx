"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { notifyQuoteAccepted } from "./actions";

export function PublicQuoteAccept({
  token,
  accepted,
  brand,
}: {
  token: string;
  accepted: boolean;
  brand: string;
}) {
  const [done, setDone] = useState(accepted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setErr(null);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("accept_public_quote", {
      p_token: token,
    });
    if (error || !data?.ok) {
      setErr(error?.message ?? data?.error ?? "Could not accept. Please try again.");
      setBusy(false);
      return;
    }
    setDone(true);
    setBusy(false);
    void notifyQuoteAccepted(token); // fire-and-forget office ping (best-effort)
  }

  if (done) {
    return (
      <div className="no-print flex items-center justify-center gap-2 rounded-xl bg-green-50 px-4 py-3 text-sm font-medium text-green-700">
        <Check className="h-5 w-5" /> Quote accepted — thank you! We'll be in touch to schedule.
      </div>
    );
  }

  return (
    <div className="no-print text-center">
      {err && <p className="mb-2 text-sm text-red-600">{err}</p>}
      <button
        onClick={accept}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-xl px-6 py-3 text-base font-semibold text-white shadow-sm disabled:opacity-60"
        style={{ backgroundColor: brand }}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
        Accept this quote
      </button>
      <p className="mt-1.5 text-xs text-slate-400">
        Accepting lets us schedule your work.
      </p>
    </div>
  );
}
