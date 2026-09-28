"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import {
  blockWords,
  endAfter,
  hmWords,
  keptEndMin,
  QUICK_LENGTHS,
  readHm,
  workDayMinutes,
  type JobLength,
} from "@/lib/schedule/job-block";
import { minutesToHm } from "@/lib/schedule/fit-day";

/** What a change asks for: a new start (the length stays), or a length (1h/2h/4h, "full" for the
 *  company's whole day, or the minutes an End time gives). */
export type BlockPatch = { start: string } | { length: JobLength };

/**
 * THE START AND THE LENGTH, ONE CONTROL, EVERY PLACE A BLOCK IS SET (Erik, 2026-09-28: "within the job
 * itself i could only set a start time and no end time and on the schedule itself there should be a
 * time adjustment"). The job page's Scheduled box, the schedule tile's sheet for a job, and the same
 * sheet for a visit render THIS, so a chip or a rule added here exists everywhere at once.
 *
 *   Start   a time box; the length stays when it moves (10–12 moved to 1 PM is 1–3).
 *   1h 2h 4h Full Day   quick lengths; Full Day is the company's whole work day.
 *   End     a time box; the length is whatever the two boxes say.
 *   The words under it read the block back: "10:00 AM – 12:00 PM · 2 hours — change it" when nobody
 *   chose the length (the two-hour default), "· 2 hours" when somebody did.
 *
 * A time box saves when it's left (iOS time wheels fire on every spin), a chip on the tap. Every save
 * says where it stands: Saving…, Saved, or the refusal in words with the boxes put back. 44px targets.
 * `canEdit` false reads the block out in words with nothing to tap (the crew, never a dead control).
 */
