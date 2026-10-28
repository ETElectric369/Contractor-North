"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { fillText, localeOf, translator } from "@/lib/i18n";
import { useLang } from "@/components/lang-provider";
import { putShiftOnJob, shiftsOnDay, takeShiftOffJob, type DayShift, type DayShifts } from "./actions";

/**
 * WHAT THIS PERSON ALREADY HAS THAT DAY, above every form that adds hours (the duplicate punches,
 * 2026-09-26).
 *
 * On 9/19 the office billing 41 Larkspur added Brian's 9/11 by hand. Brian's own clock punch for
 * that day was already in the book, 10:31 AM to 6:57 PM, on no job, and nothing on the form said
 * so. Payroll paid both. So the forms that add hours (Add Time Entry, on Timecards and on the job's
 * Time tab, and Log Hours) show the person's shifts on the day picked, and a shift on no job gets
 * one tap that puts it on the job with its real clock times: Put This On <job>. Nothing is decided
 * for anyone: the tap is the office's, the form still saves if they meant a second shift, and the
 * database refuses one that overlaps (0360) in words that name the shift.
 *
 * The same read says where the schedule put the person that day (Wave 2): Add Time Entry starts its
 * Job field there (onRead), and a day the office marked them off says so here.
 */

// The line a day marked off on the schedule gets (0170's OFF row) is t("tc_offThatDay").

