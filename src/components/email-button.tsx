"use client";

import { useState } from "react";
import { Mail, MessageSquare, Check, Loader2 } from "lucide-react";
import { emailQuote, textQuote } from "@/app/(app)/quotes/actions";
import { emailInvoice, textInvoice } from "@/app/(app)/billing/actions";

type Result = { ok: boolean; error?: string };

function SendChip({
  label,
  icon: Icon,
  run,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => Promise<Result>;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function go() {
    if (!confirm(`${label}?`)) return;
    setState("busy");
    setMsg(null);
    const res = await run();
    if (res.ok) setState("done");
    else {
      setState("error");
      setMsg(res.error ?? "Could not send.");
    }
  }

  return (
    <div className="relative">
      <button
        onClick={go}
        disabled={state === "busy"}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      >
        {state === "busy" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : state === "done" ? (
          <Check className="h-4 w-4 text-green-600" />
        ) : (
          <Icon className="h-4 w-4" />
        )}
        {label}
      </button>
      {state === "error" && msg && (
        <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
          {msg}
        </div>
      )}
    </div>
  );
}

/** Email + Text send controls for a quote or invoice. */
export function EmailButton({ id, kind }: { id: string; kind: "quote" | "invoice" }) {
  return (
    <div className="flex items-center gap-2">
      <SendChip
        label="Email"
        icon={Mail}
        run={() => (kind === "quote" ? emailQuote(id) : emailInvoice(id))}
      />
      <SendChip
        label="Text"
        icon={MessageSquare}
        run={() => (kind === "quote" ? textQuote(id) : textInvoice(id))}
      />
    </div>
  );
}
