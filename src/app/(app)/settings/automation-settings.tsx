"use client";

import { useState, useTransition } from "react";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 rounded-full transition-colors ${on ? "bg-brand" : "bg-slate-300"}`}
      aria-pressed={on}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function AutomationSettings({ settings }: { settings: OrgSettings }) {
  const [followup, setFollowup] = useState(settings.remind_quote_followup);
  const [invoiceDue, setInvoiceDue] = useState(settings.remind_invoice_due);
  const [appts, setAppts] = useState(settings.remind_appointments);
  const [autoSend, setAutoSend] = useState(settings.auto_send_invoice_on_complete);
  const [copyOwner, setCopyOwner] = useState(settings.copy_owner_on_emails);
  const [noReview, setNoReview] = useState(settings.send_without_review);
  const [, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Save a toggle. On failure REVERT the optimistic flip + surface the error, so the switch
  // can never sit showing a state that didn't actually save (these gate real customer email).
  function set(patch: Record<string, boolean>, revert: () => void) {
    setErr(null);
    start(async () => {
      const res = await updateOrgSettings(patch);
      if (!res.ok) { revert(); setErr(res.error ?? "Couldn't save — try again."); }
      else { setSaved(true); setTimeout(() => setSaved(false), 1500); }
    });
  }

  const rows: { label: string; desc: string; on: boolean; set: (v: boolean) => void; key: string }[] = [
    { label: "Auto-send invoice when a job is finished", desc: "Pre-ticks the send box when a job is finished. With Send Without Review off, the send sheet opens on the draft so you can read it first; with it on, the invoice emails at once. Off = hold it in “To be invoiced” for review. Overridable per-job at the finish step.", on: autoSend, set: setAutoSend, key: "auto_send_invoice_on_complete" },
    { label: "Copy me on customer emails", desc: "A copy of every invoice, quote, contract, and portal-link email goes to the sender’s own email, else the company’s — so you always have a copy and can confirm it actually sent.", on: copyOwner, set: setCopyOwner, key: "copy_owner_on_emails" },
    { label: "Send Without Review", desc: "On, Email It and Text It send at once with today's words. Off, you see the address, the subject and the message first and can change them for that send.", on: noReview, set: setNoReview, key: "send_without_review" },
    { label: "Quote follow-ups", desc: "Auto email nudges on quotes that haven't been accepted.", on: followup, set: setFollowup, key: "remind_quote_followup" },
    { label: "Invoice payment reminders", desc: "Remind customers about due & overdue invoices.", on: invoiceDue, set: setInvoiceDue, key: "remind_invoice_due" },
    { label: "Appointment confirmations & reminders", desc: "Confirm and remind customers about scheduled visits.", on: appts, set: setAppts, key: "remind_appointments" },
  ];

  return (
    <div className="space-y-4">
      {/* THE TRUTH ABOUT THE CHANNEL (2026-09-24). This banner said "the automated send engine
          (email + SMS) turns on once Twilio/Resend keys are added" long after email went live, and
          the reminders engine (lib/reminders-engine) has only ever sent email. Texting has its own
          card below, which says whether it can send at all. */}
      <p className="text-xs text-slate-500">
        These go out by email, to the customer&apos;s email on file. A customer with no email is skipped.
      </p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-4 px-4 py-3">
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-900">{r.label}</div>
              <div className="text-xs text-slate-400">{r.desc}</div>
            </div>
            <Toggle on={r.on} onChange={(v) => { const prev = r.on; r.set(v); set({ [r.key]: v }, () => r.set(prev)); }} />
          </li>
        ))}
      </ul>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {saved && <p className="text-sm font-medium text-green-600">Saved</p>}
    </div>
  );
}