// The clock and day words in the person's language (cn-v1138): "10:31 AM" / "10:31 a. m.",
// "Fri, Sep 11" / "vie, 11 sep". No lang is English, as every caller read before.
const at = (iso: string, tz: string, lang?: string | null) =>
  new Date(iso).toLocaleTimeString(localeOf(lang), { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
const dayWord = (ymd: string, lang?: string | null) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString(localeOf(lang), { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** The words for one shift's line, pure (shared with the tests), in the person's language. */
export function shiftLine(s: DayShift, tz: string, lang?: string | null): { when: string; where: string } {
  const t = translator(lang);
  const when = s.clockOut
    ? fillText(t("tc_shiftWhen"), { from: at(s.clockIn, tz, lang), to: at(s.clockOut, tz, lang), hours: s.hours.toFixed(2) })
    : fillText(t("tc_shiftSince"), { from: at(s.clockIn, tz, lang) });
  const where = s.jobLabel ? s.jobLabel : s.jobCode ? s.jobCode : t("tc_noJobWord");
  return { when, where: s.billedBy ? fillText(t("tc_onBilled"), { where, inv: s.billedBy }) : where };
}

/**
 * WHAT PUT THIS ON LEAVES BEHIND. The door moves the punch onto the job and nothing else, so miles,
 * a lunch, a code, a rate or notes already typed on the form reach no shift when it closes. Miles
 * are paid on their own (payroll's second bucket) and a lunch changes the paid hours, so the form
 * says which ones, instead of closing over them. Null when nothing was typed.
 */
export function notCarriedWords(
  f: { miles?: number; lunch?: boolean; code?: string | null; rate?: number; notes?: string | null },
  lang?: string | null,
): string | null {
  const t = translator(lang);
  const parts: string[] = [];
  if ((f.miles ?? 0) > 0) parts.push(fillText(t("tc_nMiles"), { n: String(f.miles) }));
  if (f.lunch) parts.push(t("tc_theLunch"));
  if ((f.code ?? "").trim()) parts.push(fillText(t("tc_codeX"), { code: (f.code ?? "").trim() }));
  if ((f.rate ?? 0) > 0) parts.push(t("tc_theRate"));
  if ((f.notes ?? "").trim()) parts.push(t("tc_theNotes"));
  if (!parts.length) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} ${t("tc_and")} ${parts[parts.length - 1]}`;
  return fillText(t("tc_notCarried"), { list, them: parts.length === 1 ? t("tc_that") : t("tc_them") });
}

/** The list, given what shiftsOnDay answered. Presentational: the doors are the caller's. */
export function SameDayShiftsList({
  data,
  date,
  highlightId,
  busyId,
  onPut,
  onOpenShift,
}: {
  data: Extract<DayShifts, { ok: true }>;
  date: string;
  highlightId?: string | null;
  busyId?: string | null;
  onPut?: (s: DayShift) => void;
  /** Open That Shift was tapped (the link still navigates): the form can close itself once the
   *  shift's editor is up, so two modals never answer one Back. */
  onOpenShift?: (s: DayShift) => void;
}) {
  const lang = useLang();
  const t = translator(lang);
  if (!data.shifts.length) {
    // Nothing on the day, but the office marked this person off: said, so a day off is never
    // mistaken for a day nobody planned (and the form never guesses a job for it).
    return data.offThatDay ? <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{t("tc_offThatDay")}</p> : null;
  }
  const first = data.name.split(/\s+/)[0] || data.name;
  const anyNoJob = data.shifts.some((s) => s.noJob && !s.billedBy);
  const day = dayWord(date, lang);
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm" data-testid="same-day-shifts">
      <p className="flex items-center gap-1.5 font-medium text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        {data.shifts.length === 1
          ? fillText(t("tc_alreadyHasOne"), { name: first, day })
          : fillText(t("tc_alreadyHasMany"), { name: first, n: String(data.shifts.length), day })}
      </p>
      <ul className="mt-1 divide-y divide-amber-200/70">
        {data.shifts.map((s) => {
          const line = shiftLine(s, data.tz, lang);
          const door = s.noJob && !s.billedBy && data.forJob;
          return (
            <li
              key={s.id}
              className={`flex min-h-[44px] flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ${highlightId === s.id ? "font-semibold" : ""}`}
            >
              <span className="min-w-0 flex-1 text-slate-800">
                <span className="tabular-nums">{line.when}</span>
                <span className={s.noJob ? "text-amber-800" : "text-slate-500"}> · {line.where}</span>
              </span>
              {/* THE DOOR WRAPS, it never spills: the label carries the job's whole name ("Put This
                  On Service call — Nora & Fermin Avocet" is ~300px), and at 375px the box inside
                  the modal has ~277px. 44px tall, like every door a thumb has to hit. */}
              {door ? (
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
                  onClick={() => onPut?.(s)}
                  disabled={!!busyId}
                >
                  {busyId === s.id ? t("tc_putting") : fillText(t("tc_putThisOn"), { job: data.forJob!.label })}
                </Button>
              ) : (
                <Link
                  href={`/timecards?entry=${s.id}`}
                  onClick={() => onOpenShift?.(s)}
                  className="inline-flex min-h-[44px] items-center px-1 text-sm font-medium text-brand hover:underline"
                >
                  {t("tc_openThatShift")}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs text-amber-800">
        {anyNoJob && data.forJob
          ? fillText(t("tc_noJobSameWorkPut"), { job: data.forJob.label })
          : anyNoJob
            ? // Only Add Time Entry on Timecards can have no job yet, and its Job field sits above this list.
              t("tc_noJobSameWorkPick")
            : t("tc_overlapTwice")}
      </p>
      {data.offThatDay && <p className="mt-1 text-xs text-amber-800">{t("tc_offThatDay")}</p>}
    </div>
  );
}

/**
 * The live list: reads shiftsOnDay whenever the person, the day or the job changes (a short pause
 * first, so typing a date does not fire a read per keystroke). `refreshKey` re-reads after a
 * refusal; `onPlaced` hears a Put This On that landed, with its sentence and the shift it moved (the
 * form closes on it, and says what it typed that the shift did not get: notCarriedWords). `onRead`
 * hears every answer for the person and day on screen (never a stale one): Add Time Entry starts its
 * Job field on where the schedule put them.
 */
export function SameDayShifts({
  profileId,
  date,
  jobId,
  highlightId,
  refreshKey = 0,
  onPlaced,
  onOpenShift,
  onRead,
}: {
  profileId: string;
  date: string;
  jobId: string | null;
  highlightId?: string | null;
  refreshKey?: number;
  onPlaced?: (sentence: string, shift: DayShift) => void;
  onOpenShift?: (shift: DayShift) => void;
  onRead?: (answer: DayShifts) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const t = translator(useLang());
  const [data, setData] = useState<DayShifts | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const seq = useRef(0);
  // The latest callback, so a new function each render never re-arms the read below; the translator
  // rides the same way, for the failed read's words.
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const tRef = useRef(t);
  tRef.current = t;
  const take = (r: DayShifts) => {
    setData(r);
    onReadRef.current?.(r);
  };

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setData(null);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      shiftsOnDay({ profile_id: profileId || null, date, for_job_id: jobId })
        .then((r) => {
          if (mine === seq.current) take(r);
        })
        .catch(() => {
          if (mine === seq.current) take({ ok: false, error: tRef.current("tc_couldNotCheckDay") });
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [profileId, date, jobId, refreshKey]);

  if (!data) return null;
  if (!data.ok) {
    // NOTHING SILENT: a day that could not be read is not a clear day.
    return (
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        {data.error} {t("tc_checkTimecardsFirst")}
      </p>
    );
  }

  // THE 60MPH LAW (job-time-button.tsx): a server action that rejects (no signal, a dropped
  // connection) throws. Every await below has its catch, so a dead zone is a sentence, never a
  // silent button or a page torn down to the error boundary.
  const put = async (s: DayShift) => {
    if (!jobId || busyId) return;
    setBusyId(s.id);
    try {
      let r: Awaited<ReturnType<typeof putShiftOnJob>>;
      try {
        r = await putShiftOnJob({ entry_id: s.id, job_id: jobId });
      } catch {
        toast(t("tc_offlineShiftMayNotMove"), "error");
        return;
      }
      if (!r.ok) {
        toast(r.error ?? t("tc_shiftDidntMove"), "error");
        seq.current++;
        try {
          setData(await shiftsOnDay({ profile_id: profileId || null, date, for_job_id: jobId }));
        } catch {
          setData({ ok: false, error: t("tc_couldNotCheckDay") });
        }
        return;
      }
      toast(r.sentence ?? t("tc_putOnTheJob"), "success", {
        label: t("tc_undo"),
        onClick: () => {
          void takeShiftOffJob({ entry_id: s.id, job_id: jobId }).then(
            (u) => {
              toast(u.ok ? t("tc_backToNoJob") : (u.error ?? t("tc_couldNotUndo")), u.ok ? "success" : "error");
              router.refresh();
            },
            () => toast(t("tc_offlineUndoFailed"), "error"),
          );
        },
      });
      onPlaced?.(r.sentence ?? "", s);
    } finally {
      setBusyId(null);
    }
  };

  return <SameDayShiftsList data={data} date={date} highlightId={highlightId} busyId={busyId} onPut={put} onOpenShift={onOpenShift} />;
}
