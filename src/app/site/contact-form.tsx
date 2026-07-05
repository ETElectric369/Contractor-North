"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, ArrowRight } from "lucide-react";
import { submitSiteContact } from "./actions";

/** On-page "request an estimate / get in touch" form for the org marketing site — keeps the
 *  visitor on the branded page instead of bouncing to a separate inquiry page. */
export function ContactForm({ orgId, brand, heading }: { orgId: string; brand: string; heading: string }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [hp, setHp] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Please enter your name.");
    if (!phone.trim() && !email.trim()) return setError("Add a phone or email so we can reach you.");
    setBusy(true);
    try {
      const res = await submitSiteContact(orgId, { name, phone, email, message, hp });
      if (!res.ok) { setError(res.error ?? "Something went wrong."); return; }
      setDone(true);
    } catch {
      setError("Something went wrong — please call us instead.");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2";
  const ring = { ["--tw-ring-color" as string]: brand } as React.CSSProperties;

  if (done) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12" style={{ color: brand }} />
        <h3 className="mt-3 text-xl font-bold text-slate-900">Thanks — we&apos;ve got it</h3>
        <p className="mt-1 text-slate-600">We&apos;ll reach out shortly.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-lg space-y-3 rounded-2xl border border-slate-200 bg-white p-6">
      <h3 className="text-lg font-bold text-slate-900">{heading}</h3>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <input className={field} style={ring} placeholder="Your name *" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-2 gap-3">
        <input className={field} style={ring} placeholder="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input className={field} style={ring} placeholder="Email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <textarea className={field} style={ring} rows={4} placeholder="Tell us about your project…" value={message} onChange={(e) => setMessage(e.target.value)} />
      <input value={hp} onChange={(e) => setHp(e.target.value)} tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
      <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: brand }}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Sending…" : "Send request"}
        {!busy && <ArrowRight className="h-4 w-4" />}
      </button>
    </form>
  );
}
