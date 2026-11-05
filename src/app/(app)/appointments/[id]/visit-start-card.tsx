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
 * Every time shown or picked is the ORG's clock. Every word is the signed-in person's language
 * (lib/words/visit-page, vp_): the card reads useLang() and its clocks through lib/utils formatTime
 * for a Spanish reader ("12:00 p. m."), clockWords for an English one, byte for byte as before.
 */
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play, ArrowLeftRight, Clock, Link2, Phone, MessageSquare, Bell, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillNodes } from "@/components/fill-nodes";
import { fillText, translator } from "@/lib/i18n";
import { formatDateTime, formatTime } from "@/lib/utils";
import { getPosition } from "@/lib/geo";
import type { GeoPoint } from "@/lib/types";
import { clockOffered, clockWords, jobIsFinished, jobShort, startedAtProblem } from "@/lib/appointments/visit-start";
import { ClockStartPicker, pickerInstant, pickerParts } from "../../timeclock/clock-start-picker";
import { clockIn, switchJob, deleteTimeEntry } from "../../timeclock/actions";
import { switchMovesWholeNow } from "../../timeclock/switch-window";
import { askOfficeToStartJob, linkVisitInstead, startJobFromVisit, type OnClock, type StartJobResult } from "../start-job-actions";

export type VisitStartJob = { id: string; job_number: string | null; name: string | null; status?: string | null };
/** The running entry. `job_id` and `job_code` say whether the punch has a PLACE and `clock_in` says
 *  how old it is — the two facts a switch's outcome is decided from (switch-window). The card asks that
 *  rule itself, on a live clock, rather than being handed a boolean settled when the page rendered. */
export type VisitStartOpenEntry = {
  id: string;
  job_id: string | null;
  job_code?: string | null;
  label: string;
  clock_in: string;
};

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

const btn = "h-11 w-full justify-center sm:w-auto";
const linkBtn =
  "btn-gloss inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-[rgb(var(--glass-tint))]/10 sm:w-auto";

