"use client";

import { useState } from "react";
import { ArrowLeft, Download } from "lucide-react";

const MARGINS = [
  { v: 0.5, label: "Narrow · ½ in" },
  { v: 0.75, label: "Normal · ¾ in" },
  { v: 1, label: "Wide · 1 in" },
];

export function PdfPreview({ doc, id, back }: { doc: string; id: string; back: string }) {
  const [m, setM] = useState(0.75);
  const src = `/api/pdf/${doc}/${id}?m=${m}`;
  return (
    <div className="flex h-screen flex-col bg-slate-200">
      <div className="flex items-center justify-between gap-3 border-b border-slate-300 bg-white px-4 py-2.5">
        <a href={back || `/`} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" /> Back
        </a>
        <div className="flex items-center gap-2">
          <label htmlFor="pdf-margin" className="text-xs font-medium text-slate-500">Margins</label>
          <select
            id="pdf-margin"
            value={m}
            onChange={(e) => setM(Number(e.target.value))}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {MARGINS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
          <a
            href={src}
            download
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
          >
            <Download className="h-4 w-4" /> Download PDF
          </a>
        </div>
      </div>
      {/* The browser's built-in PDF viewer: real pages, zoom, its own print button —
          showing EXACTLY the bytes the customer gets. key= forces a clean reload per margin. */}
      <iframe key={m} src={src} title="Document PDF" className="min-h-0 w-full flex-1" />
    </div>
  );
}
