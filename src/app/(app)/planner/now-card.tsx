"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { Play, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPosition } from "@/lib/geo";
import type { GeoPoint } from "@/lib/types";
import { enqueue, listPending, remove as removeQueued } from "@/lib/offline/queue";
import { clockIn, clockOut } from "../timeclock/actions";
import { lunchMinutesFor, LUNCH_LABEL } from "@/lib/lunch-rule";
import { isLongOpenShift } from "@/lib/long-shift";
import { useToast } from "@/components/toast";
import { WhichJobSheet } from "./which-job";
import { askAfterPunch, type WhichJobAsk } from "../timeclock/which-job-choices";

/** Best-effort on-gesture GPS with a short cap (the timeclock panel's race pattern):
 *  the punch never waits out the full 8s highAccuracy fix — if the fix lands inside
 *  the window it's stamped, otherwise we punch now without it. The tap that punches
 *  IS the user gesture (THE iOS rule in geo.ts), so no awaits ahead of this call. */
async function getGps(capMs: number): Promise<GeoPoint | null> {
  const fix = getPosition({ enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }).then((r) =>
    r.status === "ok" ? { lat: r.coords.lat, lng: r.coords.lng, accuracy: r.accuracy } : null,
  );
  return Promise.race([fix, new Promise<GeoPoint | null>((res) => setTimeout(() => res(null), capMs))]);
}

const OFFLINE_MSG = "No connection — try again when you have bars.";

/** The job on the punch, as the card shows it: its name, customer · address, and where it opens.
 *  Nothing priced ever crosses into this client component (a tech's phone reads it too). */
export interface NowJob {
  name: string;
  /** "Nora Smith · 85 Whitney", or null when the job has neither. */
  sub: string | null;
  href: string;
}

/** The open punch, when there is one. */
export interface NowPunch {
  id: string;
  clock_in: string;
  notes: string | null;
  /** When the SHIFT began (lib/shift-chain), the first part's clock-in after a Switch Job. The
   *  long-shift door counts twelve hours from it (audit v994 SW1). */
  shift_start?: string | null;
  /** The punch carries a job. False: the clock couldn't tell the job, so the card asks. */
  onJob: boolean;
}

const TIMECLOCK_LINK = "inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline";

/**
 * THE NOW CARD, at the top of My Day for every role: where you are, the clock you're on, and the
 * doors for the job, in one card. It took the place of three things that said parts of the same fact
 * (the clock card, the Today card's Now block and the Which Job block), so nothing is lost:
 *
 *   · on the clock with a job: "Now" and the live timer, the job's name (the one link to the job),
 *     customer · address, then the job's doors and its tasks (`children`, rendered on the server:
 *     Navigate, Materials, Add Cost for the office, NowTasks), then the footer: the one opt-in lunch
 *     box, the Timeclock link and Clock Out;
 *   · on the clock on no job: the timer, "Which job are you on?" and ONE Pick The Job button, which
 *     opens the clock's own "Which Job Are You On?" sheet (the same list, the same write);
 *   · off the clock: Not Clocked In, a big Clock In (a job-less punch: the server resolves today's
 *     job; the queue-first offline path holds the press time) and the Timeclock link.
 *
 * A clock running LONG_SHIFT_HOURS was probably forgotten: Clock Out becomes Set When You Stopped
 * (Timeclock asks when he stopped), never beside it. A mid-shift switch is its own entry already
 * (0288), so a clock-out closes only the part still running, and the entry's note rides through.
 * Timeclock carries anything more: Switch Job and Split live there.
 */