/** The job's short name, bold, inside a sentence (a {job} slot filled through fillNodes). */
const bold = (s: string) => <span className="font-semibold">{s}</span>;

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
  const lang = useLang();
  const t = translator(lang);
  /** "12:00 PM" on the org's clock, as always; "12:00 p. m." to a Spanish reader (lib/utils formatTime). */
  const clockAt = (iso: string) => (lang === "es" ? formatTime(iso, tz, "es") : clockWords(iso, tz));
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
          jobCode: (openEntry.job_code ?? "").trim() || null,
          label: openEntry.label,
          clockIn: openEntry.clock_in,
          since: clockAt(openEntry.clock_in),
        }
      : null,
  );
  // On the clock on the very job this visit could link to (Tom Goodman as it stood): the only right
  // move is the link. A switch would cut that shift onto a brand-new duplicate job.
  const onLinkJob = !!linkInstead && !!onClock?.jobId && onClock.jobId === linkInstead.id;

  const state = visitStartState({ isStaff, job, openEntry, visitOver });
  const jobNo = job ? jobShort(job, lang, t) : "";
  // The visit is over: nothing on the start face starts a clock (a new job is the job only).
  const over = visitOver;
  const linkFinished = !!linkInstead && jobIsFinished(linkInstead.status);
  // " · 3245 West Garnet Boulevard" after the linkable job's number, when it has both.
  const linkName = linkInstead && linkInstead.name && linkInstead.job_number ? ` · ${linkInstead.name}` : "";
  const linkCustomer = linkInstead?.customer ?? t("vp_thisCustomer");

  /**
   * ONE CLOCK, AND IT TICKS WHILE SOMEBODY IS ON IT. Every sentence and chip below turns on what time
   * it is now — whether a switch moves the whole punch or cuts it, and whether a picked start is still
   * a real one — and nothing else makes this card re-render.
   *
   * The failure this prevents: punch on J-050 at 7:00, open this visit at 7:05 on the drive, leave it
   * on screen. At 7:40 the card was still showing the words it rendered with, which promised the whole
   * punch moves; the server reads its own clock at the tap and CUTS, leaving 40 minutes on a job nobody
   * worked. The Timeclock panel ticks for exactly this reason. It also ticks while the sheet is open,
   * which is the only place the picked-start words are read.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!onClock && !sheet) return;
    setNowMs(Date.now());
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [onClock, sheet]);
  /**
   * DOES A SWITCH MOVE THE WHOLE PUNCH, OR CUT IT — the server's own rule (switch-window), asked here
   * on the clock as it is NOW rather than read off a flag the page baked in. Both faces and the sheet
   * ask this one question, so they cannot disagree with each other or with the write.
   */
  const movesWhole = (oc: { jobId: string | null; jobCode: string | null; clockIn: string }) =>
    switchMovesWholeNow(!!oc.jobId || !!oc.jobCode, Date.parse(oc.clockIn), nowMs);
  // Visit Time is offered only when it is a real start: in the window, and not inside hours already
  // recorded (the server refuses those too, with the Timecards' words; this keeps the one-tap chip
  // from being the trap).
  const visitOk = visitTimeOffered(preview.scheduledStart, lastClockOut, nowMs, tz);
  const startIso = choice === "now" ? null : choice === "visit" ? preview.scheduledStart : picked;
  const problem = choice === "pick" && !picked ? t("vp_pickAStartTime") : startedAtProblem(startIso, nowMs, tz, lang, t);

  function run<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, after: (r: T) => void) {
    setErr(null);
    setNote(null);
    start(async () => {
      let res: T;
      try {
        res = await fn();
      } catch {
        setErr(t("vp_noConnection"));
        return;
      }
      if (!res?.ok) {
        const oc = (res as unknown as StartJobResult).onClock;
        if (oc) setOnClock(oc);
        setErr(res?.error ?? t("vp_somethingWrongNothingChanged"));
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
      res.message ?? t("vp_doneDot"),
      "success",
      undoId
        ? {
            label: t("vp_btn_undoClockIn"),
            onClick: async () => {
              try {
                const u = await deleteTimeEntry(undoId);
                toast(
                  u.ok ? fillText(t("vp_clockInUndone"), { job: res.jobNumber ?? t("vp_theJob") }) : (u.error ?? t("vp_clockInNotUndone")),
                  u.ok ? "success" : "error",
                );
              } catch {
                toast(t("vp_noConnection"), "error");
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
        const at = clockAt(new Date().toISOString());
        toast(
          state === "switch"
            ? res.mode === "repointed" && openEntry
              ? // "Punch", not "shift": the move is one row, and an earlier part of a cut day stays put.
                fillText(t("vp_movedWholePunch"), { since: clockAt(openEntry.clock_in), job: jobNo })
              : fillText(t("vp_switchedClock"), { job: jobNo, from: openEntry?.label ?? t("vp_theOtherJob"), at })
            : fillText(t("vp_clockedYouIn"), { job: jobNo, at }),
          "success",
        );
        if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
        router.refresh();
      },
    );

  const ask = () =>
    run(
      () => askOfficeToStartJob(appointmentId),
      (res: { ok: boolean; message?: string }) => setNote(res.message ?? t("vp_officeAsked")),
    );

  const tel = (officePhone ?? "").replace(/[^\d+]/g, "");

  return (
    <section
      className="rounded-xl border border-teal-200 bg-teal-50/60 p-4"
      aria-label={t("vp_startTheWorkAria")}
      data-visit-start={state}
    >
      {state === "start" && (
        <>
          <h2 className="text-base font-semibold text-slate-900">{over ? t("vp_thisVisitIsDone") : t("vp_hereToDoTheWork")}</h2>
          {linkInstead ? (
            onLinkJob ? (
              <p className="mt-0.5 text-sm text-slate-700">
                {fillNodes(t("vp_onClockOnLinkJob"), { job: bold(jobShort(linkInstead, lang, t)), since: onClock!.since, name: linkName, customer: linkCustomer })}
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-slate-700">
                {fillNodes(t(linkFinished ? "vp_alreadyHasMadeThatDayFinished" : "vp_alreadyHasMadeThatDay"), {
                  customer: linkCustomer,
                  job: bold(jobShort(linkInstead, lang, t)),
                  name: linkName,
                })}{" "}
                {over ? t("vp_linkThisVisitToItQ") : t("vp_useItInsteadQ")}
              </p>
            )
          ) : over ? (
            <p className="mt-0.5 text-sm text-slate-600">
              {fillText(t("vp_overNoJobLine"), { customer: preview.customer ?? t("vp_theCustomer") })}
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-slate-600">
              {fillText(t("vp_startAJobLine"), { customer: preview.customer ?? t("vp_theCustomer") })}
            </p>
          )}
          {onClock && !onLinkJob && !over && (
            // suppressHydrationWarning: the fork is the punch's age, so the server's HTML and the
            // first client render can land either side of the fifteen-minute line.
            <p className="mt-1 text-sm text-amber-700" suppressHydrationWarning>
              {fillText(t("vp_onClockSince"), { label: onClock.label, since: onClock.since })}{" "}
              {movesWhole(onClock) ? t("vp_startingMovesWhole") : t("vp_startingSwitchesHere")}
            </p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {linkInstead ? (
              <>
                <Button className={btn} onClick={linkInsteadTap} disabled={pending}>
                  <Link2 />{" "}
                  {fillText(t(onLinkJob || over ? "vp_btn_linkTo" : "vp_btn_linkToInstead"), { job: jobShort(linkInstead, lang, t) })}
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
                  <Briefcase /> {t("vp_btn_makeANewJobAnyway")}
                </Button>
              </>
            ) : over ? (
              // Quiet on purpose: the visit is over, so this is the job only, and never the lead door.
              <Button variant="outline" className={btn} onClick={startOnly} disabled={pending}>
                <Briefcase /> {t("vp_btn_startAJobFromThisVisit")}
              </Button>
            ) : (
              <>
                <Button className={btn} onClick={openSheet} disabled={pending}>
                  <Play /> {t("vp_btn_startTheJobAndClockIn")}
                </Button>
                <Button variant="outline" className={btn} onClick={startOnly} disabled={pending}>
                  <Briefcase /> {t("vp_btn_startTheJob")}
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {state === "ask" && (
        <>
          <h2 className="text-base font-semibold text-slate-900">{t("vp_askOfficeToStart")}</h2>
          <p className="mt-0.5 text-sm text-slate-600">{over ? t("vp_askOverNoJob") : t("vp_askNoJobYet")}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button className={btn} onClick={ask} disabled={pending}>
              <Bell /> {t("vp_btn_askTheOffice")}
            </Button>
            {tel && (
              <a href={`tel:${tel}`} className={linkBtn}>
                <Phone className="h-4 w-4" /> {t("vp_btn_callTheOffice")}
              </a>
            )}
            {tel && (
              <a href={`sms:${tel}`} className={linkBtn}>
                <MessageSquare className="h-4 w-4" /> {t("vp_btn_textTheOffice")}
              </a>
            )}
          </div>
        </>
      )}

      {(state === "linked" || state === "switch" || state === "here" || state === "closed") && job && (
        <>
          <h2 className="text-base font-semibold text-slate-900">
            {fillText(t("vp_thisVisitIs"), { job: jobNo })}
            {job.name && job.job_number ? <span className="font-normal text-slate-600"> · {job.name}</span> : null}
          </h2>
          {state === "switch" && openEntry && (
            // THE CUT MAY NOT BE PROMISED WHERE THE SERVER MOVES THE PUNCH WHOLE. This sentence is
            // about which customer gets the hours, and a tech reaches this face too (visitStartState
            // has no staff gate once a job is linked). suppressHydrationWarning: see the start face.
            <p className="mt-0.5 text-sm text-amber-700" suppressHydrationWarning>
              {fillText(t("vp_onClockSince"), { label: openEntry.label, since: clockAt(openEntry.clock_in) })}{" "}
              {movesWhole({
                jobId: openEntry.job_id,
                jobCode: (openEntry.job_code ?? "").trim() || null,
                clockIn: openEntry.clock_in,
              })
                ? fillText(t("vp_switchingMovesWhole"), { job: jobNo })
                : t("vp_switchingEndsPart")}
            </p>
          )}
          {state === "closed" && (
            <p className="mt-0.5 text-sm text-slate-600">{fillText(t("vp_closedLine"), { job: jobNo })}</p>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {state === "here" ? (
              <span
                className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-green-300 bg-green-50 px-4 text-sm font-semibold text-green-700 sm:w-auto"
                role="status"
              >
                <Clock className="h-4 w-4" /> {t("vp_youreOnTheClockHere")}
              </span>
            ) : state === "closed" ? null : (
              <Button className={btn} onClick={clockHere} disabled={pending}>
                {state === "switch" ? <ArrowLeftRight /> : <Play />}
                {fillText(t(state === "switch" ? "vp_btn_switchTo" : "vp_btn_clockInOn"), { job: jobNo })}
              </Button>
            )}
            <Link href={`/jobs/${job.id}`} className={linkBtn}>
              <Briefcase className="h-4 w-4" /> {fillText(t("vp_btn_open"), { job: jobNo })}
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
          title={linkInstead ? t("vp_makeANewJob") : t("vp_btn_startTheJobAndClockIn")}
          size="sm"
          footer={
            <>
              <Button type="button" variant="outline" className="h-11" onClick={() => setSheet(false)} disabled={pending}>
                {t("vp_btn_cancel")}
              </Button>
              {onLinkJob && linkInstead ? (
                <Button type="button" className="h-11" onClick={linkInsteadTap} disabled={pending}>
                  {pending ? t("vp_btn_linking") : fillText(t("vp_btn_linkTo"), { job: jobShort(linkInstead, lang, t) })}
                </Button>
              ) : (
                <Button
                  type="button"
                  className="h-11"
                  onClick={startWithClock}
                  disabled={pending || (!onClock && !!problem)}
                >
                  {pending ? t("vp_btn_starting") : onClock ? t("vp_btn_switchToThisJob") : t("vp_btn_startTheJobAndClockIn")}
                </Button>
              )}
            </>
          }
        >
          <div className="space-y-4">
            {linkInstead && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {fillNodes(t("vp_alreadyHasSecondJob"), { customer: linkCustomer, job: bold(jobShort(linkInstead, lang, t)) })}
              </p>
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("vp_theJobWillBe")}</p>
              <dl className="mt-1.5 space-y-1 text-sm">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-slate-500">{t("vp_name")}</dt>
                  <dd className="font-medium text-slate-900">{preview.name}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-slate-500">{t("vp_customer")}</dt>
                  <dd className="text-slate-800">{preview.customer ?? t("vp_noCustomerYet")}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-slate-500">{t("vp_address")}</dt>
                  <dd className="text-slate-800">{preview.address ?? t("vp_noAddressYet")}</dd>
                </div>
                {preview.scheduledStart && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-slate-500">{t("vp_planned")}</dt>
                    <dd className="text-slate-800">{formatDateTime(preview.scheduledStart, tz, lang)}</dd>
                  </div>
                )}
              </dl>
            </div>

            {onLinkJob && linkInstead ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {fillText(t("vp_onClockLinkInsteadSheet"), { job: jobShort(linkInstead, lang, t), since: onClock!.since })}
              </p>
            ) : onClock ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {movesWhole(onClock)
                  ? // Said with the label, not "with no job": a punch that HAS a job moves whole too
                    // while it is this young, and the old wording was false for exactly that case.
                    fillText(t("vp_sheetMovesWhole"), { label: onClock.label, since: onClock.since })
                  : fillText(t("vp_sheetSwitchesNow"), { label: onClock.label, since: onClock.since })}
              </p>
            ) : (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("vp_startedAt")}</p>
                <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label={t("vp_startedAt")}>
                  {(
                    [
                      ["now", t("vp_btn_now")],
                      ...(visitOk ? [["visit", fillText(t("vp_btn_visitTime"), { clock: clockAt(preview.scheduledStart!) })]] : []),
                      ["pick", t("vp_btn_pickATime")],
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
                    caption={t("vp_clockStartsAtTimeAbove")}
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
