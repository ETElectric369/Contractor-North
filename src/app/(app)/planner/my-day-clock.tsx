"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Clock, Play, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPosition } from "@/lib/geo";
import type { GeoPoint } from "@/lib/types";
import { clockIn, clockOut } from "../timeclock/actions";

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

/**
 * The MINIMAL My Day clock (Erik, cn-v502 — the old DayClock's stats/pickers stay
 * gone): clocked out → one big "Clock In" (a job-less punch; the server resolves
 * today's job for every role now); clocked in → the ticking timer + job label + a
 * one-tap "Clock Out". lunch_minutes:null lets the server's >5h ⇒ 30 min auto-lunch
 * decide, allocations stay omitted so recorded mid-shift switch segments survive,
 * and the entry's own note rides through untouched. No week/today hour stats, no
 * pickers, no questionnaire — the "Timeclock →" link carries anything more.
 */
export function MyDayClock({
  open,
  jobLabel,
  className = "mb-4",
}: {
  open: { id: string; clock_in: string; notes: string | null } | null;
  jobLabel: string | null;
  /** Layout hook: the staff top row grids the clock beside the leads card
   *  (pass "h-full"); the default keeps the tech full-width spacing. */
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

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

  function doClockIn() {
    setErr(null);
    start(async () => {
      const gps = await getGps(2500);
      try {
        // Job-less on purpose — clockIn resolves it server-side (today's assignment →
        // the org's only in-progress job → none; the office attaches it later).
        const res = await clockIn({ job_id: null, job_code: null, gps, clock_in_at: null });
        if (!res.ok) setErr(res.error ?? "Could not clock in.");
      } catch {
        setErr(OFFLINE_MSG);
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
          lunch_minutes: null, // "wasn't asked" → the server's auto-lunch decides
          notes: open.notes ?? "", // round-trip the mid-shift note, never wipe it
          gps,
        });
        if (!res.ok) setErr(res.error ?? "Could not clock out.");
      } catch {
        setErr(OFFLINE_MSG);
      }
    });
  }

  return (
    <Card className={`overflow-hidden ${className}`}>
      {/* flex-wrap + ml-auto on the button: in a squeezed column (narrow desktop window,
          the side-by-side top row) the fixed-size button drops to its own line instead of
          overlapping the label. Wide layouts render identically (no wrap triggers). */}
      <div className="flex h-full flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
            open ? "bg-green-100 text-green-600" : "bg-slate-100 text-slate-400"
          }`}
        >
          <Clock className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          {open ? (
            <>
              {/* Live ticker derives from Date.now(), so the server's first render and the
                  client's can't match → React #418 unless suppressed; the value self-corrects
                  on the 1s tick (the cn-v405/DayClock idiom). */}
              <div className="text-xl font-bold tabular-nums text-slate-900" suppressHydrationWarning>
                {fmtHms(liveMs)}
              </div>
              <div className="truncate text-xs text-slate-500">
                On the clock{jobLabel ? ` · ${jobLabel}` : ""} ·{" "}
                <Link href="/timeclock" className="font-medium text-brand hover:underline">
                  Timeclock →
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold text-slate-900">Not clocked in</div>
              <Link href="/timeclock" className="text-xs font-medium text-brand hover:underline">
                Timeclock →
              </Link>
            </>
          )}
          {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
        </div>
        {open ? (
          <Button variant="destructive" size="lg" onClick={doClockOut} disabled={pending} className="ml-auto shrink-0">
            {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Square className="h-5 w-5" />} Clock Out
          </Button>
        ) : (
          <Button size="lg" onClick={doClockIn} disabled={pending} className="ml-auto shrink-0">
            {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />} Clock In
          </Button>
        )}
      </div>
    </Card>
  );
}
