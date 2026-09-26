"use client";

/**
 * THE TOP OF THE VISIT: start the work, or clock in on it.
 *
 * Erik, 2026-09-25, on Tom Goodman's inspection: "when I showed up, I didn't need the inspector or
 * the estimator. I just needed a job linked to that lead to start the clock, simple." The page led
 * with the Inspector; the only job door was inside Edit Details. So he made J-055 by hand and
 * backdated his clock, and the visit pointed at nothing.
 *
 * Five states, one card:
 *   start    office, no job yet:   Start The Job And Clock In (a small sheet: what the job will be,
 *                                  when the clock starts) · Start The Job. When this customer has
 *                                  exactly one job (open or finished) made on the visit's day, Link To J-055
 *                                  Instead LEADS and Make A New Job Anyway is the second door; when
 *                                  the tapper is on the clock on that very job, there is no switch at
 *                                  all (it would cut the right shift onto a duplicate). The app
 *                                  offers; a person taps.
 *            A visit that is OVER (marked completed, or its day has passed: visitIsOver) never
 *                                  leads with a clock: it leads with Link To J-055 when there is one, else a quiet Start A Job From This
 *                                  Visit (the job only). The same-day job is offered open OR finished:
 *                                  Tom Goodman's J-055 was finished and invoiced before anybody came
 *                                  back to the visit, and an open-only rule led with a duplicate.
 *   ask      crew, no job yet:     Ask The Office (the bell) · Call / Text The Office. No dead end.
 *   linked   anybody, job linked:  Clock In On J-055 (Switch To J-055 when on the clock elsewhere)
 *                                  · Open J-055.
 *   closed   the visit is over and its job is finished: Open J-055 only. No clock to start.
 *   here     already on it:        You're On The Clock Here · Open J-055.
 *
 * Every time shown or picked is the ORG's clock.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play, ArrowLeftRight, Clock, Link2, Phone, MessageSquare, Bell, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { getPosition } from "@/lib/geo";
import type { GeoPoint } from "@/lib/types";
import { formatDateTimeTz } from "@/lib/tz";
import { clockOffered, clockWords, jobIsFinished, jobShort, startedAtProblem } from "@/lib/appointments/visit-start";
import { ClockStartPicker, pickerInstant, pickerParts } from "../../timeclock/clock-start-picker";
import { clockIn, switchJob, deleteTimeEntry } from "../../timeclock/actions";
import { askOfficeToStartJob, linkVisitInstead, startJobFromVisit, type OnClock, type StartJobResult } from "../start-job-actions";

export type VisitStartJob = { id: string; job_number: string | null; name: string | null; status?: string | null };
/** `whole`: the running entry has no job and no code, so a switch moves the WHOLE shift onto the
 *  new job (0288 re-points it) rather than ending a part now. */
export type VisitStartOpenEntry = { id: string; job_id: string | null; label: string; clock_in: string; whole?: boolean };

export type VisitStartState = "start" | "ask" | "linked" | "switch" | "closed" | "here";

/** Which face the card shows. Pure, so the render test and the page agree. */
export function visitStartState(input: {
  isStaff: boolean;
  job: VisitStartJob | null;
  openEntry: VisitStartOpenEntry | null;
  /** The visit is over (visitIsOver: marked completed, or its day has passed on the org's clock). */
  visitOver?: boolean;
}): VisitStartState {
  if (!input.job) return input.isStaff ? "start" : "ask";
  if (input.openEntry?.job_id === input.job.id) return "here";
  // The visit is over and its job is finished: paperwork, not a clock-in.
  if (!clockOffered(!!input.visitOver, input.job.status)) return "closed";
  return input.openEntry ? "switch" : "linked";
}

/**
 * Whether the sheet offers the one-tap "Visit Time" start: a real start (not in the future, not
 * before midnight yesterday) that does not land inside the tapper's latest finished shift. A minute
 * of slack, the same the overlap test and 0278 allow.
 */
