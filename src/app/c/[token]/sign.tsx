"use client";

import { useState } from "react";

/** Public e-signature: the customer types their full legal name, consents, and signs.
 *  POSTs to /api/contracts/sign so the server captures IP + user-agent with the record
 *  (ESIGN/UETA: intent + consent + attribution + a retained, frozen contract body). */
export function ContractSign({ token, brand }: { token: string; brand: string }) {
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function sign() {
    setErr(null);
    if (!name.trim()) return setErr("Type your full legal name to sign.");
    if (!agree) return setErr("Please check the box to agree before signing.");
    setBusy(true);
    try {
      const res = await fetch("/api/contracts/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name }),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) {
        setErr(data.error ?? "Could not record your signature. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setErr("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl bg-green-50 px-5 py-4 text-sm text-green-800">
        <div className="font-semibold">Thank you — your contract is signed.</div>
        <div className="mt-1">A copy has been recorded and sent to your contractor.</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 p-5">
      <div className="text-sm font-semibold text-slate-900">Sign this contract</div>
      <p className="mt-1 text-xs text-slate-500">Type your full legal name exactly as it should appear on the agreement.</p>
      {err && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Full legal name"
        autoComplete="name"
        className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
        style={name.trim() ? { fontFamily: "cursive" } : undefined}
      />
      <label className="mt-3 flex items-start gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
        <span>
          I have read and agree to the scope, price, schedule, and terms of this contract, and I consent to sign it
          electronically. I understand my typed name and the date are my legal signature.
        </span>
      </label>
      <button
        type="button"
        onClick={sign}
        disabled={busy}
        className="mt-4 inline-flex items-center justify-center rounded-xl px-6 py-3 text-base font-semibold text-white shadow-sm disabled:opacity-60"
        style={{ backgroundColor: brand }}
      >
        {busy ? "Signing…" : "Sign contract"}
      </button>
    </div>
  );
}
