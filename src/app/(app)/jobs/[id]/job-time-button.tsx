"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play, ArrowLeftRight, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { todayStrInTz } from "@/lib/tz";
import { getPosition } from "@/lib/geo";
import { clockIn, switchJob, clockOutCurrent, createManualEntry } from "../../timeclock/actions";
import { ClockStartPicker } from "../../timeclock/clock-start-picker";
import type { GeoPoint } from "@/lib/types";

/** The viewer's open time entry, fetched server-side by the job page (one cheap
 *  query in its Promise.all). allocatedHours = the sum of the entry's recorded
 *  switch segments, so State B can honestly name the OUTGOING segment's hours. */
export interface OpenEntry {
  id: string;
  clock_in: string;
  job_id: string | null;
  jobLabel: string | null;
  allocatedHours: number;
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
 *      outgoing job AND its hours (switchJob records that segment first)
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

  // C: total shift from raw clock_in. B: the OUTGOING segment = clock_in + the
  // hours already recorded by earlier switches → now (switchJob's own math), so
  // the confirm can honestly say what a switch will record.
  const elapsedMs = openEntry ? Math.max(0, now - new Date(openEntry.clock_in).getTime()) : 0;
  const segmentHours = openEntry
    ? Math.max(
        0,
        Math.round(((Date.now() - (new Date(openEntry.clock_in).getTime() + openEntry.allocatedHours * 3_600_000)) / 3_600_000) * 100) / 100,
      )
    : 0;

  function openModal() {
    setErr(null);
    setStartAt("");
    setOpen(true);
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setErr(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setErr(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      if (after) after();
      else router.refresh();
    });
  }

  const doClockIn = () =>
    run(async () => {
      const gps = await gpsBestEffort();
      return clockIn({ job_id: jobId, job_code: null, gps, clock_in_at: startAt || null });
    });

  const doSwitch = () =>
    run(() => switchJob({ entry_id: openEntry!.id, job_id: jobId, job_code: null }));

  const doClockOut = () => run(() => clockOutCurrent({}));

  const doLogHours = () =>
    run(() =>
      createManualEntry({
        profile_id: profileId,
        work_date: workDate,
        hours,
        job_id: jobId,
        job_code: null,
        lunch_minutes: 0,
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
        Log {hours > 0 ? `${hours}h` : "hours"} on this job
      </Button>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className={triggerCls}
        aria-label={
          state === "in"
            ? "Clock in to this job"
            : state === "switch"
              ? "Switch your open shift to this job"
              : `On the clock here for ${fmtHm(elapsedMs)}`
        }
        title="Time"
      >
        {state === "here" ? <Clock className="h-4 w-4" /> : state === "switch" ? <ArrowLeftRight className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        {state === "in" && "Clock in"}
        {state === "switch" && (
          <>
            Switch<span className="hidden sm:inline">&nbsp;here</span>
          </>
        )}
        {state === "here" && (
          <>
            <span className="hidden sm:inline">On clock ·&nbsp;</span>
            <span className="tabular-nums">{fmtHm(elapsedMs)}</span>
          </>
        )}
      </button>

      <Modal
        open={open}
        onClose={() => !pending && setOpen(false)}
        title={state === "in" ? "Clock in" : state === "switch" ? "Switch to this job" : "On the clock"}
        size="md"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={
              state === "in"
                ? doClockIn
                : state === "switch"
                  ? doSwitch
                  : isStaff
                    ? doClockOut
                    : () => router.push("/timeclock")
            }
            saving={pending}
            saveLabel={
              state === "in"
                ? "Clock me in"
                : state === "switch"
                  ? "Switch to this job"
                  : isStaff
                    ? "Clock me out"
                    : "Clock out on the Timeclock"
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
              <ClockStartPicker onChange={(iso) => setStartAt(iso ?? "")} staff={isStaff} />
              {logHoursSection}
            </>
          )}

          {state === "switch" && openEntry && (
            <p className="text-sm text-slate-600">
              You&apos;re on the clock at <span className="font-medium">{openEntry.jobLabel ?? "another job"}</span> since {fmtTime(openEntry.clock_in)}.
              Switching records the <span className="font-medium">{segmentHours}h</span> worked there so far, then puts the rest of your shift on {jobNumber}.
            </p>
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
