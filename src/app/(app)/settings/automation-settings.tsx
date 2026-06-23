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
  const [, start] = useTransition();

  function set(patch: Record<string, boolean>) {
    start(async () => { await updateOrgSettings(patch); });
  }

  const rows: { label: string; desc: string; on: boolean; set: (v: boolean) => void; key: string }[] = [
    { label: "Auto-send invoice when a job is finished", desc: "Email the draft invoice to the customer the moment a job is marked complete. Off = hold it in “To be invoiced” for review. Overridable per-job at the finish step.", on: autoSend, set: setAutoSend, key: "auto_send_invoice_on_complete" },
    { label: "Copy me on customer emails", desc: "BCC yourself on every invoice, quote, contract, and portal-link email — so you always have a copy and can confirm it actually sent.", on: copyOwner, set: setCopyOwner, key: "copy_owner_on_emails" },
    { label: "Quote follow-ups", desc: "Auto email/SMS nudges on quotes that haven't been accepted.", on: followup, set: setFollowup, key: "remind_quote_followup" },
    { label: "Invoice payment reminders", desc: "Remind customers about due & overdue invoices.", on: invoiceDue, set: setInvoiceDue, key: "remind_invoice_due" },
    { label: "Appointment confirmations & reminders", desc: "Confirm and remind customers about scheduled visits.", on: appts, set: setAppts, key: "remind_appointments" },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
        Preferences save now. The automated send engine (email + SMS) turns on once Twilio/Resend
        keys are added — your choices here will drive it.
      </div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-4 px-4 py-3">
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-900">{r.label}</div>
              <div className="text-xs text-slate-400">{r.desc}</div>
            </div>
            <Toggle on={r.on} onChange={(v) => { r.set(v); set({ [r.key]: v }); }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