export function NowCard({
  open,
  job,
  userId,
  children,
}: {
  open: NowPunch | null;
  /** The job on the open punch, when the page could read it. */
  job: NowJob | null;
  /** WHO is signed in. A queued punch is stamped with this and only ever replays for the same
   *  person — a shared shop phone must never file one tech's hours onto another's timecard. */
  userId: string | null;
  /** The job's doors and tasks, rendered on the server (so NavLink, QuickCostButton and NowTasks
   *  keep their server props). Drawn only on the clock with a job. */
  children?: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  // Unpaid lunch — off by default; nothing is deducted unless the tech ticks it.
  const [tookLunch, setTookLunch] = useState(false);
  const [held, setHeld] = useState(false);
  const [pending, start] = useTransition();
  // "Which Job Are You On?" — after a punch the clock couldn't put on a job (askAfterPunch), or from
  // the card's Pick The Job. Lives here, above the open/closed branches, so the card flipping to
  // "on the clock" (or back) underneath doesn't take the question with it.
  const [ask, setAsk] = useState<WhichJobAsk | null>(null);

  // Replay a held punch the moment the connection returns (or the app is reopened).
  // THE DRAIN MOVED TO THE SHELL (audit 9, OfflineDrain): mounted here it only ran while this
  // card was on screen, so "it'll file itself when you have signal" was a promise that expired
  // the moment the tech navigated away. This card keeps its own banner for the punch it just
  // took; the shell owns replay, the pending count, and the quarantine notice.
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const ops = await listPending();
      if (alive) setHeld(ops.some((o) => !o.blocked));
    };
    void sync();
    const t = setInterval(sync, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [userId]);

  // Tick once a second only while on the clock.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const liveMs = open ? Math.max(0, now - new Date(open.clock_in).getTime()) : 0;
  const fmtHms = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const longShift = !!open && isLongOpenShift(new Date(open.shift_start ?? open.clock_in).getTime(), now);

  /**
   * CLOCK-IN SURVIVES A DEAD ZONE (0167/0168).
   *
   * A punch is queued to the device BEFORE the network is tried, carrying the moment the button
   * was pressed. When the phone reconnects, the shift is filed at 7:02 — not at whatever time the
   * signal came back. Without this, arriving at a Chilcoot site with no bars simply lost the
   * morning, and the old copy here said so out loud: "try again when you have bars."
   *
   * Clock-OUT is deliberately still online-only, and the asymmetry is the point: a failed clock-out
   * leaves the shift OPEN, which the auto-clock-out and the office reconcile already catch. A
   * failed clock-IN loses the start of the day with nothing to catch it. Queuing clock-out too
   * needs a local open-shift model (there's no entry id to reference until the clock-in syncs) —
   * that's a real feature, not a line of code, so it isn't smuggled in here.
   */
  function doClockIn() {
    setErr(null);
    start(async () => {
      const gps = await getGps(2500);
      // The instant they TAPPED. Everything downstream treats this as the truth of when work
      // started; the server bounds and labels it (resolveOfflinePunchTime).
      const pressedAt = new Date().toISOString();
      // Job-less on purpose — clockIn resolves it server-side (today's assignment →
      // the org's only in-progress job → none; the office attaches it later).
      // The QUEUED copy carries the press time (it may be filed hours from now). The LIVE attempt
      // does NOT — the server's own clock is the authority when there's a connection, and sending
      // a device timestamp on an online punch is what turned "keep my real time" into "roll the
      // phone back 13 hours and tap Clock In" (0169). A device clock is only ever a fallback for
      // a punch that genuinely couldn't be delivered.
      const queued = { job_id: null, job_code: null, gps, offline_pressed_at: pressedAt };
      // `persisted` is whether the phone actually holds it — the banner below may only promise
      // what is true (audit 9). The op (and its idempotency key) comes back either way, so the
      // live attempt still de-dupes a double tap.
      const { op, persisted } = await enqueue("time.clockIn", queued, "Clock in", userId);
      try {
        const res = await clockIn({ job_id: null, job_code: null, gps, clock_in_at: null, clientOpId: op.clientOpId });
        if (persisted) await removeQueued(op.clientOpId);
        if (!res.ok) setErr(res.error ?? "Could not clock in.");
        else {
          setHeld(false);
          // Anything the punch did on the way in (a job it took off hold, say) is said, and kept
          // until it is read, as the Timeclock panel does.
          if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
          setAsk(askAfterPunch(res, "in"));
        }
      } catch {
        // Network only. The punch is on the phone with its real time — say that instead of
        // telling someone standing in a dead zone to try again when they have bars. But if the
        // phone REFUSED to hold it, there is nothing to file later and saying so is the whole job.
        if (persisted) setHeld(true);
        else setErr(OFFLINE_MSG);
      }
    });
  }

  function doClockOut() {
    if (!open) return;
    setErr(null);
    start(async () => {
      const gps = await getGps(3000);
      try {
        const res = await clockOut({
          entry_id: open.id,
          lunch_minutes: lunchMinutesFor(tookLunch), // stated every time; 0 is the default
          notes: open.notes ?? "", // round-trip the mid-shift note, never wipe it
          gps,
        });
        if (!res.ok) setErr(res.error ?? "Could not clock out.");
        else {
          // Where the lunch landed after a Switch Job (the part before it, when it didn't fit this
          // one) is said here too, and kept until it is read, as the Timeclock panel does.
          if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
          // Still on no job at the end of it: asked once more (Skip is right there).
          setAsk(askAfterPunch(res, "out"));
        }
      } catch {
        setErr(OFFLINE_MSG);
      }
    });
  }

  // The error line and the held line keep their exact words: the held line is the promise the
  // shell's offline drain keeps ("it'll file itself when you have signal").
  const lines = (
    <>
      {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
      {/* Not an error. The punch is saved on the phone WITH the time it was made — a tech who
          knows that carries on working instead of standing around retrying. */}
      {held && !err && (
        <div className="mt-1 text-xs text-sky-600">
          Clocked in — saved on your phone at the right time, and it&rsquo;ll file itself when you have signal.
        </div>
      )}
    </>
  );

  return (
    <Card className="mb-4 overflow-hidden">
      {open ? (
        <>
          <div className="bg-brand-light/30 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Now</span>
              {/* Live ticker derives from Date.now(), so the server's first render and the
                  client's can't match → React #418 unless suppressed; the value self-corrects
                  on the 1s tick (the cn-v405/DayClock idiom). */}
              <span className="text-xl font-bold tabular-nums text-slate-900" suppressHydrationWarning>
                {fmtHms(liveMs)}
              </span>
            </div>
            {job ? (
              <>
                {/* The ONE link to the job: its name. 44px to the thumb (py-2), the same line height
                    to the eye (the negative margins give the padding back). */}
                <Link href={job.href} className="-mb-2 -mt-1.5 block py-2 text-lg font-bold text-slate-900 hover:text-brand">
                  {job.name}
                </Link>
                {job.sub && <div className="text-sm text-slate-500">{job.sub}</div>}
                {children}
              </>
            ) : open.onJob ? (
              /* The punch is on a job this page couldn't read (a lost read, a job the list can't
                 see). Said, not skipped: the doors are one tap away on Timeclock. */
              <p className="mt-1 text-sm text-slate-600">
                Your punch is on a job this page couldn&rsquo;t load just now. Timeclock shows it.
              </p>
            ) : (
              /* On the clock with no job on the punch: ask, don't vanish. One door, the clock's own
                 sheet, with the same list the clock asked from (the job he punched last, today's
                 schedule, the jobs in progress). One pick puts the whole punch on the job, and the
                 job's doors take this question's place on the refresh. */
              <>
                <div className="mt-0.5 text-lg font-bold text-slate-900">Which job are you on?</div>
                <p className="text-sm text-slate-500">You&rsquo;re on the clock, but this punch has no job yet.</p>
                <Button type="button" className="mt-3" onClick={() => setAsk({ entryId: open.id, moment: "in" })}>
                  Pick The Job
                </Button>
              </>
            )}
          </div>
          {/* WRAP, don't cover: the left side never shrinks under its words (min width), so a wide
              button (Set When You Stopped, or Clock Out on a 320px phone) takes its own line on the
              right instead of sitting over the Timeclock link. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-brand/20 px-5 py-2">
            <div className="flex min-w-[8.5rem] flex-1 flex-wrap items-center gap-x-4">
              {/* The one lunch question, off by default. This card is where most days end, so it
                  is answerable here and not only on /timeclock. A forgotten clock closes on
                  Timeclock, which asks it there with the stop time, so it isn't offered twice. */}
              {!longShift && (
                <label htmlFor="md-lunch" className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-slate-600">
                  <input
                    id="md-lunch"
                    type="checkbox"
                    checked={tookLunch}
                    onChange={(e) => setTookLunch(e.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand"
                  />
                  {LUNCH_LABEL}
                </label>
              )}
              <Link href="/timeclock" className={TIMECLOCK_LINK}>
                Timeclock
              </Link>
            </div>
            {longShift ? (
              /* A clock running LONG_SHIFT_HOURS (twelve) or more was probably forgotten: the one-tap
                 close at now would write the night onto payroll. Timeclock asks when he stopped
                 (lib/long-shift); the server refuses a now-close past the line anyway, so this is
                 the door, not the guard. It REPLACES Clock Out, never sits beside it. */
              <Link
                href="/timeclock"
                className="ml-auto inline-flex h-12 shrink-0 items-center gap-2 rounded-lg bg-red-600 px-5 text-base font-medium text-white hover:bg-red-700"
              >
                <Square className="h-5 w-5" /> Set When You Stopped
              </Link>
            ) : (
              <Button variant="destructive" size="lg" onClick={doClockOut} disabled={pending} className="ml-auto shrink-0">
                {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Square className="h-5 w-5" />} Clock Out
              </Button>
            )}
          </div>
          {(err || held) && <div className="px-5 pb-3">{lines}</div>}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-900">Not Clocked In</div>
            <Link href="/timeclock" className={TIMECLOCK_LINK}>
              Timeclock
            </Link>
            {lines}
          </div>
          <Button size="lg" onClick={doClockIn} disabled={pending} className="ml-auto shrink-0">
            {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />} Clock In
          </Button>
        </div>
      )}
      {ask && <WhichJobSheet key={ask.entryId + ask.moment} entryId={ask.entryId} moment={ask.moment} onClose={() => setAsk(null)} />}
    </Card>
  );
}
