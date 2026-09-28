"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { Input, Label, Select } from "@/components/ui/input";
import { LunchCheckbox } from "@/components/lunch-checkbox";
import { lunchMinutesFor } from "@/lib/lunch-rule";
import { todayStrInTz } from "@/lib/tz";
import type { JobCode } from "@/lib/types";
import { createManualEntry, type DayShifts } from "../timeclock/actions";
import { NewJobInline, type CreatedJob } from "../timeclock/new-job-inline";
import { SameDayShifts, notCarriedWords } from "../timeclock/same-day-shifts";
import { buildShiftSpan } from "../timeclock/shift-span";
import { whichJobLabel, type ChoiceJob } from "../timeclock/which-job-choices";

/**
 * ADD TIME ENTRY: THE ONE FORM THE OFFICE ADDS HOURS WITH (Wave 2, W2-03).
 *
 * There were two, and neither was slim: Timecards' "Add Entry" asked eleven things (crew member,
 * two dates, two times, code, miles, rate with its bill-rate tripwire, lunch, an optional job that
 * started on "No job", notes), and the job's Time tab had its own copy with a browser-date default
 * and no way to record a night shift. Starting on "No job" is how a company's hours ended up on no
 * job at all. This is both of them, in six fields:
 *
 *   Who · Job · Day · Start · End · Lunch   (and Job Code, only while the Job Codes switch is on)
 *
 * Miles, a pay-rate override and notes live on the shift's editor, which the toast after a save
 * opens in one tap ("Open That Shift"); an end on another day is the "Ends The Next Day" box.
 *
 * THE JOB IS ALWAYS SOMETHING SOMEBODY CHOSE. On the job's own page it is that job ("Job · 85
 * Whitney"). On Timecards it starts where the schedule put the person that day (shiftsOnDay's
 * scheduledJob: the crew board's day row, else a rostered job whose days cover it), and on "Pick
 * The Job" when the schedule says nothing, so Save refuses until someone picks: a job, Company Time
 * (the company's own not-billed code), or, for a company with no such code, No Job, said to wait
 * under Hours On No Job. A preselect never overwrites a pick the person made.
 *
 * STAFF ONLY: a tech clocks live (the Timeclock), and createManualEntry is requireStaff anyway.
 */

/** The Job field's two answers that are not a job. */
export const COMPANY_TIME = "company";
export const NO_JOB = "none";

export type AddJob = ChoiceJob;
type Member = { id: string; full_name: string | null };

/** "7.5 h", "8 h", "8.25 h": the paid hours of a shift, as the toast says them. */
export function hoursWords(h: number): string {
  return `${Math.round(Math.max(0, h) * 100) / 100} h`;
}

