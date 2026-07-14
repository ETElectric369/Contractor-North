"use client";

import { useState } from "react";
import { CalendarClock, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { publicScheduleInspection } from "@/lib/actions/public-schedule";
import { notifyNewInquiry } from "./actions";

export function InquiryForm({
  org,
  brandColor,
  refId = null,
  calendlyUrl = "",
}: {
  org: string;
  brandColor: string;
  refId?: string | null;
  /** Org's external scheduling link (https-validated server-side). Empty = built-in /pick flow. */
  calendlyUrl?: string;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [stateName, setStateName] = useState("");
  const [zip, setZip] = useState("");
  const [message, setMessage] = useState("");
  const [hp, setHp] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-submit "schedule your site visit" (the built-in /pick flow).
  const [scheduling, setScheduling] = useState(false);
  const [schedDone, setSchedDone] = useState(false);
  const [schedError, setSchedError] = useState<string | null>(null);

  async function scheduleVisit() {
    setSchedError(null);
    setScheduling(true);
    try {
      const res = await publicScheduleInspection({
        orgId: org,
        name, phone, email, address, city, state: stateName, zip, message, hp,
      });
      if (!res.ok) { setSchedError(res.error ?? "Something went wrong — please call us instead."); return; }
      if (res.token) { window.location.assign(`/pick/${res.token}`); return; }
      // Bot-trap fake success or an office-made booking already exists — just confirm.
      setSchedDone(true);
    } catch {
      setSchedError("Something went wrong — please call us instead.");
    } finally {
      setScheduling(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Please enter your name.");
    if (!phone.trim() && !email.trim()) return setError("Please add a phone or email so we can reach you.");
    if (hp) { setDone(true); return; } // bot trap
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: rpcErr } = await supabase.rpc("submit_inquiry", {
        p_org: org,
        p_name: name,
        p_email: email || null,
        p_phone: phone || null,
        p_message: message || null,
        p_address: address || null,
        p_city: city || null,
        p_state: stateName || null,
        p_zip: zip || null,
        p_ref: refId, // referral attribution — validated org-side, never blocks the lead
      });
      if (rpcErr) throw rpcErr;
      setDone(true);
      void notifyNewInquiry(org); // fire-and-forget office ping (best-effort)
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong. Please call us instead.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl bg-white/75 p-8 text-center shadow-xl backdrop-blur-md">
        <CheckCircle2 className="mx-auto h-12 w-12" style={{ color: brandColor }} />
        <h2 className="mt-3 text-xl font-bold text-slate-900">Thank you!</h2>
        <p className="mt-1 text-slate-600">We got your request and will reach out shortly.</p>

        {/* Don't make them wait for the phone tag — schedule the site visit now. */}
        {schedDone ? (
          <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            You&apos;re on the schedule — we&apos;ll confirm your time shortly.
          </p>
        ) : calendlyUrl ? (
          <a
            href={calendlyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-white"
            style={{ backgroundColor: brandColor }}
          >
            <CalendarClock className="h-4 w-4" /> Schedule your site visit <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : (
          <button
            type="button"
            onClick={scheduleVisit}
            disabled={scheduling}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: brandColor }}
          >
            {scheduling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
            {scheduling ? "One moment…" : "Schedule your site visit"}
          </button>
        )}
        {schedError && <p className="mt-2 text-sm text-red-600">{schedError}</p>}
        {!schedDone && !calendlyUrl && (
          <p className="mt-2 text-xs text-slate-400">Pick a time that works — we&apos;ll lock it in.</p>
        )}
      </div>
    );
  }

  const field = "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2";
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl bg-white/70 p-6 shadow-xl backdrop-blur-md">
      <h2 className="text-lg font-bold text-slate-900">Request an estimate</h2>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name *" className={field} style={{ ["--tw-ring-color" as any]: brandColor }} />
      <div className="grid grid-cols-2 gap-3">
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" className={field} inputMode="tel" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className={field} inputMode="email" />
      </div>
      <AddressAutocomplete
        placeholder="Job address"
        onTextChange={setAddress}
        onResolved={(p) => {
          if (p.formatted) setAddress(p.formatted);
          setCity(p.city);
          setStateName(p.state);
          setZip(p.zip);
        }}
      />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What do you need help with?" rows={4} className={field} />
      {/* honeypot — hidden from humans */}
      <input value={hp} onChange={(e) => setHp(e.target.value)} tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
        style={{ backgroundColor: brandColor }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Sending…" : "Send request"}
      </button>
      <p className="text-center text-[11px] text-slate-400">We'll never share your information.</p>
    </form>
  );
}
