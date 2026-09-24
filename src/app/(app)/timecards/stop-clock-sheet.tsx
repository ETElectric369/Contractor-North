"use client";

/**
 * CLOCK OUT FOR THEM: the office's sheet for somebody's RUNNING shift.
 *
 * Erik, 2026-09-24: "Brian did it the other day too and I had no way to stop it to set the time for
 * the invoice". The editor refused an open row and every other door closed it at "now". This sheet
 * asks the one question that matters, when did the work really stop, and closes the clock at that
 * time through stopShift (which writes who stopped it on the card and tells the crew member).
 *
 * TWO SHEETS IN ONE, and the words say which (clockDoorWords). Erik, the same day: "an option to
 * [end] an employees time clock and clock out for them", at any time, not only a forgotten one.
 *
 *   An ordinary shift: "Clock Out Brian". The stop time is filled with now and follows the minute
 *     hand until somebody touches it, so it is two taps: the door, then the button.
 *   A forgotten one (LONG_SHIFT_HOURS, or begun on an earlier day): "Stop Brian's Clock". The stop
 *     fields start EMPTY, because the office never gets a silent default on a forgotten punch; "Now"
 *     and "End Of Work Day" are chips that fill the fields and never save.
 *
 * Every time here is the ORG's wall clock, whatever the laptop says.
 */
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { useToast } from "@/components/toast";
import { jobLabel } from "@/lib/schedule-options";
import { clockInputValue, splitClock } from "@/lib/split-preview";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";
import { hoursBetween } from "@/lib/utils";
import { MAX_SHIFT_HOURS, clockDoorWords, isForgottenShift, stopProblem } from "@/lib/long-shift";
import type { JobCode } from "@/lib/types";
import { stopShift, updateOpenEntry } from "../timeclock/actions";

const H = 3_600_000;

export interface StopClockEntry {
  id: string;
  profile_id?: string | null;
  clock_in: string;
  lunch_minutes: number;
  job_id?: string | null;
  job_code: string | null;
  notes: string | null;
  profiles?: { full_name: string | null } | null;
  job?: { job_number: string; name: string } | null;
}

function dayLabel(ms: number, tz: string): string {
  const d = new Date(ms);
  const wd = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const md = d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  return `${wd} ${md}`;
}

