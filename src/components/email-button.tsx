"use client";

import { useState } from "react";
import { Mail, Check, Loader2 } from "lucide-react";
import { emailQuote } from "@/app/(app)/quotes/actions";
import { emailInvoice } from "@/app/(app)/billing/actions";

export function EmailButton({
  id,
  kind,
}: {
  id: string;
  kind: "quote" | "invoice";
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function send() {
    if (!confirm(`Email this ${kind} to the customer?`)) return;
    setState("sending");
    setMsg(null);
    const res = kind === "quote" ? await emailQuote(id) : await emailInvoice(id);
    if (res.ok) {
      setState("sent");
    } else {
      setState("error");
      setMsg(res.error ?? "Could not send.");
    }
  }

  return (
    <div className="relative">
      <button
        onClick={send}
        disabled={state === "sending"}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      >
        {state === "sending" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : state === "sent" ? (
          <Check className="h-4 w-4 text-green-600" />
        ) : (
          <Mail className="h-4 w-4" />
        )}
        {state === "sent" ? "Emailed" : "Email to customer"}
      </button>
      {state === "error" && msg && (
        <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
          {msg}
        </div>
      )}
    </div>
  );
}
