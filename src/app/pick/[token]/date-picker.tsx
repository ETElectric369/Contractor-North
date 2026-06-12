"use client";

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const fmt = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

export function DatePicker({
  token,
  dates,
  status,
  chosen,
  brand,
}: {
  token: string;
  dates: string[];
  status: string;
  chosen: string | null;
  brand: string;
}) {
  const [picked, setPicked] = useState<string | null>(status === "confirmed" ? chosen : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(d: string) {
    setBusy(d);
    setError(null);
    try {
      const supabase = createClient();
      const { error: rpcErr } = await supabase.rpc("choose_schedule_date", {
        p_token: token,
        p_date: d,
      });
      if (rpcErr) throw rpcErr;
      setPicked(d);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong — try again.");
    } finally {
      setBusy(null);
    }
  }

  if (picked) {
    return (
      <div className="rounded-xl bg-green-50 px-4 py-6 text-center">
        <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-green-600" />
        <div className="font-semibold text-green-800">You&apos;re booked!</div>
        <div className="mt-1 text-sm text-green-700">{fmt(picked)} — we&apos;ll see you in the morning.</div>
      </div>
    );
  }

  if (status === "cancelled") {
    return <p className="text-center text-sm text-slate-400">This scheduling link was withdrawn — give us a call.</p>;
  }

  return (
    <div className="space-y-2">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {dates.map((d) => (
        <button
          key={d}
          onClick={() => choose(d)}
          disabled={busy !== null}
          className="flex w-full items-center justify-between rounded-xl border-2 px-4 py-3.5 text-left text-sm font-semibold transition-colors disabled:opacity-60"
          style={{ borderColor: brand, color: brand }}
        >
          {fmt(d)}
          {busy === d ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>→</span>}
        </button>
      ))}
    </div>
  );
}
