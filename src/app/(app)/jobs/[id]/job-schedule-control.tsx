"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Check, Plus, X } from "lucide-react";
import { companyToday, DayField } from "@/components/day-field";
import {
  editRow,
  extendDefaults,
  extendRefusal,
  hoursShown,
  joinedRange,
  oneDay,
  rangesToSave,
  rangeWords,
  reseedRows,
  rowHoursAfter,
  rowState,
  rowsToSend,
  type RangeRow,
} from "@/lib/schedule/range-rows";
import { dayWords, readHm, workDayMinutes, type JobBlock } from "@/lib/schedule/job-block";
import type { DayHours } from "@/lib/schedule-math";
import { BlockTimeControls, type BlockPatch } from "@/components/block-time-controls";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { setJobScheduleRanges, setJobTimes } from "../../schedule/actions";

export interface ScheduleSegment {
  start_date: string; // yyyy-mm-dd
  end_date: string;
  /** The range's own hours ("HH:MM" each), null for the job's usual hours (cn-v1190). */
  hours?: DayHours | null;
}

/** The statuses Extend Job is drawn for: a job still in flight and not on hold (job-status). */
const EXTENDABLE = ["to_be_scheduled", "scheduled", "in_progress"];

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
 *
 * EACH RANGE HAS HOURS OF ITS OWN (cn-v1190; the owner: "add a date range to have its own time entry too
 * that defaults to the hours inputed for the first date range so i can change them if i want to"). Every
 * row draws the same time control as the job's usual hours below, opening on the row's own hours or the
 * usual ones; a change gives that range its own hours for all its days, and the usual hours again store
 * none (lib/schedule/range-rows rowHoursAfter). A waiting row keeps its hours until it saves. EXTEND JOB
 * ("lets call it Extend Job with date and time selector defaulted to today with the same hours", "yes
 * today forward") adds one day, today or later, with the hours of the last range, through the same save.
 */
export function JobScheduleControl({
  id,
  segments,
  block,
  workDay,
  plannedMinutes,
  ownDays = [],
  status,
  today,
  daysUnread = false,
}: {
  id: string;
  /** The page's read of the job's days failed: one sentence in place of the rows, and nothing is saved
   *  (a failed read is never "nothing there"; rows seeded from the block would overwrite the real days). */
  daysUnread?: boolean;
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
  /** The job's status: Extend Job is drawn only for a job in flight and not on hold. */
  status?: string | null;
  /** The company's today (yyyy-mm-dd): Extend Job's first day, and no day before it. */
  today?: string;
}) {
  const router = useRouter();
  const lang = useLang();
  const t = translator(lang);

  const initial: RangeRow[] =
    segments && segments.length
      ? segments.map((s) => ({ start: s.start_date, end: s.end_date, hours: s.hours ?? null }))
      : block.day
        ? [{ start: block.day, end: block.lastDay ?? block.day, hours: null }]
        : [{ start: "", end: "", hours: null }];
  const todayYmd = today ?? companyToday(null);
  const wd = workDayMinutes(workDay);
  const usual = { startHm: block.startHm, endHm: block.endHm, allDay: block.allDay };

  const [ranges, setRanges] = useState<RangeRow[]>(initial);
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** "Days next to each other are one range: …", from the latest save's answer. */
  const [joined, setJoined] = useState<string | null>(null);
  /** Which save is the latest: an older answer never shows an error, the saved state or its rows. */
  const lastSave = useRef(0);
  /** Extend Job's door (open: its day and hours, null hours = the usual), and its refusal. */
  const [extend, setExtend] = useState<{ day: string; hours: DayHours | null } | null>(null);
  const [extendErr, setExtendErr] = useState<string | null>(null);
  const extendBusy = useRef(false);

  /** ONE SAVE OF THE ROWS, for a day edit, a row's hours and Extend Job alike. `quiet`: the refusal is
   *  said by the caller (a row's time entry, Extend Job's door), not under the rows too. */
  async function save(next: RangeRow[], quiet = false): Promise<{ ok: boolean; error?: string }> {
    setError(null);
    setJoined(null);
    // Only the ready rows go (both days set); a waiting row is never sent. Hours ride ONLY on a row the
    // person touched (skeptic #91 S1): every other row goes without them, so its days keep what is stored.
    const filled = rowsToSend(next);
    const mine = ++lastSave.current;
    try {
      // The start and the length are the block's: a day edit keeps them (undefined, undefined).
      const res = await setJobScheduleRanges(id, filled);
      // A later save sends every row too, this one's change with it: only the latest answer shows.
      if (mine !== lastSave.current) return { ok: true };
      if (!res.ok) {
        const words = res.error ?? t("jb_daysDidntSave");
        if (!quiet) setError(words);
        return { ok: false, error: words };
      }
      // What was stored replaces the saved rows (nothing touched any more); a row still waiting stays.
      if (res.ranges) {
        const stored = res.ranges;
        setRanges((now) => reseedRows(stored, now));
        const j = joinedRange(filled, stored);
        if (j) setJoined(fillText(t("jb_rangesJoined"), { range: rangeWords(j, (d) => dayWords(d, lang), t("jb_to")) }));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
      return { ok: true };
    } catch {
      const words = t("jb_daysDidntSaveOffline");
      if (mine === lastSave.current && !quiet) setError(words);
      return { ok: false, error: words };
    }
  }

  function persist(next: RangeRow[]) {
    startT(async () => {
      await save(next);
    });
  }

  /** A ROW'S TIME ENTRY: that range's hours, for all its days (the usual hours again store none). A
   *  waiting row keeps them, and they go with it when its days are both set. */
  async function saveRowHours(i: number, patch: BlockPatch): Promise<{ ok: boolean; error?: string }> {
    const row = ranges[i];
    if (!row) return { ok: false, error: t("jb_daysDidntSave") };
    const hours = rowHoursAfter({ row, usual, plannedMinutes, patch, wd });
    if (hours === undefined) return { ok: false, error: t("jb_rangeBadHours") };
    const next = ranges.map((r, idx) => (idx === i ? { ...r, hours, touched: true } : r));
    setRanges(next);
    if (rowState(next[i]) !== "ready") return { ok: true };
    const res = await save(next, true);
    // Refused: the row's hours go back to what they were (its time entry says why and puts its boxes back).
    if (!res.ok) setRanges((now) => now.map((r, idx) => (idx === i && r.start === row.start && r.end === row.end ? { ...r, hours: row.hours ?? null, touched: row.touched } : r)));
    return res;
  }

  /** Extend Job's time entry: its hours only (the door's own button saves). */
  async function saveExtendHours(patch: BlockPatch): Promise<{ ok: boolean; error?: string }> {
    if (!extend) return { ok: true };
    const hours = rowHoursAfter({ row: { start: "", end: "", hours: extend.hours }, usual, plannedMinutes, patch, wd });
    if (hours === undefined) return { ok: false, error: t("jb_rangeBadHours") };
    setExtend({ ...extend, hours });
    return { ok: true };
  }

  function openExtend() {
    setExtendErr(null);
    setExtend(extendDefaults(ranges, todayYmd));
  }

  /** EXTEND JOB: one day, today or later and not one the job has, with the door's hours, through the
   *  same save as every row. The door closes once it is stored, and the row shows. */
  function doExtend() {
    if (!extend || extendBusy.current) return;
    const why = extendRefusal(ranges, extend.day, todayYmd);
    if (why) {
      setExtendErr(why === "has" ? fillText(t("jb_extendHasDay"), { day: dayWords(extend.day, lang) }) : t("jb_extendPickDay"));
      return;
    }
    setExtendErr(null);
    const add: RangeRow = { start: extend.day, end: extend.day, hours: extend.hours, touched: true };
    // On screen at once, so a save made before this one answers sends the new day too.
    const next = [...ranges, add];
    setRanges(next);
    extendBusy.current = true;
    startT(async () => {
      const res = await save(next, true);
      extendBusy.current = false;
      if (!res.ok) {
        setRanges((now) => now.filter((r) => r !== add));
        setExtendErr(res.error ?? t("jb_daysDidntSave"));
        return;
      }
      setExtend(null);
    });
  }

  function update(i: number, patch: Partial<RangeRow>) {
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
    setRanges((r) => [...r, { start: "", end: "", hours: null, touched: true }]);
  }

  function removeRange(i: number) {
    const gone = ranges[i];
    const next = ranges.filter((_, idx) => idx !== i);
    const ensured = next.length ? next : [{ start: "", end: "", hours: null }];
    setRanges(ensured);
    // A waiting row was never saved: taking it off sends nothing.
    if (gone && rowState(gone) === "ready") persist(ensured);
  }

  /** Any row not ready (one day, or none): Add Date Range waits for it, one row at a time. */
  const anyWaiting = ranges.some((r) => rowState(r) !== "ready");
  /** Extend Job: a job with a stored day, in flight and not on hold. */
  const canExtend = EXTENDABLE.includes(String(status ?? "")) && rangesToSave(ranges).save.length > 0;

  async function saveTimes(patch: BlockPatch) {
    const res = await setJobTimes(id, "start" in patch ? { start: patch.start } : { length: patch.length });
    if (res.ok) router.refresh();
    return res;
  }

  return (
    <div className="space-y-3">
      {/* THE DAYS COULDN'T BE READ: one sentence in place of the rows, Add Date Range and Extend Job, so
          nothing here can save rows made up from the block over the job's real days. */}
      {daysUnread ? (
        <p className="text-xs text-red-600">{t("jb_daysUnread")}</p>
      ) : (
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
          {/* THE RANGE'S OWN TIME ENTRY (cn-v1190): the same control as the usual hours below, drawn when
              there are two rows or more (a waiting one counts) or this row keeps hours of its own. A lone
              row with none draws only its days: the usual hours below ARE its time (skeptic #91 S3). Never
              disabled while a save runs (`live`): the latest save wins, as for the date boxes. */}
          {block.day && (ranges.length > 1 || !!r.hours) && (() => {
            const shown = hoursShown(r, { start: block.startHm, end: block.endHm });
            const ownMin = Math.max(1, (readHm(shown.end) ?? 0) - (readHm(shown.start) ?? 0));
            return (
              <div className="space-y-1 pb-1">
                <p className="text-xs text-slate-500">{r.hours ? t("jb_rangeOwnHours") : t("jb_rangeUsualHours")}</p>
                <BlockTimeControls
                  startHm={shown.start}
                  endHm={shown.end}
                  allDay={r.hours ? readHm(shown.start) === wd.startMin && readHm(shown.end) === wd.endMin : block.allDay}
                  sized={r.hours ? true : block.sized}
                  multiDay={state === "ready" && r.start !== r.end}
                  lastDayWords={state === "ready" ? dayWords(r.end, lang) : null}
                  workDay={workDay}
                  save={(patch) => saveRowHours(i, patch)}
                  idPrefix={`job-${id}-range-${i}`}
                  plannedMinutes={r.hours ? ownMin : plannedMinutes}
                  draft={state !== "ready"}
                  live
                />
              </div>
            );
          })()}
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
          {canExtend && !extend && (
            <button
              type="button"
              onClick={openExtend}
              className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <CalendarPlus className="h-3.5 w-3.5" /> {t("jb_extendJob")}
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

        {/* EXTEND JOB, IN PLACE: one day (today forward) and its hours (the last range's), one button. */}
        {extend && (
          <ExtendJobPanel
            id={id}
            day={extend.day}
            hours={extend.hours}
            today={todayYmd}
            block={block}
            workDay={workDay}
            plannedMinutes={plannedMinutes}
            error={extendErr}
            onDay={(iso) => {
              setExtendErr(null);
              setExtend((x) => (x ? { ...x, day: iso } : x));
            }}
            saveHours={saveExtendHours}
            onSave={doExtend}
            onCancel={() => {
              setExtend(null);
              setExtendErr(null);
            }}
          />
        )}
      </div>
      )}

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

/** EXTEND JOB'S DOOR, drawn in place under the rows (never a Modal): ONE day box, no day before the
 *  company's today; ONE time entry, the same control as every row's; its button reads Extend Job. */
export function ExtendJobPanel({
  id,
  day,
  hours,
  today,
  block,
  workDay,
  plannedMinutes,
  error,
  onDay,
  saveHours,
  onSave,
  onCancel,
}: {
  id: string;
  day: string;
  /** Its own hours, or null: the job's usual hours. */
  hours: DayHours | null;
  today: string;
  block: JobBlock;
  workDay: { start: string; end: string };
  plannedMinutes?: number | null;
  error: string | null;
  onDay: (iso: string) => void;
  saveHours: (patch: BlockPatch) => Promise<{ ok: boolean; error?: string }>;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = translator(useLang());
  const wd = workDayMinutes(workDay);
  const shown = hoursShown({ start: "", end: "", hours }, { start: block.startHm, end: block.endHm });
  const ownMin = Math.max(1, (readHm(shown.end) ?? 0) - (readHm(shown.start) ?? 0));
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <p className="text-xs text-slate-500">{t("jb_extendNote")}</p>
      <DayField value={day} min={today} onChange={(iso) => onDay(iso)} className="w-[150px]" aria-label={t("jb_extendDay")} />
      <BlockTimeControls
        startHm={shown.start}
        endHm={shown.end}
        allDay={hours ? readHm(shown.start) === wd.startMin && readHm(shown.end) === wd.endMin : block.allDay}
        sized={hours ? true : block.sized}
        workDay={workDay}
        save={saveHours}
        idPrefix={`job-${id}-extend`}
        plannedMinutes={hours ? ownMin : plannedMinutes}
        draft
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          className="inline-flex min-h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-white hover:opacity-90"
        >
          {t("jb_extendJob")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {t("jb_cancel")}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
