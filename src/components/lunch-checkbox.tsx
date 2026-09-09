"use client";

import { LUNCH_LABEL } from "@/lib/lunch-rule";

/** The ONE unpaid-lunch control (Erik 2026-09-08). Off by default at every door — a shift
 *  is paid gross unless somebody ticks this. Rendered identically on the live clock-out,
 *  the office's "add past entry", the job's add-time modal and the auto-close catch-up, so
 *  the crew sees the same question wherever a shift gets closed. */
export function LunchCheckbox({
  id,
  checked,
  onChange,
  className = "",
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 ${className}`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand"
      />
      <span>{LUNCH_LABEL}</span>
    </label>
  );
}
