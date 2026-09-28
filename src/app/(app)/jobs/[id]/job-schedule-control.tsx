"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { applyRangeEdit } from "@/lib/schedule-math";
import { dayWords, type JobBlock } from "@/lib/schedule/job-block";
import { BlockTimeControls, type BlockPatch } from "@/components/block-time-controls";
import { setJobScheduleRanges, setJobTimes, type DateRange } from "../../schedule/actions";

export interface ScheduleSegment {
  start_date: string; // yyyy-mm-dd
  end_date: string;
}

/**
 * THE JOB'S SCHEDULE: its days (one or more date ranges, e.g. Mon–Thu this week + Tue–Fri next week)
 * and its block, the start AND the length (Erik, 2026-09-28: "within the job itself i could only set a
 * start time and no end time"). The block is the same control the schedule tile's sheet shows
 * (components/block-time-controls): a Start, quick lengths 1h 2h 4h Full Day, and an End.
 *
 *   A day edit saves the whole set of ranges (a raw edit: removing a range here is choosing to) and
 *   keeps the job's start and length; a job getting its first day lands as two hours from the
 *   company's opening and says so ("2 hours — change it").
 *   A time edit goes through setJobTimes: the days are read fresh on the server and written back
 *   unchanged, so a worked day kept as history stays, and the start, the end and a chosen length land
 *   together.
 * Every save says where it stands; a refusal is said in words.
 */
export function JobScheduleControl({
  id,
  segments,
  block,
  workDay,
}: {
  id: string;
  segments?: ScheduleSegment[];
  /** The job's block on the company's clock (lib/schedule/job-block readJobBlock, on the server). */
  block: JobBlock;
  /** The company's work day ("HH:MM"): what Full Day means, and where a day with no time starts. */
  workDay: { start: string; end: string };
}) {
  const router = useRouter();

  const initial: DateRange[] =
    segments && segments.length
      ? segments.map((s) => ({ start: s.start_date, end: s.end_date }))
      : block.day
        ? [{ start: block.day, end: block.lastDay ?? block.day }]
        : [{ start: "", end: "" }];

  const [ranges, setRanges] = useState<DateRange[]>(initial);
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function persist(next: DateRange[]) {
    setError(null);
    // update() already keeps each range non-inverted (applyRangeEdit drags the
    // other bound along), so this righting only catches legacy inverted rows —
    // the same one-day clamp the server applies. Never block the save over it:
    // erroring here was the "Date range can't finish before start" bug.
    const filled = next
      .filter((r) => r.start)
      .map((r) => (r.end && r.end < r.start ? { start: r.start, end: r.start } : r));
    startT(async () => {
      try {
        // The start and the length are the block's: a day edit keeps them (undefined, undefined).
        const res = await setJobScheduleRanges(id, filled);
        if (!res.ok) {
          setError(res.error ?? "The days didn't save. Try again.");
          return;
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        router.refresh();
      } catch {
        setError("The days didn't save. You may be offline.");
      }
    });
  }

  function update(i: number, patch: Partial<DateRange>) {
    // The edited bound wins; the other follows when crossed (start pushed past
    // end drags end up, end pulled before start drags start back) — moving a
    // range is two taps in either order, never an error. Same-day stays valid.
    const next = ranges.map((r, idx) => (idx === i ? applyRangeEdit(r, patch) : r));
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

  async function saveTimes(patch: BlockPatch) {
    const res = await setJobTimes(id, "start" in patch ? { start: patch.start } : { length: patch.length });
    if (res.ok) router.refresh();
    return res;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {ranges.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={r.start}
              onChange={(ev) => update(i, { start: ev.target.value })}
              disabled={pending}
              className="h-11 w-[150px]"
              aria-label={`Start date ${i + 1}`}
            />
            <span className="text-xs text-slate-400">to</span>
            <Input
              type="date"
              value={r.end}
              onChange={(ev) => update(i, { end: ev.target.value })}
              disabled={pending}
              className="h-11 w-[150px]"
              aria-label={`End date ${i + 1}`}
            />
            {ranges.length > 1 && (
              <button
                type="button"
                onClick={() => removeRange(i)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
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
            className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Add Date Range
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

      {/* THE BLOCK: the start and the length, once the job has a day. */}
      {block.day ? (
        <BlockTimeControls
          startHm={block.startHm}
          endHm={block.endHm}
          allDay={block.allDay}
          sized={block.sized}
          multiDay={block.multiDay}
          lastDayWords={dayWords(block.lastDay)}
          workDay={workDay}
          save={saveTimes}
          idPrefix={`job-${id}`}
        />
      ) : (
        <p className="text-xs text-slate-500">Pick a day and it lands as 2 hours from the start of the work day. Change it here after.</p>
      )}
    </div>
  );
}