export function visitTimeOffered(
  scheduledStart: string | null,
  lastClockOut: string | null,
  nowMs: number,
  tz: string,
): boolean {
  if (!scheduledStart || startedAtProblem(scheduledStart, nowMs, tz) != null) return false;
  if (lastClockOut && Date.parse(scheduledStart) < Date.parse(lastClockOut) - 60_000) return false;
  return true;
}

/** The tap is the user gesture (the iOS-PWA rule), so a fix can be asked for; never waits long. */
async function gpsBestEffort(): Promise<GeoPoint | null> {
  try {
    const r = await getPosition({ timeout: 4_000 });
    return r.status === "ok" ? { lat: r.coords.lat, lng: r.coords.lng, accuracy: r.accuracy } : null;
  } catch {
    return null;
  }
}

const OFFLINE = "No connection. That didn't go through; try again when you have a bar or two.";

const btn = "h-11 w-full justify-center sm:w-auto";
const linkBtn =
  "btn-gloss inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-[rgb(var(--glass-tint))]/10 sm:w-auto";

export function VisitStartCard({
  appointmentId,
  tz,
  isStaff,
  job,
  openEntry,
  linkInstead,
  preview,
  officePhone,
  lastClockOut = null,
  visitOver = false,
}: {
  appointmentId: string;
  tz: string;
  isStaff: boolean;
  job: VisitStartJob | null;
  openEntry: VisitStartOpenEntry | null;
  linkInstead: (VisitStartJob & { customer: string | null }) | null;
  /** What the job will be, from the same fields createJobFromAppointment carries. */
  preview: { name: string; customer: string | null; address: string | null; scheduledStart: string | null };
  officePhone: string | null;
  /** The end of the tapper's latest finished shift: a Visit Time start inside it is not offered. */
  lastClockOut?: string | null;
  /** The visit is over (visitIsOver, decided by the page on the org's clock): the card never leads with a clock. */
  visitOver?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  // The sheet's clock choice. "now" sends null; "visit" the visit's own start; "pick" the picker's.
  const [choice, setChoice] = useState<"now" | "visit" | "pick">("now");
  const [picked, setPicked] = useState<string | null>(null);
  // The server can find a running clock the page didn't know about (clocked in on another tab).
  const [onClock, setOnClock] = useState<OnClock | null>(
    openEntry && openEntry.job_id !== job?.id
      ? {
          entryId: openEntry.id,
          jobId: openEntry.job_id,
          label: openEntry.label,
          since: clockWords(openEntry.clock_in, tz),
          whole: !!openEntry.whole,
        }
      : null,
  );
  // On the clock on the very job this visit could link to (Tom Goodman as it stood): the only right
  // move is the link. A switch would cut that shift onto a brand-new duplicate job.
  const onLinkJob = !!linkInstead && !!onClock?.jobId && onClock.jobId === linkInstead.id;

  const state = visitStartState({ isStaff, job, openEntry, visitOver });
  const jobNo = job ? jobShort(job) : "";
  // The visit is over: nothing on the start face starts a clock (a new job is the job only).
  const over = visitOver;
  const linkFinished = !!linkInstead && jobIsFinished(linkInstead.status);

  const nowMs = Date.now();
  // Visit Time is offered only when it is a real start: in the window, and not inside hours already
  // recorded (the server refuses those too, with the Timecards' words; this keeps the one-tap chip
  // from being the trap).
  const visitOk = visitTimeOffered(preview.scheduledStart, lastClockOut, nowMs, tz);
  const startIso = choice === "now" ? null : choice === "visit" ? preview.scheduledStart : picked;
  const problem = choice === "pick" && !picked ? "Pick a start time." : startedAtProblem(startIso, nowMs, tz);

  function run<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, after: (r: T) => void) {
    setErr(null);
    setNote(null);
    start(async () => {
      let res: T;
      try {
        res = await fn();
      } catch {
        setErr(OFFLINE);
        return;
      }
      if (!res?.ok) {
        const oc = (res as unknown as StartJobResult).onClock;
        if (oc) setOnClock(oc);
        setErr(res?.error ?? "Something went wrong. Nothing was changed.");
        return;
      }
      after(res);
    });
  }

  /** A job was made or linked: say what happened, then go to it. */
  function landOnJob(res: StartJobResult) {
    setSheet(false);
    const undoId = res.undoEntryId;
    toast(
      res.message ?? "Done.",
      "success",
      undoId
        ? {
            label: "Undo Clock-In",
            onClick: async () => {
              try {
                const u = await deleteTimeEntry(undoId);
                toast(
                  u.ok ? `Clock-in undone. ${res.jobNumber ?? "The job"} stays.` : (u.error ?? "The clock-in could not be undone."),
                  u.ok ? "success" : "error",
                );
              } catch {
                toast(OFFLINE, "error");
              }
              router.refresh();
            },
          }
        : undefined,
    );
    if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
    if (res.jobId) router.push(`/jobs/${res.jobId}`);
    else router.refresh();
  }

  const startWithClock = () =>
    run(
      async () => {
        const gps = await gpsBestEffort();
        return startJobFromVisit({
          appointmentId,
          clock: onClock ? "switch" : "in",
          startAt: onClock ? null : startIso,
          gps,
        });
      },
      landOnJob,
    );

  const startOnly = () => run(() => startJobFromVisit({ appointmentId, clock: "none" }), landOnJob);

  const openSheet = () => {
    setErr(null);
    setChoice("now");
    setPicked(null);
    setSheet(true);
  };

  const linkInsteadTap = () => run(() => linkVisitInstead(appointmentId, linkInstead!.id), landOnJob);

  const clockHere = () =>
    run(
      async () => {
        const gps = await gpsBestEffort();
        if (openEntry && state === "switch") {
          return switchJob({ entry_id: openEntry.id, job_id: job!.id, job_code: null, gps });
        }
        return clockIn({ job_id: job!.id, job_code: null, gps, clock_in_at: null });
      },
      (res: { ok: boolean; warning?: string; mode?: "cut" | "repointed" }) => {
        const at = clockWords(new Date().toISOString(), tz);
        toast(
          state === "switch"
            ? res.mode === "repointed" && openEntry
              ? `Moved your shift since ${clockWords(openEntry.clock_in, tz)} onto ${jobNo}.`
              : `Switched your clock to ${jobNo} from ${openEntry?.label ?? "the other job"} at ${at}.`
            : `Clocked you in on ${jobNo} at ${at}.`,
          "success",
        );
        if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
        router.refresh();
      },
    );

  const ask = () =>
    run(
      () => askOfficeToStartJob(appointmentId),
      (res: { ok: boolean; message?: string }) => setNote(res.message ?? "The office has been asked."),
    );

  const tel = (officePhone ?? "").replace(/[^\d+]/g, "");

  return (
    <section
      className="rounded-xl border border-teal-200 bg-teal-50/60 p-4"
      aria-label="Start the work"
      data-visit-start={state}
    >
      {state === "start" && (
        <>
          <h2 className="text-base font-semibold text-slate-900">{over ? "This visit is done" : "Here to do the work?"}</h2>
          {linkInstead ? (
            onLinkJob ? (
              <p className="mt-0.5 text-sm text-slate-700">
                You&rsquo;re on the clock on <span className="font-semibold">{jobShort(linkInstead)}</span> since{" "}
                {onClock!.since}
                {linkInstead.name && linkInstead.job_number ? ` · ${linkInstead.name}` : ""}.{" "}
                {linkInstead.customer ?? "This customer"} already has it. Link this visit to it.
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-slate-700">
                {linkInstead.customer ?? "This customer"} already has{" "}
                <span className="font-semibold">{jobShort(linkInstead)}</span>
                {linkInstead.name && linkInstead.job_number ? ` · ${linkInstead.name}` : ""}, made that day
                {linkFinished ? " and finished" : ""}.{" "}
                {over ? "Link this visit to it?" : "Use it instead of making a second job?"}
              </p>
            )
          ) : over ? (
            <p className="mt-0.5 text-sm text-slate-600">
              It has no job. If the work goes on, start one from it: it brings {preview.customer ?? "the customer"}, the
              address and the visit time along, and it doesn&rsquo;t start your clock.
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-slate-600">
              Start a job from this visit. It brings {preview.customer ?? "the customer"}, the address and the visit time
              along.
            </p>
          )}
          {onClock && !onLinkJob && !over && (
            <p className="mt-1 text-sm text-amber-700">
              You&rsquo;re on the clock on {onClock.label} since {onClock.since}.{" "}
              {onClock.whole
                ? "Starting this job moves that whole shift onto it."
                : "Starting this job switches your clock here."}
            </p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {linkInstead ? (
              <>
                <Button className={btn} onClick={linkInsteadTap} disabled={pending}>
                  <Link2 />{" "}
                  {onLinkJob || over ? `Link To ${jobShort(linkInstead)}` : `Link To ${jobShort(linkInstead)} Instead`}
                </Button>
                {/* The second door. On the clock on the linkable job it makes the job only: moving
                    that clock is exactly the mistake this card exists to prevent. On a visit that is
                    over it is the job only too: the visit starts no clock. */}
                <Button
                  variant="outline"
                  className={btn}
                  onClick={onLinkJob || over ? startOnly : openSheet}
                  disabled={pending}
                >
                  <Briefcase /> Make A New Job Anyway
                </Button>
              </>
            ) : over ? (
              // Quiet on purpose: the visit is over, so this is the job only, and never the lead door.
              <Button variant="outline" className={btn} onClick={startOnly} disabled={pending}>
                <Briefcase /> Start A Job From This Visit
              </Button>
            ) : (
              <>
                <Button className={btn} onClick={openSheet} disabled={pending}>
                  <Play /> Start The Job And Clock In
                </Button>
                <Button variant="outline" className={btn} onClick={startOnly} disabled={pending}>
                  <Briefcase /> Start The Job
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {state === "ask" && (
        <>
          <h2 className="text-base font-semibold text-slate-900">Ask the office to start the job</h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {over
              ? "This visit is done and has no job. If the work goes on, ask the office to start one."
              : "This visit has no job yet, and only the office can start one. Once they do, you can clock in right here."}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button className={btn} onClick={ask} disabled={pending}>
              <Bell /> Ask The Office
            </Button>
            {tel && (
              <a href={`tel:${tel}`} className={linkBtn}>
                <Phone className="h-4 w-4" /> Call The Office
              </a>
            )}
            {tel && (
              <a href={`sms:${tel}`} className={linkBtn}>
                <MessageSquare className="h-4 w-4" /> Text The Office
              </a>
            )}
          </div>
        </>
      )}

      {(state === "linked" || state === "switch" || state === "here" || state === "closed") && job && (
        <>
          <h2 className="text-base font-semibold text-slate-900">
            This visit is {jobNo}
            {job.name && job.job_number ? <span className="font-normal text-slate-600"> · {job.name}</span> : null}
          </h2>
          {state === "switch" && openEntry && (
            <p className="mt-0.5 text-sm text-amber-700">
              You&rsquo;re on the clock on {openEntry.label} since {clockWords(openEntry.clock_in, tz)}.{" "}
              {openEntry.whole
                ? `Switching moves that whole shift onto ${jobNo}.`
                : "Switching ends that part now and starts this one."}
            </p>
          )}
          {state === "closed" && (
            <p className="mt-0.5 text-sm text-slate-600">
              The visit is done and {jobNo} is finished, so there&rsquo;s no clock to start here.
            </p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {state === "here" ? (
              <span
                className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-green-300 bg-green-50 px-4 text-sm font-semibold text-green-700 sm:w-auto"
                role="status"
              >
                <Clock className="h-4 w-4" /> You&rsquo;re On The Clock Here
              </span>
            ) : state === "closed" ? null : (
              <Button className={btn} onClick={clockHere} disabled={pending}>
                {state === "switch" ? <ArrowLeftRight /> : <Play />}
                {state === "switch" ? `Switch To ${jobNo}` : `Clock In On ${jobNo}`}
              </Button>
            )}
            <Link href={`/jobs/${job.id}`} className={linkBtn}>
              <Briefcase className="h-4 w-4" /> Open {jobNo}
            </Link>
          </div>
        </>
      )}

      {err && !sheet && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {err}
        </p>
      )}
      {note && (
        <p className="mt-2 text-sm text-green-700" role="status">
          {note}
        </p>
      )}

      {state === "start" && !over && (
        <Modal
          open={sheet}
          onClose={() => setSheet(false)}
          title={linkInstead ? "Make A New Job" : "Start The Job And Clock In"}
          size="sm"
          footer={
            <>
              <Button type="button" variant="outline" className="h-11" onClick={() => setSheet(false)} disabled={pending}>
                Cancel
              </Button>
              {onLinkJob && linkInstead ? (
                <Button type="button" className="h-11" onClick={linkInsteadTap} disabled={pending}>
                  {pending ? "Linking…" : `Link To ${jobShort(linkInstead)}`}
                </Button>
              ) : (
                <Button
                  type="button"
                  className="h-11"
                  onClick={startWithClock}
                  disabled={pending || (!onClock && !!problem)}
                >
                  {pending ? "Starting…" : onClock ? "Switch To This Job" : "Start The Job And Clock In"}
                </Button>
              )}
            </>
          }
        >
          <div className="space-y-4">
            {linkInstead && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {linkInstead.customer ?? "This customer"} already has{" "}
                <span className="font-semibold">{jobShort(linkInstead)}</span>, made that day. This makes a second job.
              </p>
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">The job will be</p>
              <dl className="mt-1.5 space-y-1 text-sm">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-slate-500">Name</dt>
                  <dd className="font-medium text-slate-900">{preview.name}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-slate-500">Customer</dt>
                  <dd className="text-slate-800">{preview.customer ?? "None yet"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-slate-500">Address</dt>
                  <dd className="text-slate-800">{preview.address ?? "None yet"}</dd>
                </div>
                {preview.scheduledStart && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-slate-500">Planned</dt>
                    <dd className="text-slate-800">{formatDateTimeTz(preview.scheduledStart, tz)}</dd>
                  </div>
                )}
              </dl>
            </div>

            {onLinkJob && linkInstead ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                You&rsquo;re on the clock on {jobShort(linkInstead)} since {onClock!.since}. Link this visit to it instead;
                a new job here would take your clock off the job you are on.
              </p>
            ) : onClock ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {onClock.whole
                  ? `You're on the clock since ${onClock.since} with no job. This moves that whole shift onto the new job, from ${onClock.since}. No second clock is opened.`
                  : `You're on the clock on ${onClock.label} since ${onClock.since}. This switches your clock to the new job now: the part on ${onClock.label} ends at this moment. No second clock is opened.`}
              </p>
            ) : (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Started at</p>
                <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label="Started at">
                  {(
                    [
                      ["now", "Now"],
                      ...(visitOk ? [["visit", `Visit Time · ${clockWords(preview.scheduledStart!, tz)}`]] : []),
                      ["pick", "Pick A Time"],
                    ] as [typeof choice, string][]
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={choice === k}
                      onClick={() => {
                        setChoice(k);
                        setErr(null);
                        // The picker opens on the current minute and only reports a change, so the
                        // start it shows is seeded here: what is on screen is what gets sent.
                        if (k === "pick") {
                          const n = pickerParts(undefined, tz);
                          setPicked(pickerInstant(n.date, n.time, tz));
                        }
                      }}
                      className={`h-11 rounded-lg border px-3 text-sm font-medium ${
                        choice === k
                          ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-ink))] text-white"
                          : "border-slate-300 bg-white text-slate-700"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {choice === "pick" && (
                  <ClockStartPicker
                    className="mt-2"
                    startExpanded
                    staff
                    tz={tz}
                    caption="Your clock starts at the time above."
                    onChange={(iso) => setPicked(iso)}
                  />
                )}
                {problem && choice !== "now" && <p className="mt-1 text-sm text-red-600">{problem}</p>}
              </div>
            )}
            {err && (
              <p className="text-sm text-red-600" role="alert">
                {err}
              </p>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
