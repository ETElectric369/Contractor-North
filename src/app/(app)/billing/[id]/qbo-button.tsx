"use client";

import { useState } from "react";
import { Check, Loader2, BookOpen } from "lucide-react";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { sendInvoiceToQuickbooks } from "../actions";

/** Push this invoice to QuickBooks. With `menuItem` the trigger renders as an
 *  Actions-menu row (a rare deliberate verb behind the ⋯ seek door). */
export function QboInvoiceButton({ id, menuItem = false }: { id: string; menuItem?: boolean }) {
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

  if (menuItem) {
    return (
      <>
        <button type="button" onClick={send} disabled={state === "busy"} className={ACTIONS_ROW_CLS}>
          {state === "busy" ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[rgb(var(--glass-ink))]" />
          ) : state === "done" ? (
            <Check className="h-4 w-4 shrink-0 text-green-600" />
          ) : (
            <BookOpen className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" />
          )}
          {state === "done" ? "Sent to QuickBooks" : "Send to QuickBooks"}
        </button>
        {state === "error" && msg && (
          <div className="relative z-10 px-4 py-1.5 text-xs text-red-600">{msg}</div>
        )}
      </>
    );
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
