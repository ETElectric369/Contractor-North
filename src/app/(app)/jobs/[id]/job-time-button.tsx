"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, ArrowLeftRight, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { todayStrInTz } from "@/lib/tz";
import { LONG_SHIFT_PHRASE, isLongOpenShift } from "@/lib/long-shift";
import { getPosition } from "@/lib/geo";
import { clockIn, switchJob, clockOutCurrent, createManualEntry } from "../../timeclock/actions";
import { ClockStartPicker } from "../../timeclock/clock-start-picker";
import type { GeoPoint } from "@/lib/types";
import { useToast } from "@/components/toast";

/** The viewer's open time entry, fetched server-side by the job page (one cheap
 *  query in its Promise.all). A Switch Job closes the running entry and opens the next piece
 *  (0288), so clock_in is where the running part started and State B names now - clock_in. */
export interface OpenEntry {
  id: string;
  clock_in: string;
  /** When the SHIFT began (lib/shift-chain): the first part's clock-in after a Switch Job. */
  shift_start?: string | null;
  job_id: string | null;
  /** A time code with no job (Drive, Shop) is still a part of the day: switch_job cuts it. */
  job_code?: string | null;
  jobLabel: string | null;
}

/** Best-effort on-gesture GPS: the tap that clocks in IS the user gesture (the
 *  documented iOS-PWA rule), so the geofence monitor can arm. Any failure —
 *  denied, timeout, no hardware — silently falls back to null; clock-in never
 *  waits more than a few seconds and never blocks on location. */