export function BlockTimeControls({
  startHm,
  endHm,
  allDay,
  sized,
  multiDay = false,
  lastDayWords,
  workDay,
  canEdit = true,
  save,
  idPrefix = "block",
  plannedMinutes,
  onPending,
  onRefusal,
  draft = false,
}: {
  startHm: string;
  endHm: string;
  allDay: boolean;
  sized: boolean;
  /** A block over several days: its days are full days, so only the first day's start is asked. */
  multiDay?: boolean;
  /** "Wed, Sep 30": the last day of a multi-day block, for the words. */
  lastDayWords?: string | null;
  /** The company's work day ("HH:MM"): what Full Day means. */
  workDay: { start: string; end: string };
  canEdit?: boolean;
  save: (patch: BlockPatch) => Promise<{ ok: boolean; error?: string }>;
  idPrefix?: string;
  /** The job's size (planned_minutes), for the end a new start predicts. Absent (a visit): a block
   *  with an end is its own length. */
  plannedMinutes?: number | null;
  /** A save is out (true) or settled (false), said the moment it starts, so a sheet can hold itself
   *  open while one is (Modal holdOpen) and its answer has somewhere to land. */
  onPending?: (busy: boolean) => void;
  /** Every refusal in words (null when a new try starts): a sheet closed before the words were read
   *  says them in a toast. */
  onRefusal?: (words: string | null) => void;
  /** A form's draft (Add To Schedule): `save` only sets the form's hours and the form's own button
   *  writes, so nothing here says Saving… or Saved. */
  draft?: boolean;
}) {
  const [pending, start] = useTransition();
  const [start_, setStart] = useState(startHm);
  const [end, setEnd] = useState(endHm);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // SERVER TRUTH COMES BACK IN: after a save the page refreshes with the stored block, and the boxes
  // take it (no write of ours in flight). React's "adjust state while rendering" idiom.
  const serverKey = `${startHm}|${endHm}|${allDay}|${sized}`;
  const [seenKey, setSeenKey] = useState(serverKey);
  if (serverKey !== seenKey && !pending) {
    setSeenKey(serverKey);
    setStart(startHm);
    setEnd(endHm);
  }

  const s = readHm(start_) ?? 0;
  const e = readHm(end) ?? 0;
  const minutes = Math.max(1, e - s);
  const words = blockWords({ allDay, minutes, sized, multiDay });

  if (!canEdit) {
    return (
      <p className="text-sm text-slate-700">
        {multiDay
          ? `Starts ${hmWords(startHm)} · full days${lastDayWords ? ` through ${lastDayWords}` : ""}`
          : allDay
            ? `All day, ${hmWords(startHm)} – ${hmWords(endHm)}`
            : `${hmWords(startHm)} – ${hmWords(endHm)} · ${blockWords({ allDay, minutes: Math.max(1, (readHm(endHm) ?? 0) - (readHm(startHm) ?? 0)), sized, multiDay })}`}
      </p>
    );
  }

  function refuse(words: string | null) {
    setError(words);
    onRefusal?.(words);
  }

  function run(patch: BlockPatch, optimistic: { start?: string; end?: string }) {
    const prev = { start: start_, end };
    refuse(null);
    setSaved(false);
    if (optimistic.start !== undefined) setStart(optimistic.start);
    if (optimistic.end !== undefined) setEnd(optimistic.end);
    // Said NOW, in the same event as the tap or the blur, so a sheet already holds itself open when
    // the rest of that tap lands on its backdrop.
    onPending?.(true);
    start(async () => {
      try {
        const res = await save(patch);
        if (!res.ok) {
          setStart(prev.start);
          setEnd(prev.end);
          refuse(res.error ?? "That time didn't save. Try again.");
          return;
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch {
        setStart(prev.start);
        setEnd(prev.end);
        refuse("That time didn't save. You may be offline.");
      } finally {
        onPending?.(false);
      }
    });
  }

  function commitStart(v: string) {
    const hm = v.slice(0, 5);
    if (readHm(hm) == null || hm === startHm) return;
    // The End box moves by the writer's own keep rule (lib/schedule/job-block keptEndMin): a timed
    // block keeps its minutes, a Full Day keeps closing, and a length nobody chose (all day, or the old
    // closing-time stamp) becomes the two-hour default from the new start.
    const saidMinutes = Math.max(1, (readHm(endHm) ?? 0) - (readHm(startHm) ?? 0));
    const newStart = readHm(hm) ?? 0;
    const kept = keptEndMin({
      startMin: newStart,
      typedStart: true,
      before: { multiDay, allDay, endHm, minutes: saidMinutes },
      plannedMinutes: plannedMinutes ?? (sized ? saidMinutes : 0),
      wd: workDayMinutes(workDay),
    }).endMin;
    const nextEnd = multiDay ? end : minutesToHm(Math.max(newStart + 1, Math.min(23 * 60 + 59, kept)));
    run({ start: hm }, { start: hm, end: nextEnd });
  }

  function commitEnd(v: string) {
    const hm = v.slice(0, 5);
    const em = readHm(hm);
    if (em == null || hm === endHm) return;
    if (em <= s) {
      refuse("The end has to be after the start.");
      setEnd(endHm);
      return;
    }
    run({ length: em - s }, { end: hm });
  }

  const chip = (on: boolean) =>
    `inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-full border px-3 text-sm font-medium disabled:opacity-60 ${
      on ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-700 hover:border-brand hover:text-brand"
    }`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-slate-500" htmlFor={`${idPrefix}-start`}>
          Start
          <input
            id={`${idPrefix}-start`}
            type="time"
            value={start_}
            disabled={pending}
            onChange={(ev) => setStart(ev.target.value)}
            onBlur={(ev) => commitStart(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
            }}
            className="mt-0.5 h-11 w-[8.5rem] rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 disabled:opacity-60"
            aria-label="Start time"
          />
        </label>
        {!multiDay && (
          <label className="flex flex-col text-xs text-slate-500" htmlFor={`${idPrefix}-end`}>
            End
            <input
              id={`${idPrefix}-end`}
              type="time"
              value={end}
              disabled={pending}
              onChange={(ev) => setEnd(ev.target.value)}
              onBlur={(ev) => commitEnd(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
              }}
              className="mt-0.5 h-11 w-[8.5rem] rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 disabled:opacity-60"
              aria-label="End time"
            />
          </label>
        )}
      </div>

      {!multiDay && (
        <div role="group" aria-label="How long" className="flex flex-wrap gap-2">
          {QUICK_LENGTHS.map((q) => {
            const on = !allDay && minutes === q.minutes;
            return (
              <button
                key={q.minutes}
                type="button"
                disabled={pending}
                aria-pressed={on}
                aria-label={q.words}
                onClick={() => run({ length: q.minutes }, { end: endAfter(start_, q.minutes) })}
                className={chip(on)}
              >
                {q.label}
              </button>
            );
          })}
          <button
            type="button"
            disabled={pending}
            aria-pressed={allDay}
            onClick={() => run({ length: "full" }, { start: workDay.start, end: workDay.end })}
            className={chip(allDay)}
          >
            Full Day
          </button>
        </div>
      )}

      <p className="text-xs text-slate-500">
        {multiDay
          ? `Starts ${hmWords(start_)} · full days${lastDayWords ? ` through ${lastDayWords}` : ""}. Change the days above.`
          : `${hmWords(start_)} – ${hmWords(end)} · ${words}`}
        {pending && !draft && <span className="ml-2 text-slate-400">Saving…</span>}
        {saved && !pending && !draft && (
          <span className="ml-2 inline-flex items-center gap-1 font-medium text-green-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
