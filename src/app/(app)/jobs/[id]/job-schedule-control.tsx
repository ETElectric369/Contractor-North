"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, X } from "lucide-react";
import { DayField } from "@/components/day-field";
import { editRow, joinedRange, oneDay, rangesToSave, rangeWords, reseedRows, rowState } from "@/lib/schedule/range-rows";
import { dayWords, type JobBlock } from "@/lib/schedule/job-block";
import { BlockTimeControls, type BlockPatch } from "@/components/block-time-controls";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
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
 *
 * A RANGE ROW WAITS (cn-v1189; the owner: "Add date range should wait and require a range before auto
 * saving right now it won't even let me add the second day"). A row is sent only once both its days are
 * set, or after One Day on a row with its first day only (lib/schedule/range-rows); a row with one day
 * says what it waits for, and Add Date Range is not drawn while any row waits. The boxes are never
 * disabled by a save: saves may overlap, and only the LATEST save's answer is shown, its stored ranges
 * becoming the saved rows (a waiting row kept), with one line when touching days were joined.
 */
export function JobScheduleControl({
  id,
  segments,
  block,
  workDay,
  plannedMinutes,
  ownDays = [],
}: {
  id: string;
  segments?: ScheduleSegment[];
  /** The days that keep their own hours (0370), in words ("Mon, Sep 28 12:00 PM – 5:00 PM"): the time
   *  control here sets the job's USUAL hours, every other day, and says so. */
  ownDays?: string[];
  /** The job's block on the company's clock (lib/schedule/job-block readJobBlock, on the server). */
  block: JobBlock;
  /** The company's work day ("HH:MM"): what Full Day means, and where a day with no time starts. */
  workDay: { start: string; end: string };
  /** The job's size (planned_minutes): the Start box predicts the end the writer will keep. */
  plannedMinutes?: number | null;
}) {
  const router = useRouter();
  const lang = useLang();
  const t = translator(lang);

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
  /** "Days next to each other are one range: …", from the latest save's answer. */
  const [joined, setJoined] = useState<string | null>(null);
  /** Which save is the latest: an older answer never shows an error, the saved state or its rows. */
  const lastSave = useRef(0);

  function persist(next: DateRange[]) {
    setError(null);
    setJoined(null);
    // Only the ready rows go (both days set); a waiting row stays on screen and is never sent.
    const filled = rangesToSave(next).save;
    const mine = ++lastSave.current;
    startT(async () => {
      try {
        // The start and the length are the block's: a day edit keeps them (undefined, undefined).
        const res = await setJobScheduleRanges(id, filled);
        if (mine !== lastSave.current) return;
        if (!res.ok) {
          setError(res.error ?? t("jb_daysDidntSave"));
          return;
        }
        // What was stored replaces the saved rows; a row still waiting stays.
        if (res.ranges) {
          const stored = res.ranges;
          setRanges((now) => reseedRows(stored, now));
          const j = joinedRange(filled, stored);
          if (j) setJoined(fillText(t("jb_rangesJoined"), { range: rangeWords(j, (d) => dayWords(d, lang), t("jb_to")) }));
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        router.refresh();
      } catch {
        if (mine === lastSave.current) setError(t("jb_daysDidntSaveOffline"));
      }
    });
  }

  function update(i: number, patch: Partial<DateRange>) {
    // The edited bound wins; the other follows when crossed (start pushed past
    // end drags end up, end pulled before start drags start back) — moving a
    // range is two taps in either order, never an error. Same-day stays valid.
    // An emptied box on a saved row is ignored (Remove takes a range off); a year
    // mid-typing (before 2000) waits and drags nothing (range-rows editRow).
    const edited = editRow(ranges[i], patch);
    if (edited === ranges[i]) return;
    const next = ranges.map((r, idx) => (idx === i ? edited : r));
    setRanges(next);
    // A row saves only once both its days are set: picking the first day of a new row saves nothing.
    if (rowState(next[i]) === "ready") persist(next);
  }

  /** One Day: a row with its first day only takes that day as its last, and saves. */
  function takeOneDay(i: number) {
    const next = ranges.map((r, idx) => (idx === i ? oneDay(r) : r));
    setRanges(next);
    persist(next);
  }

  function addRange() {
    setRanges((r) => [...r, { start: "", end: "" }]);
  }

  function removeRange(i: number) {
    const gone = ranges[i];
    const next = ranges.filter((_, idx) => idx !== i);
    const ensured = next.length ? next : [{ start: "", end: "" }];
    setRanges(ensured);
    // A waiting row was never saved: taking it off sends nothing.
    if (gone && rowState(gone) === "ready") persist(ensured);
  }

  /** Any row not ready (one day, or none): Add Date Range waits for it, one row at a time. */
  const anyWaiting = ranges.some((r) => rowState(r) !== "ready");

  async function saveTimes(patch: BlockPatch) {
    const res = await setJobTimes(id, "start" in patch ? { start: patch.start } : { length: patch.length });
    if (res.ok) router.refresh();
    return res;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {ranges.map((r, i) => {
          const state = rowState(r);
          return (
          <div key={i} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <DayField
              value={r.start}
              onChange={(iso) => update(i, { start: iso })}
              className="w-[150px]"
              aria-label={fillText(t("jb_startDateN"), { n: String(i + 1) })}
            />
            <span className="text-xs text-slate-400">{t("jb_to")}</span>
            <DayField
              value={r.end}
              onChange={(iso) => update(i, { end: iso })}
              className="w-[150px]"
              aria-label={fillText(t("jb_endDateN"), { n: String(i + 1) })}
            />
            {ranges.length > 1 && (
              <button
                type="button"
                onClick={() => removeRange(i)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                aria-label={t("jb_removeDateRange")}
                title={t("jb_removeThisRange")}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* A WAITING ROW SAYS WHAT IT WAITS FOR. A lone blank row (a job with no day) is said below. */}
          {state === "needsLast" && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-500">{t("jb_rangePickLast")}</p>
              <button
                type="button"
                onClick={() => takeOneDay(i)}
                className="inline-flex min-h-11 items-center rounded-md border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {t("jb_rangeOneDay")}
              </button>
            </div>
          )}
          {(state === "needsFirst" || (state === "blank" && ranges.length > 1)) && (
            <p className="text-xs text-slate-500">{t("jb_rangePickFirst")}</p>
          )}
          </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-3">
          {!anyWaiting && (
            <button
              type="button"
              onClick={addRange}
              className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <Plus className="h-3.5 w-3.5" /> {t("jb_addDateRange")}
            </button>
          )}
          {pending && <span className="text-xs text-slate-400">{t("jb_saving")}</span>}
          {saved && !pending && (
            <span className="flex items-center gap-1 text-xs font-medium text-green-600">
              <Check className="h-3.5 w-3.5" /> {t("jb_saved")}
            </span>
          )}
        </div>
        {joined && <p className="text-xs text-slate-500">{joined}</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>

      {/* EACH DAY KEEPS ITS OWN HOURS (0370): the time below is the job's usual hours, and a day with
          its own keeps them. Said, so a change here that leaves such a day where it was is no surprise. */}
      {ownDays.length > 0 && (
        <p className="text-xs text-slate-500">{fillText(t("jb_ownHoursNote"), { days: ownDays.join(" · ") })}</p>
      )}

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
          plannedMinutes={plannedMinutes}
        />
      ) : (
        <p className="text-xs text-slate-500">{t("jb_pickADayNote")}</p>
      )}
    </div>
  );
}
