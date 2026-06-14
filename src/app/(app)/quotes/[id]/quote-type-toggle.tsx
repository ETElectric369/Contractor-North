"use client";

import { useState, useTransition } from "react";
import { setQuoteType } from "../actions";

/** Fixed-price quote vs time-&-materials estimate — same document, the label and
 *  the printed wording follow this. */
export function QuoteTypeToggle({ id, value }: { id: string; value: "estimate" | "quote" }) {
  const [type, setType] = useState<"estimate" | "quote">(value);
  const [pending, start] = useTransition();

  function pick(t: "estimate" | "quote") {
    if (t === type || pending) return;
    setType(t);
    start(() => {
      void setQuoteType(id, t);
    });
  }

  return (
    <div
      className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs"
      title="Quote = fixed price · Estimate = time & materials"
    >
      <button
        onClick={() => pick("quote")}
        disabled={pending}
        className={`rounded-md px-2.5 py-1 font-medium ${type === "quote" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
      >
        Quote (fixed)
      </button>
      <button
        onClick={() => pick("estimate")}
        disabled={pending}
        className={`rounded-md px-2.5 py-1 font-medium ${type === "estimate" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
      >
        Estimate (T&amp;M)
      </button>
    </div>
  );
}
