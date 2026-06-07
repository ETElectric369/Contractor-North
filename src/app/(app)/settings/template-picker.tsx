"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { DOC_TEMPLATES } from "@/components/doc-templates";
import { setDocTemplate } from "./actions";

/** Mini visual preview of each template style. */
function Preview({ id, brand }: { id: string; brand: string }) {
  if (id === "modern") {
    return (
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-2 py-1.5" style={{ backgroundColor: brand }}>
          <div className="h-1.5 w-10 rounded bg-white/80" />
          <div className="h-1.5 w-6 rounded bg-white/80" />
        </div>
        <div className="space-y-1 p-2">
          <div className="h-1 w-full rounded bg-slate-200" />
          <div className="h-1 w-full rounded bg-slate-200" />
          <div className="h-1 w-2/3 rounded bg-slate-200" />
        </div>
      </div>
    );
  }
  if (id === "minimal") {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-2">
        <div className="flex items-center justify-between border-b border-slate-300 pb-1.5">
          <div className="h-1.5 w-10 rounded bg-slate-400" />
          <div className="h-1.5 w-6 rounded bg-slate-300" />
        </div>
        <div className="mt-2 space-y-1">
          <div className="h-1 w-full rounded bg-slate-200" />
          <div className="h-1 w-full rounded bg-slate-200" />
          <div className="h-1 w-2/3 rounded bg-slate-200" />
        </div>
      </div>
    );
  }
  // classic
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <div className="flex items-center justify-between border-b-2 pb-1.5" style={{ borderColor: brand }}>
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rounded" style={{ backgroundColor: brand }} />
          <div className="h-1.5 w-8 rounded bg-slate-400" />
        </div>
        <div className="h-1.5 w-6 rounded bg-slate-300" />
      </div>
      <div className="mt-2 space-y-1">
        <div className="h-1 w-full rounded bg-slate-200" />
        <div className="h-1 w-full rounded bg-slate-200" />
        <div className="h-1 w-2/3 rounded bg-slate-200" />
      </div>
    </div>
  );
}

export function TemplatePicker({
  current,
  brand,
}: {
  current: string;
  brand: string;
}) {
  const [selected, setSelected] = useState(current);
  const [pending, start] = useTransition();

  function choose(id: string) {
    setSelected(id);
    start(async () => {
      await setDocTemplate(id);
    });
  }

  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">
        Pick the look for your printed quotes and invoices.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {DOC_TEMPLATES.map((t) => {
          const active = selected === t.id;
          return (
            <button
              key={t.id}
              onClick={() => choose(t.id)}
              disabled={pending}
              className={`relative rounded-xl border-2 p-3 text-left transition-colors ${
                active ? "border-brand bg-brand-light/40" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              {active && (
                <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white">
                  <Check className="h-3 w-3" />
                </span>
              )}
              <Preview id={t.id} brand={brand} />
              <div className="mt-2 text-sm font-semibold text-slate-900">{t.name}</div>
              <div className="text-xs text-slate-500">{t.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