/** "Tue, Sep 23" for a "YYYY-MM-DD", the same in every timezone (the Day field's own date). */
export function dayWords(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

/** The day after a "YYYY-MM-DD", on the calendar. */
export function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** End at or before Start: the form asks whether the shift ran past midnight. */
export function endsBeforeStart(startT: string, endT: string): boolean {
  if (!/^\d{2}:\d{2}/.test(startT) || !/^\d{2}:\d{2}/.test(endT)) return false;
  return endT.slice(0, 5) <= startT.slice(0, 5);
}

/** What the toast says after a save: "Added 7.5 h for Brian · Tue, Sep 23 · 85 Whitney". */
export function addedWords(f: { hours: number; who: string; day: string; where: string }): string {
  return `Added ${hoursWords(f.hours)} for ${f.who} · ${dayWords(f.day)} · ${f.where}`;
}

/**
 * The Job field's answer, as Save writes it: the job and code, and the words the toast names it by.
 * A placeholder ("Pick The Job") is a refusal in words that name both ways out.
 */
export function resolveJobChoice(f: {
  value: string;
  fixedJob?: { id: string; label: string } | null;
  companyTimeCode: string | null;
  /** The Job Code field's value, "" for none (only asked while the switch is on). */
  jobCode: string;
  jobCodesEnabled: boolean;
  labelOf: (id: string) => string;
}): { ok: true; job_id: string | null; job_code: string | null; where: string } | { ok: false; error: string } {
  const code = f.jobCodesEnabled ? f.jobCode.trim() || null : null;
  if (f.fixedJob) return { ok: true, job_id: f.fixedJob.id, job_code: code, where: f.fixedJob.label };
  if (f.value === COMPANY_TIME && f.companyTimeCode) {
    // Company Time is the company's own not-billed code on no job, as fileShiftAsCompanyTime files it.
    return { ok: true, job_id: null, job_code: f.companyTimeCode, where: "Company Time" };
  }
  if (f.value === NO_JOB && !f.companyTimeCode) return { ok: true, job_id: null, job_code: code, where: "No Job" };
  if (!f.value || f.value === COMPANY_TIME || f.value === NO_JOB) {
    return { ok: false, error: f.companyTimeCode ? "Pick the job, or Company Time." : "Pick the job, or No Job." };
  }
  return { ok: true, job_id: f.value, job_code: code, where: f.labelOf(f.value) };
}

/**
 * Where the Job field goes when the day's schedule answers: the scheduled job, or "Pick The Job"
 * (nothing scheduled, marked off, or a day that couldn't be read). `null` means leave it: the
 * person picked something, and a preselect never overwrites a pick.
 */
export function preselectFrom(answer: DayShifts | null, touched: boolean): string | null {
  if (touched) return null;
  if (!answer || !answer.ok || answer.offThatDay) return "";
  return answer.scheduledJob?.id ?? "";
}

export function AddTimeEntry({
  isStaff,
  members,
  jobs,
  jobCodes,
  jobCodesEnabled,
  tz,
  viewerId,
  fixedJob = null,
  companyTimeCode,
  initialOpen = false,
}: {
  /** Only the office adds hours: a tech gets nothing (they clock live). */
  isStaff: boolean;
  members: Member[];
  /** Timecards' Job list: the jobs in flight plus those finished in the last 30 days. Unused with
   *  a fixed job. */
  jobs: AddJob[];
  jobCodes: JobCode[];
  /** The Job Codes switch (features.job_codes). Off: no Job Code field; a switch only hides it. */
  jobCodesEnabled: boolean;
  /** The company's timezone: the Day starts on ITS today, not the browser's. */
  tz: string;
  /** The person looking: Who opens on them by name. */
  viewerId?: string | null;
  /** On the job's own page: the job, said, not picked. */
  fixedJob?: { id: string; label: string } | null;
  /** The company's own not-billed code (lib/no-job-hours companyTimeCode), or null for none. */
  companyTimeCode: string | null;
  /** Mount with the form already open. */
  initialOpen?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(initialOpen);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  /**
   * ONE PERSON, ONE NAME (Erik, 2026-09-18: "there is two of me in the system, one labeled Me and one
   * labelled Erik Taylor"). No "Me" sentinel: Who opens on the viewer BY NAME, one entry in one list.
   * "Myself" (value "", which the server reads as the caller) only when the viewer has no member row.
   */
  const viewerListed = !!viewerId && members.some((m) => m.id === viewerId);
  const [who, setWho] = useState(viewerListed ? String(viewerId) : "");
  const [day, setDay] = useState(() => todayStrInTz(tz));
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("16:00");
  const [nextDayTicked, setNextDayTicked] = useState(false);
  const [tookLunch, setTookLunch] = useState(false);
  const [jobCode, setJobCode] = useState("");

  /* THE JOB FIELD. `jobValue` is a job id, COMPANY_TIME, NO_JOB, or "" for "Pick The Job". A pick
     the person made (jobTouched) is never overwritten by what the schedule says. */
  const [jobValue, setJobValue] = useState("");
  const jobTouched = useRef(false);
  const [scheduled, setScheduled] = useState<{ id: string; label: string } | null>(null);
  // Jobs made from inside this form (New Job): the list is server-rendered and catches up later.
  const [newJobs, setNewJobs] = useState<AddJob[]>([]);
  const knownJobs = useMemo(() => {
    const seen = new Set(jobs.map((j) => j.id));
    return [...newJobs.filter((j) => !seen.has(j.id)), ...jobs];
  }, [jobs, newJobs]);
  const labelOf = (id: string): string => {
    const j = knownJobs.find((x) => x.id === id);
    if (j) return whichJobLabel(j, jobCodesEnabled);
    if (scheduled?.id === id) return scheduled.label;
    return "That job";
  };
  const scheduledOpt = scheduled ? { id: scheduled.id, label: labelOf(scheduled.id) } : null;
  const otherJobs = knownJobs.filter((j) => j.id !== scheduledOpt?.id);
  const jobIsReal = !fixedJob && !!jobValue && jobValue !== COMPANY_TIME && jobValue !== NO_JOB;
  // A picked job the list no longer holds (a new day's schedule moved it) stays on screen as what
  // it is, never silently shown as something else while it saves.
  const orphan = jobIsReal && jobValue !== scheduledOpt?.id && !otherJobs.some((j) => j.id === jobValue);

  function pickJob(v: string) {
    jobTouched.current = true;
    setError(null);
    setJobValue(v);
  }
  // A new person or a new day: the schedule is asked again, and an untouched Job field waits for it
  // on "Pick The Job" rather than holding the last day's job while the answer is on its way.
  function whoOrDayChanged() {
    if (!fixedJob && !jobTouched.current) setJobValue("");
  }
  function addNewJob(j: CreatedJob) {
    setNewJobs((p) => (p.some((x) => x.id === j.id) ? p : [...p, { id: j.id, name: j.name }]));
    pickJob(j.id);
    toast(`Created ${j.name}`, "success");
  }

  // THE SHIFT, from the Day, Start and End. An End at or before the Start asks one question, "Ends
  // The Next Day": ticked, the end is the next day (endDate = Day + 1); otherwise the end date IS the
  // Day, so a flipped time is "End must be after start." rather than a silent overnight shift.
  const crossing = endsBeforeStart(startT, endT);
  const endsNextDay = crossing && nextDayTicked;
  const span = buildShiftSpan(day, startT, endT, endsNextDay ? nextDay(day) : day);

  /**
   * ONE TAP, ONE ENTRY (Brian's Aug 18: two identical J-039 entries saved 52 seconds apart). Save
   * greys out while it works (`pending`), but a double tap can land both clicks before that
   * re-render; the ref closes the gap in the same tick. Underneath, 0360 refuses the same hours
   * twice for one person, simultaneous saves included.
   */
  const inFlight = useRef(false);
  /** The shift a refusal named, bolded in the day's list; and a nudge to re-read that list. */
  const [clashId, setClashId] = useState<string | null>(null);
  const [dayKey, setDayKey] = useState(0);

  /**
   * OPEN THAT SHIFT, ONE MODAL AT A TIME. On Timecards the link only changes ?entry=, so this form
   * stayed open under the shift's editor and one Back closed both. It closes itself once the URL
   * names that shift: after the navigation, so its own history step never undoes it (a Modal steps
   * back only while its marker is still the current entry, overlay-history.ts). From the job's page
   * the link leaves the page and this unmounts anyway.
   */
  const searchParams = useSearchParams();
  const [openingShift, setOpeningShift] = useState<string | null>(null);
  useEffect(() => {
    if (openingShift && searchParams?.get("entry") === openingShift) {
      setOpen(false);
      setOpeningShift(null);
    }
  }, [searchParams, openingShift]);

  const whoName = (members.find((m) => m.id === who)?.full_name ?? "").trim();
  const whoWords = whoName ? whoName.split(/\s+/)[0] : "you";

  function submit() {
    if (inFlight.current || pending) return;
    setError(null);
    const job = resolveJobChoice({ value: jobValue, fixedJob, companyTimeCode, jobCode, jobCodesEnabled, labelOf });
    if (!job.ok) return setError(job.error);
    if (!span) return setError("Enter a valid day and times.");
    const { clockIn, clockOut } = span;
    if (clockOut <= clockIn) return setError("End must be after start.");
    inFlight.current = true;
    start(async () => {
      try {
        await save(clockIn, clockOut, job);
      } finally {
        inFlight.current = false;
      }
    });
  }

  async function save(clockIn: Date, clockOut: Date, job: { job_id: string | null; job_code: string | null; where: string }) {
    let res: Awaited<ReturnType<typeof createManualEntry>>;
    try {
      res = await createManualEntry({
        profile_id: who,
        clock_in: clockIn.toISOString(),
        clock_out: clockOut.toISOString(),
        job_id: job.job_id,
        job_code: job.job_code,
        // Stated every time, so 0 is a real answer and not "wasn't asked".
        lunch_minutes: lunchMinutesFor(tookLunch),
        notes: "",
      });
    } catch {
      // THE 60MPH LAW: a dropped connection is a sentence, never a page torn down.
      setError("No connection, so those hours didn't save. Try again in a moment.");
      return;
    }
    if (!res.ok) {
      setError(res.error ?? "Could not add the entry.");
      // The shift in the way is in the day's list: bold it, and re-read the day so a shift saved a
      // moment ago (another tab, a second phone) is there too.
      setClashId(res.clash?.id ?? null);
      setDayKey((k) => k + 1);
      return;
    }
    setClashId(null);
    setOpen(false);
    // SAY WHAT WAS RECORDED, AND HAND OVER ITS DOOR: the shift's editor is where its miles, a pay
    // rate and notes go, which this form no longer asks.
    const paid = (clockOut.getTime() - clockIn.getTime()) / 3_600_000 - lunchMinutesFor(tookLunch) / 60;
    const id = res.id;
    toast(
      addedWords({ hours: paid, who: whoWords, day, where: job.where }),
      "success",
      id ? { label: "Open That Shift", onClick: () => router.push(`/timecards?entry=${id}`) } : undefined,
    );
    if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
    // The next entry starts where the schedule says again.
    jobTouched.current = false;
    setJobValue("");
    setNextDayTicked(false);
    setDayKey((k) => k + 1);
    router.refresh();
  }

  if (!isStaff) return null; // techs clock in and out live: only the office adds hours

  return (
    <>
      <Button variant="outline" className="min-h-11" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add Time Entry
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add Time Entry"
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={submit} saving={pending} saveLabel="Save Entry" />}
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          <div>
            <Label htmlFor="ate-who">Who</Label>
            <Select
              id="ate-who"
              className="h-11"
              value={who}
              onChange={(e) => {
                setWho(e.target.value);
                whoOrDayChanged();
              }}
            >
              {!viewerListed && <option value="">Myself</option>}
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name ?? "Unnamed"}
                </option>
              ))}
            </Select>
          </div>

          {fixedJob ? (
            <p className="text-sm font-medium text-slate-800">{`Job · ${fixedJob.label}`}</p>
          ) : (
            <div>
              <Label htmlFor="ate-job">Job</Label>
              <Select id="ate-job" className="h-11" value={jobValue} onChange={(e) => pickJob(e.target.value)}>
                <option value="">Pick The Job</option>
                {orphan && <option value={jobValue}>{labelOf(jobValue)}</option>}
                {scheduledOpt && (
                  <optgroup label="On The Schedule That Day">
                    <option value={scheduledOpt.id}>{scheduledOpt.label}</option>
                  </optgroup>
                )}
                {scheduledOpt ? (
                  <optgroup label="Other Jobs">
                    {otherJobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {whichJobLabel(j, jobCodesEnabled)}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  otherJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {whichJobLabel(j, jobCodesEnabled)}
                    </option>
                  ))
                )}
                {companyTimeCode ? <option value={COMPANY_TIME}>Company Time (Not Billed)</option> : <option value={NO_JOB}>No Job</option>}
              </Select>
              {!companyTimeCode && jobValue === NO_JOB && (
                <p className="mt-1 text-xs text-amber-800">It waits under Hours On No Job until someone picks one.</p>
              )}
              {/* The list stops 30 days after a job finishes; the job's own page takes any job. */}
              <p className="mt-1 text-xs text-slate-500">Older job? Add it from the job&apos;s Time tab.</p>
              <div className="mt-1">
                <NewJobInline onCreated={addNewJob} className="min-h-11" />
              </div>
            </div>
          )}

          {/* What this person already has that day, with Put This On <job> for a punch on no job (the
              duplicate punches, 2026-09-26), and where the schedule put them, which the Job field
              above starts on. Reads again when the person, the day or the job changes, and after a
              refusal. */}
          <SameDayShifts
            profileId={who || viewerId || ""}
            date={day}
            jobId={fixedJob ? fixedJob.id : jobIsReal ? jobValue : null}
            highlightId={clashId}
            refreshKey={dayKey}
            onRead={(answer) => {
              if (fixedJob) return;
              setScheduled(answer.ok && !answer.offThatDay ? answer.scheduledJob : null);
              const next = preselectFrom(answer, jobTouched.current);
              if (next !== null) setJobValue(next);
            }}
            onPlaced={(_sentence, shift) => {
              setOpen(false);
              setError(null);
              setClashId(null);
              // The door moved the punch only: say what was typed here that it did not get.
              const left = notCarriedWords({ lunch: tookLunch, code: jobCodesEnabled ? jobCode : null });
              if (left) toast(left, "info", { label: "Open That Shift", onClick: () => router.push(`/timecards?entry=${shift.id}`) });
              router.refresh();
            }}
            onOpenShift={(shift) => setOpeningShift(shift.id)}
          />

          <div>
            <Label htmlFor="ate-day">Day</Label>
            <Input
              id="ate-day"
              type="date"
              className="h-11"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                whoOrDayChanged();
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ate-start">Start</Label>
              <Input id="ate-start" type="time" className="h-11" value={startT} onChange={(e) => setStartT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ate-end">End</Label>
              <Input id="ate-end" type="time" className="h-11" value={endT} onChange={(e) => setEndT(e.target.value)} />
            </div>
          </div>
          {crossing && (
            <div className="space-y-1">
              <p className="text-xs text-slate-600">Ends before it starts.</p>
              <label htmlFor="ate-next-day" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-slate-700">
                <input
                  id="ate-next-day"
                  type="checkbox"
                  checked={nextDayTicked}
                  onChange={(e) => setNextDayTicked(e.target.checked)}
                  className="h-5 w-5 shrink-0 rounded border-slate-300 text-brand"
                />
                <span>Ends The Next Day</span>
              </label>
            </div>
          )}

          <LunchCheckbox id="ate-lunch" checked={tookLunch} onChange={setTookLunch} />

          {/* The Job Codes switch only hides this door (a switch never changes a number). Company
              Time files the company's own code, so the question is not asked twice. */}
          {jobCodesEnabled && !(jobValue === COMPANY_TIME && !fixedJob) && (
            <div>
              <Label htmlFor="ate-code">Job Code</Label>
              <Select id="ate-code" className="h-11" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
                <option value="">No Code</option>
                {jobCodes
                  .filter((c) => c.active !== false)
                  .map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code}
                      {c.description ? ` — ${c.description}` : ""}
                    </option>
                  ))}
              </Select>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
