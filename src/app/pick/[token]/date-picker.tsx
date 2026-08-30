"use client";

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Slot = string | { date: string; time?: string };
const norm = (s: Slot): { date: string; time?: string } => (typeof s === "string" ? { date: s } : s);

const fmtDate = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const fmtTime = (t?: string) => {
  if (!t) return "";
  const d = new Date(`2000-01-01T${t}:00`);
  return isNaN(d.getTime()) ? t : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
const label = (s: { date: string; time?: string }) => `${fmtDate(s.date)}${s.time ? ` · ${fmtTime(s.time)}` : ""}`;

export function DatePicker({
  token,
  dates,
  status,
  chosen,
  brand,
}: {
  token: string;
  dates: Slot[];
  status: string;
  chosen: string | null;
  brand: string;
}) {
  const slots = (dates ?? []).map(norm);
  const [pickedLabel, setPickedLabel] = useState<string | null>(
    status === "confirmed" ? (chosen ? fmtDate(chosen) : "your time") : null,
  );
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(i: number) {
    setBusy(i);
    setError(null);
    try {
      const supabase = createClient();
      const { error: rpcErr } = await supabase.rpc("choose_schedule_slot", { p_token: token, p_index: i });
      if (rpcErr) throw rpcErr;
      setPickedLabel(label(slots[i]));
      // Tell the boss (fire-and-forget): the RPC is pure SQL from THIS browser, so no server
      // code saw the booking happen — this hop rings the office bell + push. Best-effort by
      // design; the booking above already stands either way.
      fetch("/api/pick/confirmed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }).catch(() => {});
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong — try again.");
    } finally {
      setBusy(null);
    }
  }

  if (pickedLabel) {
    return (
      <div className="rounded-xl bg-green-50 px-4 py-6 text-center">
        <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-green-600" />
        <div className="font-semibold text-green-800">You&apos;re booked!</div>
        <div className="mt-1 text-sm text-green-700">{pickedLabel} — see you then.</div>
      </div>
    );
  }

  if (status === "cancelled") {
    return <p className="text-center text-sm text-slate-400">This scheduling link was withdrawn — give us a call.</p>;
  }

  // A LINK THAT AGED OUT SAYS SO (0222). Before, an old link still rendered its buttons and
  // every one of them offered a day in the past — the RPC now refuses them, but a page whose
  // buttons all fail is worse than one that explains itself. The phone number is already
  // underneath, so this is a fork rather than a dead end.
  if (status === "expired") {
    return (
      <div className="rounded-xl bg-amber-50 px-4 py-6 text-center">
        <div className="font-semibold text-amber-900">These dates have passed</div>
        <p className="mt-1 text-sm text-amber-800">
          This link is a few weeks old, so the days it offered are gone. Give us a call and
          we&rsquo;ll find you a new time.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {slots.map((s, i) => (
        <button
          key={i}
          onClick={() => choose(i)}
          disabled={busy !== null}
          className="flex w-full items-center justify-between rounded-xl border-2 px-4 py-3.5 text-left text-sm font-semibold transition-colors disabled:opacity-60"
          style={{ borderColor: brand, color: brand }}
        >
          {label(s)}
          {busy === i ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>→</span>}
        </button>
      ))}
    </div>
  );
}
