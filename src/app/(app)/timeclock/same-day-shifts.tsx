"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { putShiftOnJob, shiftsOnDay, takeShiftOffJob, type DayShift, type DayShifts } from "./actions";

/**
 * WHAT THIS PERSON ALREADY HAS THAT DAY, above every form that adds hours (the duplicate punches,
 * 2026-09-26).
 *
 * On 9/19 the office billing 85 Whitney added Brian's 9/11 by hand. Brian's own clock punch for
 * that day was already in the book, 10:31 AM to 6:57 PM, on no job, and nothing on the form said
 * so. Payroll paid both. So the forms that add hours (Add Entry on Timecards, the job's Add Time
 * Entry, Log Hours) show the person's shifts on the day picked, and a shift on no job gets one tap
 * that puts it on the job with its real clock times: Put This On <job>. Nothing is decided for
 * anyone: the tap is the office's, the form still saves if they meant a second shift, and the
 * database refuses one that overlaps (0360) in words that name the shift.
 */

const at = (iso: string, tz: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
const dayWord = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** The words for one shift's line, pure (shared with the tests). */
export function shiftLine(s: DayShift, tz: string): { when: string; where: string } {
  const when = s.clockOut ? `${at(s.clockIn, tz)} to ${at(s.clockOut, tz)} · ${s.hours.toFixed(2)} h` : `since ${at(s.clockIn, tz)}, still on the clock`;
  const where = s.jobLabel ? s.jobLabel : s.jobCode ? s.jobCode : "No job";
  return { when, where: s.billedBy ? `${where} · on ${s.billedBy}` : where };
}

/**
 * WHAT PUT THIS ON LEAVES BEHIND. The door moves the punch onto the job and nothing else, so miles,
 * a lunch, a code, a rate or notes already typed on the form reach no shift when it closes. Miles
 * are paid on their own (payroll's second bucket) and a lunch changes the paid hours, so the form
 * says which ones, instead of closing over them. Null when nothing was typed.
 */
export function notCarriedWords(f: { miles?: number; lunch?: boolean; code?: string | null; rate?: number; notes?: string | null }): string | null {
  const parts: string[] = [];
  if ((f.miles ?? 0) > 0) parts.push(`${f.miles} miles`);
  if (f.lunch) parts.push("the lunch");
  if ((f.code ?? "").trim()) parts.push(`code ${(f.code ?? "").trim()}`);
  if ((f.rate ?? 0) > 0) parts.push("the rate");
  if ((f.notes ?? "").trim()) parts.push("the notes");
  if (!parts.length) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Not added to that shift: ${list} typed on the form. Open it to add ${parts.length === 1 ? "that" : "them"}.`;
}

/** The list, given what shiftsOnDay answered. Presentational: the doors are the caller's. */
export function SameDayShiftsList({
  data,
  date,
  highlightId,
  busyId,
  onPut,
}: {
  data: Extract<DayShifts, { ok: true }>;
  date: string;
  highlightId?: string | null;
  busyId?: string | null;
  onPut?: (s: DayShift) => void;
}) {
  if (!data.shifts.length) return null;
  const first = data.name.split(/\s+/)[0] || data.name;
  const anyNoJob = data.shifts.some((s) => s.noJob && !s.billedBy);
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm" data-testid="same-day-shifts">
      <p className="flex items-center gap-1.5 font-medium text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        {first} already has {data.shifts.length === 1 ? "a shift" : `${data.shifts.length} shifts`} on {dayWord(date)}
      </p>
      <ul className="mt-1 divide-y divide-amber-200/70">
        {data.shifts.map((s) => {
          const line = shiftLine(s, data.tz);
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
                  On Service call — Nora & Fermin Arnoso" is ~300px), and at 375px the box inside
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
                  {busyId === s.id ? "Putting…" : `Put This On ${data.forJob!.label}`}
                </Button>
              ) : (
                <Link
                  href={`/timecards?entry=${s.id}`}
                  className="inline-flex min-h-[44px] items-center px-1 text-sm font-medium text-brand hover:underline"
                >
                  Open That Shift
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs text-amber-800">
        {anyNoJob && data.forJob
          ? `A shift on no job is usually this same work. Put it on ${data.forJob.label} instead of adding the hours again.`
          : anyNoJob
            ? // Only Add Entry has no job yet, and its Job field sits below this list.
              "A shift on no job is usually this same work. Pick the job below to put it there instead of adding the hours again."
            : "Hours that overlap these would be counted twice."}
      </p>
    </div>
  );
}

/**
 * The live list: reads shiftsOnDay whenever the person, the day or the job changes (a short pause
 * first, so typing a date does not fire a read per keystroke). `refreshKey` re-reads after a
 * refusal; `onPlaced` hears a Put This On that landed, with its sentence and the shift it moved (the
 * form closes on it, and says what it typed that the shift did not get: notCarriedWords).
 */
export function SameDayShifts({
  profileId,
  date,
  jobId,
  highlightId,
  refreshKey = 0,
  onPlaced,
}: {
  profileId: string;
  date: string;
  jobId: string | null;
  highlightId?: string | null;
  refreshKey?: number;
  onPlaced?: (sentence: string, shift: DayShift) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [data, setData] = useState<DayShifts | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setData(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      shiftsOnDay({ profile_id: profileId || null, date, for_job_id: jobId })
        .then((r) => {
          if (mine === seq.current) setData(r);
        })
        .catch(() => {
          if (mine === seq.current) setData({ ok: false, error: "Couldn't check this person's day just now." });
        });
    }, 250);
    return () => clearTimeout(t);
  }, [profileId, date, jobId, refreshKey]);

  if (!data) return null;
  if (!data.ok) {
    // NOTHING SILENT: a day that could not be read is not a clear day.
    return <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{data.error} Check Timecards before adding hours twice.</p>;
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
        toast("No connection, so that shift may not have moved. Try again when you have a bar or two.", "error");
        return;
      }
      if (!r.ok) {
        toast(r.error ?? "That shift didn't move.", "error");
        seq.current++;
        try {
          setData(await shiftsOnDay({ profile_id: profileId || null, date, for_job_id: jobId }));
        } catch {
          setData({ ok: false, error: "Couldn't check this person's day just now." });
        }
        return;
      }
      toast(r.sentence ?? "Put on the job.", "success", {
        label: "Undo",
        onClick: () => {
          void takeShiftOffJob({ entry_id: s.id, job_id: jobId }).then(
            (u) => {
              toast(u.ok ? "Back to no job." : (u.error ?? "Couldn't undo."), u.ok ? "success" : "error");
              router.refresh();
            },
            () => toast("No connection, so the Undo didn't go through. The shift may still be on the job: check it on Timecards when you have a bar or two.", "error"),
          );
        },
      });
      onPlaced?.(r.sentence ?? "", s);
    } finally {
      setBusyId(null);
    }
  };

  return <SameDayShiftsList data={data} date={date} highlightId={highlightId} busyId={busyId} onPut={put} />;
}
