"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { setJobScheduleRanges, type DateRange } from "../../schedule/actions";

/** ISO → yyyy-mm-dd in local time for a date input. */
function toLocalDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface ScheduleSegment {
  start_date: string; // yyyy-mm-dd
  end_date: string;
}

/** Date-only schedule editor: one or more date ranges per job (e.g. Mon–Thu
 *  this week + Tue–Fri next week). Saves as soon as a range is complete. */
export function JobScheduleControl({
  id,
  start,
  end,
  segments,
}: {
  id: string;
  start: string | null;
  end: string | null;
  segments?: ScheduleSegment[];
}) {
  const router = useRouter();

  const initial: DateRange[] =
    segments && segments.length
      ? segments.map((s) => ({ start: s.start_date, end: s.end_date }))
      : start
        ? [{ start: toLocalDate(start), end: toLocalDate(end) }]
        : [{ start: "", end: "" }];

  const [ranges, setRanges] = useState<DateRange[]>(initial);
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function persist(next: DateRange[]) {
    setError(null);
    const filled = next.filter((r) => r.start);
    if (filled.some((r) => r.end && r.end < r.start)) {
      setError("A range ends before it starts.");
      return;
    }
    startT(async () => {
      const res = await setJobScheduleRanges(id, filled);
      if (!res.ok) {
        setError(res.error ?? "Could not save.");
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    });
  }

  function update(i: number, patch: Partial<DateRange>) {
    const next = ranges.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setRanges(next);
    persist(next);
  }

  function addRange() {
    setRanges((r) => [...r, { start: "", end: "" }]);
  }

  function removeRange(i: number) {
    const next = ranges.filter((_, idx) => idx !== i);
    const ensured = next.length ? next : [{ start: "", end: "" }];
    setRanges(ensured);
    persist(ensured);
  }

  return (
    <div className="space-y-2">
      {ranges.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            value={r.start}
            onChange={(ev) => update(i, { start: ev.target.value })}
            disabled={pending}
            className="h-9 w-[150px]"
            aria-label={`Start date ${i + 1}`}
          />
          <span className="text-xs text-slate-400">to</span>
          <Input
            type="date"
            value={r.end}
            onChange={(ev) => update(i, { end: ev.target.value })}
            disabled={pending}
            className="h-9 w-[150px]"
            aria-label={`End date ${i + 1}`}
          />
          {ranges.length > 1 && (
            <button
              type="button"
              onClick={() => removeRange(i)}
              className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              aria-label="Remove date range"
              title="Remove this range"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addRange}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> Add date range
        </button>
        {pending && <span className="text-xs text-slate-400">Saving…</span>}
        {saved && !pending && (
          <span className="flex items-center gap-1 text-xs font-medium text-green-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