async function gpsBestEffort(): Promise<GeoPoint | null> {
  try {
    const r = await getPosition({ timeout: 4_000 });
    return r.status === "ok" ? { lat: r.coords.lat, lng: r.coords.lng, accuracy: r.accuracy } : null;
  } catch {
    return null;
  }
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const fmtHm = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

/**
 * TIME — the action dock's one filled button (the "Add cost" solidarity model
 * applied to time). Three states, all SELF-scoped (it clocks the VIEWER, never a
 * crew member — crew time goes through the staff-only "log hours" section):
 *   A  not on the clock            → "Clock in"  → confirm modal, stays ON the job
 *   B  on the clock at ANOTHER job → "Switch"    → explicit confirm naming the
 *      outgoing job AND its hours (switch_job closes that entry and opens the next one)
 *   C  on the clock at THIS job    → green, ticking → staff one-tap clock-out;
 *      field crew route to /timeclock (the codes+hours rule, same as My Day)
 */
export function JobTimeButton({
  jobId,
  jobNumber,
  isStaff,
  tz,
  openEntry,
  techs,
  defaultProfileId,
}: {
  jobId: string;
  jobNumber: string;
  isStaff: boolean;
  tz: string;
  openEntry: OpenEntry | null;
  techs: { id: string; full_name: string | null }[];
  defaultProfileId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [startAt, setStartAt] = useState(""); // "" = now; otherwise a chosen ISO
  const [now, setNow] = useState(() => Date.now());

  // Staff "or log hours" section (duration shape — "6 hours Tuesday", any crew member).
  const [workDate, setWorkDate] = useState(() => todayStrInTz(tz));
  const [hours, setHours] = useState(0);
  const [profileId, setProfileId] = useState(defaultProfileId);

  const state: "in" | "switch" | "here" = !openEntry ? "in" : openEntry.job_id === jobId ? "here" : "switch";

  // Tick once a second only while on the clock HERE (the DayClock pattern).
  useEffect(() => {
    if (state !== "here") return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state, openEntry?.id]);

  // C: the running entry from its clock_in. B: the same figure, because a switch closes the running
  // entry right now and opens a new one here (0288 switch_job), so the confirm can honestly say what
  // the closed part will read.
  const elapsedMs = openEntry ? Math.max(0, now - new Date(openEntry.clock_in).getTime()) : 0;
  const segmentHours = openEntry
    ? Math.max(0, Math.round(((Date.now() - new Date(openEntry.clock_in).getTime()) / 3_600_000) * 100) / 100)
    : 0;

  function openModal() {
    setErr(null);
    setStartAt("");
    setOpen(true);
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string; warning?: string }>, after?: () => void) {
    setErr(null);
    start(async () => {
      // THE 60MPH LAW (v800 audit). A server action that REJECTS — no signal in a dead zone, a
      // dropped connection mid-tap — throws, and an unhandled throw inside a transition tears
      // the whole job page down to the error boundary. A tech standing in a Chilcoot canyon
      // taps "Clock in", the page vanishes, and the start of his day is gone. The failure has
      // to land in this little red line instead, with the punch still there to retry.
      let res: { ok: boolean; error?: string; warning?: string };
      try {
        res = await fn();
      } catch {
        setErr("No connection — that didn't go through. Try again when you have a bar or two.");
        return;
      }
      if (!res?.ok) {
        setErr(res?.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      // A pay rate left on the part before a switch, or a lunch that moved: money, so it is said and
      // kept on screen until read (the Timeclock panel says the same thing the same way).
      if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
      if (after) after();
      else router.refresh();
    });
  }

  const doClockIn = () =>
    run(async () => {
      const gps = await gpsBestEffort();
      return clockIn({ job_id: jobId, job_code: null, gps, clock_in_at: startAt || null });
    });

  // The tap IS the user gesture, so grab a fix and hand it to switchJob as the entry's
  // NEW geofence anchor. Without one the server clears the anchor (it must never keep
  // the OLD site's centre — that's what auto-closed shifts at the moment the tech drove
  // away from the first job) and the monitor re-adopts at the new site.
  const doSwitch = () =>
    run(async () => {
      const gps = await gpsBestEffort();
      return switchJob({ entry_id: openEntry!.id, job_id: jobId, job_code: null, gps });
    });

  const doClockOut = () => run(() => clockOutCurrent({}));
  /** The running clock has gone LONG_SHIFT_HOURS: the out door goes to Timeclock's stop picker. So
   *  does a Switch that would CUT it (a running entry with a job or a code): 0288 closes the old
   *  part at now, the same one-tap mistake, and switchJob refuses it. A re-point closes nothing. */
  const longRunning = !!openEntry && isLongOpenShift(new Date(openEntry.shift_start ?? openEntry.clock_in).getTime(), now);
  const longShift =
    longRunning && (state === "here" || (state === "switch" && (!!openEntry?.job_id || !!openEntry?.job_code)));

  const doLogHours = () =>
    run(() =>
      createManualEntry({
        profile_id: profileId,
        work_date: workDate,
        hours,
        job_id: jobId,
        job_code: null,
        // lunch omitted → the server's auto rule decides, same as every other entry door
        notes: "",
      }),
    );

  const triggerCls =
    "btn-gloss inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors sm:px-3.5 " +
    (state === "in"
      ? "bg-[rgb(var(--glass-ink))] text-white shadow-sm hover:bg-[rgb(var(--glass-ink))]/90"
      : state === "switch"
        ? "border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
        : "border border-green-300 bg-green-50 text-green-700 hover:bg-green-100");

  // Staff-only "or log hours" block — shown in states A and C (never mid-switch).
  const logHoursSection = isStaff && (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Or log hours</div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="jt-date">Date</Label>
          <Input id="jt-date" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="jt-hours">Hours</Label>
          <NumberInput id="jt-hours" value={hours} onValueChange={setHours} placeholder="0" />
        </div>
      </div>
      {techs.length > 1 && (
        <div>
          <Label htmlFor="jt-who">Who</Label>
          <Select id="jt-who" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {techs.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name ?? "Unnamed"}
              </option>
            ))}
          </Select>
        </div>
      )}
      <Button type="button" variant="outline" size="sm" onClick={doLogHours} disabled={pending || hours <= 0}>
        Log {hours > 0 ? `${hours}h` : "hours"} on This Job
      </Button>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className={triggerCls}
        // elapsedMs is a Date.now()-based live ticker, so its server/client first render
        // differs → React #418. suppressHydrationWarning covers the aria-label here + the
        // ticker text span below; the value self-corrects on the tick.
        suppressHydrationWarning
        aria-label={
          state === "in"
            ? "Clock in to this job"
            : state === "switch"
              ? "Switch your open shift to this job"
              : `On the clock here for ${fmtHm(elapsedMs)}`
        }
        title="Time"
      >
        {state === "here" ? <Clock className="h-4 w-4 shrink-0" /> : state === "switch" ? <ArrowLeftRight className="h-4 w-4 shrink-0" /> : <Play className="h-4 w-4 shrink-0" />}
        {state === "in" && "Clock In"}
        {state === "switch" && (
          <>
            Switch<span className="hidden sm:inline">&nbsp;here</span>
          </>
        )}
        {state === "here" && (
          <>
            <span className="hidden sm:inline">On clock ·&nbsp;</span>
            <span className="tabular-nums" suppressHydrationWarning>{fmtHm(elapsedMs)}</span>
          </>
        )}
      </button>

      {/* portal: this button lives INSIDE the dock's `glass glass-menu` bar, whose
          backdrop-filter makes the bar the containing block for an in-place fixed
          overlay — the modal gets trapped/crushed inside the 56px bar on fine-pointer
          browsers (the cn-v463 physics; Chris's "shuts the window"). Same rule the
          Manage-menu children (Edit/Propose/Finish) already follow. No <form> wraps
          this Modal, so portaling is safe (footer uses onSave callbacks). */}
      <Modal
        open={open}
        onClose={() => !pending && setOpen(false)}
        title={state === "in" ? "Clock in" : state === "switch" ? "Switch to this job" : "On the clock"}
        size="md"
        portal
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={
              state === "in"
                ? doClockIn
                : longShift
                  ? () => router.push("/timeclock")
                  : state === "switch"
                    ? doSwitch
                    : isStaff
                      ? doClockOut
                      : () => router.push("/timeclock")
            }
            saving={pending}
            saveLabel={
              state === "in"
                ? "Clock Me In"
                : longShift
                  ? // Probably forgotten (lib/long-shift): Timeclock asks when he stopped. A close
                    // (or a switch's cut) at now would write the night onto payroll, and the server
                    // refuses it anyway.
                    "Set When You Stopped"
                  : state === "switch"
                    ? "Switch to This Job"
                    : isStaff
                      ? "Clock Me Out"
                      : "Clock Out on the Timeclock"
            }
          />
        }
      >
        <div className="space-y-4">
          {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

          {state === "in" && (
            <>
              <p className="text-sm text-slate-600">
                Clock <span className="font-medium">yourself</span> in to {jobNumber} — you stay right here on the job.
              </p>
              <ClockStartPicker onChange={(iso) => setStartAt(iso ?? "")} staff={isStaff} tz={tz} />
              {logHoursSection}
            </>
          )}

          {state === "switch" && openEntry && (
            // The same fork switch_job makes (0288): a punch with no job and no code is moved over
            // whole; anything else is cut here and a new entry starts on this job.
            !openEntry.job_id && !openEntry.job_code ? (
              <p className="text-sm text-slate-600">
                You&apos;re on the clock with no job yet, since {fmtTime(openEntry.clock_in)}. Switching puts this whole shift on{" "}
                <span className="font-medium">{jobNumber}</span>, from the start.
              </p>
            ) : longShift ? (
              <p className="text-sm text-amber-800">
                You&apos;re still on the clock at <span className="font-medium">{openEntry.jobLabel ?? openEntry.job_code ?? "another job"}</span> since{" "}
                {new Date(openEntry.clock_in).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}, {LONG_SHIFT_PHRASE}. Set when you stopped on the Timeclock first, then clock in here.
              </p>
            ) : (
              <p className="text-sm text-slate-600">
                You&apos;re on the clock at <span className="font-medium">{openEntry.jobLabel ?? openEntry.job_code ?? "another job"}</span> since {fmtTime(openEntry.clock_in)}.
                Switching closes that entry at <span className="font-medium">{segmentHours}h</span> and starts a new one on {jobNumber} right now.
              </p>
            )
          )}

          {state === "here" && openEntry && (
            <>
              <p className="text-sm text-slate-600">
                You&apos;ve been on the clock here since {fmtTime(openEntry.clock_in)} —{" "}
                <span className="font-medium tabular-nums">{fmtHm(elapsedMs)}</span> so far.
                {!isStaff && " Clocking out asks for your job codes and hours — that happens on the Timeclock."}
              </p>
              {logHoursSection}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
