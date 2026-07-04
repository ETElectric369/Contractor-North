"use client";

import { Printer } from "lucide-react";

/** Triggers the browser print dialog (→ "Save as PDF"). Hidden when printing. */
export function PrintButton({ label = "Print / Save PDF" }: { label?: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
    >
      <Printer className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}
