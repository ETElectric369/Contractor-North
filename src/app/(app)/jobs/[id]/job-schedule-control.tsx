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

/** ISO → "HH:MM" in local time for a time input. The 8 AM all-day default reads
 *  as blank (no explicit time) — the same convention the calendar uses to decide
 *  whether to show a time at all. */
function toLocalTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return hm === "08:00" ? "" : hm;
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
  // Optional time-of-day for the job's PRIMARY start (the first range). Blank =
  // all-day; a time refines only jobs.scheduled_start, not per-segment.
  const [startTime, setStartTime] = useState<string>(toLocalTime(start));
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function persist(next: DateRange[], time = startTime) {
    setError(null);
    const filled = next.filter((r) => r.start);
    if (filled.some((r) => r.end && r.end < r.start)) {
      setError("A range ends before it starts.");
      return;
    }
    startT(async () => {
      // Only send a time when there's a primary start to attach it to.
      const res = await setJobScheduleRanges(id, filled, filled.length ? time || null : null);
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

  function updateTime(time: string) {
    setStartTime(time);
    persist(ranges, time);
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
          {i === 0 && (
            // Optional start time on the PRIMARY range only — refines
            // scheduled_start's time-of-day; blank keeps the job all-day.
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">at</span>
              <Input
                type="time"
                value={startTime}
                onChange={(ev) => updateTime(ev.target.value)}
                disabled={pending}
                className="h-9 w-[120px]"
                aria-label="Start time (optional)"
                title="Optional start time — leave blank for all-day"
              />
            </div>
          )}
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