function agoLabel(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m`;
}

export function StopClockSheet({
  entry,
  jobs,
  jobCodes,
  jobCodesEnabled,
  tz,
  workDayEnd,
  open,
  onClose,
  onDelete,
  deleting,
  externalError,
  viewerId,
}: {
  entry: StopClockEntry;
  jobs: { id: string; job_number: string; name: string }[];
  jobCodes: JobCode[];
  jobCodesEnabled: boolean;
  tz: string;
  /** "HH:MM", the org's work-day end (Settings, Scheduling). Offered as a chip on the clock-in day. */
  workDayEnd?: string;
  open: boolean;
  onClose: () => void;
  onDelete: () => void;
  deleting: boolean;
  /** A failure from the parent's own action (Delete), shown in this sheet's error line: the parent's
   *  edit form, which used to show it, is never mounted for a running clock. */
  externalError?: string | null;
  /** The person looking. His own running clock reads "Clock Out", never his own name. */
  viewerId?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const clockInMs = Date.parse(entry.clock_in);
  // Frozen at mount: which sheet this is must not change under somebody typing.
  const [openedAt] = useState(() => Date.now());
  const forgotten = isForgottenShift(clockInMs, openedAt, tz);
  const words = clockDoorWords(entry.profiles?.full_name, { self: !!viewerId && entry.profile_id === viewerId });
  const verb = forgotten ? words.stop : words.clockOut;

  // The seeded start, kept to tell "the office moved the start" from "left alone". The inputs hold
  // whole minutes, so an unmoved start is sent as the STORED clock-in to the second: rebuilding it
  // from the fields moved every start back by up to 59 s with no crumb, and on the live piece of a
  // Switch Job (which begins at the second the last piece ended) that is an overlap payroll pays twice.
  const [seedStartDate] = useState(() => todayStrInTz(tz, new Date(clockInMs)));
  const [seedStartTime] = useState(() => clockInputValue(entry.clock_in, tz));
  const [startDate, setStartDate] = useState(seedStartDate);
  const [startTime, setStartTime] = useState(seedStartTime);
  const [stopDate, setStopDate] = useState(() => (forgotten ? "" : todayStrInTz(tz, new Date(openedAt))));
  const [stopTime, setStopTime] = useState(() => (forgotten ? "" : clockInputValue(new Date(openedAt).toISOString(), tz)));
  const [lunchMin, setLunchMin] = useState(entry.lunch_minutes ?? 0);
  const [jobId, setJobId] = useState(entry.job_id ?? "");
  const [jobCode, setJobCode] = useState(entry.job_code ?? "");
  const [notes, setNotes] = useState(entry.notes ?? "");

  // An ordinary clock-out's stop time is "now" until a person touches it: it follows the minute hand,
  // so a sheet left open while the phone rang still clocks him out at the moment of the tap's
  // minute, not at the moment the sheet opened. Any edit or chip ends that for good.
  const followNow = useRef(!forgotten);

  // The minute hand: the "ago" line and the Now chip read it, and it moves while the sheet is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (followNow.current) {
        setStopDate(todayStrInTz(tz, new Date(n)));
        setStopTime(clockInputValue(new Date(n).toISOString(), tz));
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [open, tz]);

  const name = entry.profiles?.full_name?.trim() || "This person";
  const first = name.split(/\s+/)[0] || name;
  const label = entry.job ? jobLabel(entry.job) : null;

  const startMoved = startDate !== seedStartDate || startTime !== seedStartTime;
  const startIso = startMoved ? (startDate && startTime ? tzDateTimeUtc(startDate, startTime, tz) : null) : entry.clock_in;
  const stopIso = stopDate && stopTime ? tzDateTimeUtc(stopDate, stopTime, tz) : null;
  const startMs = startIso ? Date.parse(startIso) : NaN;
  const stopMs = stopIso ? Date.parse(stopIso) : NaN;
  const problem =
    stopIso && startIso ? stopProblem({ startMs, stopMs, nowMs: now, lunchMin, who: "he", tz }) : null;
  const shownError = error ?? externalError ?? null;
  const valid = !!startIso && !!stopIso && !problem;

  // Chips fill the fields; they never save.
  const clockInDay = todayStrInTz(tz, new Date(clockInMs));
  const showNow = now - clockInMs <= MAX_SHIFT_HOURS * H && clockInDay === todayStrInTz(tz, new Date(now));
  const workEndIso = workDayEnd ? tzDateTimeUtc(clockInDay, workDayEnd, tz) : null;
  const workEndMs = workEndIso ? Date.parse(workEndIso) : NaN;
  const showWorkEnd = Number.isFinite(workEndMs) && workEndMs > clockInMs && workEndMs <= now;
  const fill = (ms: number) => {
    followNow.current = false;
    setStopDate(todayStrInTz(tz, new Date(ms)));
    setStopTime(clockInputValue(new Date(ms).toISOString(), tz));
    setError(null);
  };

  const sideChanged = useMemo(
    () =>
      (jobId || "") !== (entry.job_id ?? "") ||
      (jobCode || "") !== (entry.job_code ?? "") ||
      notes !== (entry.notes ?? ""),
    [jobId, jobCode, notes, entry.job_id, entry.job_code, entry.notes],
  );

  function stopIt() {
    setError(null);
    if (!valid || !stopIso || !startIso) return;
    start(async () => {
      let res: Awaited<ReturnType<typeof stopShift>>;
      try {
        res = await stopShift({
          entry_id: entry.id,
          ...(startMoved ? { clock_in: startIso } : {}),
          clock_out: stopIso,
          lunch_minutes: lunchMin,
          job_id: jobId || null,
          job_code: jobCode || null,
          notes,
        });
      } catch {
        return setError("No connection. The clock is still running; try again.");
      }
      if (!res.ok) return setError(res.error ?? "The clock didn't stop. Try again.");
      onClose();
      router.refresh();
      toast(res.sentence ?? "Stopped the clock.", "success");
      if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
    });
  }

  function saveWithoutStopping() {
    setError(null);
    start(async () => {
      const patch: { id: string; job_id?: string | null; job_code?: string | null; notes?: string } = { id: entry.id };
      if ((jobId || "") !== (entry.job_id ?? "")) patch.job_id = jobId || null;
      if ((jobCode || "") !== (entry.job_code ?? "")) patch.job_code = jobCode || null;
      if (notes !== (entry.notes ?? "")) patch.notes = notes;
      let res: { ok: boolean; error?: string };
      try {
        res = await updateOpenEntry(patch);
      } catch {
        return setError("No connection. The clock is still running; try again.");
      }
      if (!res.ok) return setError(res.error ?? "That didn't save.");
      onClose();
      router.refresh();
      toast(`Saved. ${first}'s clock is still running.`, "success");
    });
  }

  const busy = pending || deleting;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={verb}
      portal
      footer={
        // STACKED, like the split sheet: four nowrap buttons in one row clipped their own labels at
        // 375px ("op The Clo"). The error sits here, pinned with the button that caused it, so a
        // refusal never lands above the fold of a scrolled body (NOTHING SILENT).
        <div className="w-full space-y-2">
          {shownError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-700" role="alert" aria-live="assertive">
              {shownError}
            </div>
          )}
          <Button type="button" className="h-11 w-full" onClick={stopIt} disabled={busy || !valid}>
            {pending ? (forgotten ? "Stopping…" : "Clocking Out…") : verb}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={saveWithoutStopping} disabled={busy || !sideChanged}>
              Save Without Stopping
            </Button>
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
          <Button variant="ghost" onClick={onDelete} disabled={busy} className="h-11 w-full text-red-600 hover:bg-red-50">
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-700">
          Clocked in {dayLabel(clockInMs, tz)}, {splitClock(entry.clock_in, tz)}
          {label ? ` at ${label}` : " with no job"}, {agoLabel(now - clockInMs)} ago.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="s-start-date">Started</Label>
            <Input id="s-start-date" type="date" className="h-11" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="s-start-time" className="invisible">Start time</Label>
            <Input id="s-start-time" type="time" className="h-11" aria-label="Start time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="s-stop-date">Stopped</Label>
            <Input
              id="s-stop-date"
              type="date"
              className="h-11"
              value={stopDate}
              onChange={(e) => {
                followNow.current = false;
                setStopDate(e.target.value);
              }}
            />
          </div>
          <div>
            <Label htmlFor="s-stop-time" className="invisible">Stop time</Label>
            <Input
              id="s-stop-time"
              type="time"
              className="h-11"
              aria-label="Stop time"
              value={stopTime}
              onChange={(e) => {
                followNow.current = false;
                setStopTime(e.target.value);
              }}
            />
          </div>
        </div>

        {(showNow || showWorkEnd) && (
          <div className="flex flex-wrap gap-2">
            {showNow && (
              <Button type="button" variant="outline" className="h-11" onClick={() => fill(now)}>
                Now
              </Button>
            )}
            {showWorkEnd && (
              <Button type="button" variant="outline" className="h-11" onClick={() => fill(workEndMs)}>
                End Of Work Day ({splitClock(workEndMs, tz)})
              </Button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <span className="text-slate-700">Unpaid lunch</span>
          <span className="ml-auto flex items-center gap-1 text-slate-600">
            <span className="w-16">
              <NumberInput value={lunchMin} onValueChange={setLunchMin} step={15} aria-label="Lunch minutes" />
            </span>
            min
          </span>
        </div>

        <div aria-live="polite" className="text-sm">
          {!startIso ? (
            <p className="text-slate-500">Pick when {first} started.</p>
          ) : !stopIso ? (
            <p className="text-slate-500">Pick when {first} stopped.</p>
          ) : problem ? (
            <p className="font-medium text-red-700">{problem}</p>
          ) : (
            <p className="font-medium text-slate-800">
              {first} gets {hoursBetween(startIso as string, stopIso, lunchMin).toFixed(2)} h for {dayLabel(startMs, tz)}.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="s-job">Job</Label>
          <Select id="s-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">No job</option>
            {entry.job_id && !jobs.some((j) => j.id === entry.job_id) && (
              <option value={entry.job_id}>{entry.job ? jobLabel(entry.job) : "Current job"}</option>
            )}
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {jobLabel(j)}
              </option>
            ))}
          </Select>
        </div>
        {jobCodesEnabled && (
          <div>
            <Label htmlFor="s-code">Job code</Label>
            <Select id="s-code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
              <option value="">No code</option>
              {jobCodes.map((c) => (
                <option key={c.id} value={c.code}>
                  {c.code}: {c.description}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label htmlFor="s-notes">Notes</Label>
          <Textarea id="s-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
