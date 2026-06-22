"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { DOC_TEMPLATES } from "@/components/doc-templates";
import { setDocTemplateFor } from "./actions";

const DOC_TYPES = [
  { key: "quote", label: "Quotes & estimates" },
  { key: "invoice", label: "Invoices" },
  { key: "contract", label: "Contracts" },
  { key: "change_order", label: "Change orders" },
  { key: "work_order", label: "Work orders" },
];

function Preview({ id, brand }: { id: string; brand: string }) {
  if (id === "modern") {
    return (
      <div className="overflow-hidden rounded border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-1.5 py-1" style={{ backgroundColor: brand }}>
          <div className="h-1 w-6 rounded bg-white/80" />
          <div className="h-1 w-4 rounded bg-white/80" />
        </div>
        <div className="space-y-0.5 p-1.5">
          <div className="h-0.5 w-full rounded bg-slate-200" />
          <div className="h-0.5 w-full rounded bg-slate-200" />
          <div className="h-0.5 w-2/3 rounded bg-slate-200" />
        </div>
      </div>
    );
  }
  if (id === "minimal") {
    return (
      <div className="rounded border border-slate-200 bg-white p-1.5">
        <div className="flex items-center justify-between border-b border-slate-300 pb-1">
          <div className="h-1 w-6 rounded bg-slate-400" />
          <div className="h-1 w-4 rounded bg-slate-300" />
        </div>
        <div className="mt-1 space-y-0.5">
          <div className="h-0.5 w-full rounded bg-slate-200" />
          <div className="h-0.5 w-2/3 rounded bg-slate-200" />
        </div>
      </div>
    );
  }
  return (
    <div className="rounded border border-slate-200 bg-white p-1.5">
      <div className="flex items-center justify-between border-b-2 pb-1" style={{ borderColor: brand }}>
        <div className="flex items-center gap-0.5">
          <div className="h-2 w-2 rounded" style={{ backgroundColor: brand }} />
          <div className="h-1 w-5 rounded bg-slate-400" />
        </div>
        <div className="h-1 w-4 rounded bg-slate-300" />
      </div>
      <div className="mt-1 space-y-0.5">
        <div className="h-0.5 w-full rounded bg-slate-200" />
        <div className="h-0.5 w-2/3 rounded bg-slate-200" />
      </div>
    </div>
  );
}

export function DocumentDesigner({
  templates,
  fallback,
  brand,
}: {
  templates: Record<string, string>;
  fallback: string;
  brand: string;
}) {
  const [map, setMap] = useState<Record<string, string>>(templates ?? {});
  const [pending, start] = useTransition();

  function choose(docType: string, id: string) {
    setMap((m) => ({ ...m, [docType]: id }));
    start(async () => {
      await setDocTemplateFor(docType, id);
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        Choose a style for each document type. You can mix and match — e.g. a bold
        invoice but a minimal work order.
      </p>
      {DOC_TYPES.map((dt) => {
        const selected = map[dt.key] || fallback || "classic";
        return (
          <div key={dt.key}>
            <div className="mb-1.5 text-sm font-medium text-slate-700">{dt.label}</div>
            <div className="grid grid-cols-3 gap-2 sm:max-w-md">
              {DOC_TEMPLATES.map((t) => {
                const active = selected === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => choose(dt.key, t.id)}
                    disabled={pending}
                    className={`relative rounded-lg border-2 p-1.5 text-left transition-colors ${
                      active ? "border-brand bg-brand-light/40" : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    {active && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-white">
                        <Check className="h-2.5 w-2.5" />
                      </span>
                    )}
                    <Preview id={t.id} brand={brand} />
                    <div className="mt-1 text-[11px] font-medium text-slate-600">{t.name}</div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
