"use client";

import { useState } from "react";
import { Check, Loader2, BookOpen } from "lucide-react";
import { sendInvoiceToQuickbooks } from "../actions";

export function QboInvoiceButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function send() {
    setState("busy");
    setMsg(null);
    const res = await sendInvoiceToQuickbooks(id);
    if (res.ok) setState("done");
    else {
      setState("error");
      setMsg(res.error ?? "Could not send.");
    }
  }

  return (
    <div className="relative">
      <button
        onClick={send}
        disabled={state === "busy"}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      >
        {state === "busy" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : state === "done" ? (
          <Check className="h-4 w-4 text-green-600" />
        ) : (
          <BookOpen className="h-4 w-4" />
        )}
        {state === "done" ? "Sent to QuickBooks" : "Send to QuickBooks"}
      </button>
      {state === "error" && msg && (
        <div className="absolute right-0 top-full z-10 mt-1 w-72 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
          {msg}
        </div>
      )}
    </div>
  );
}
