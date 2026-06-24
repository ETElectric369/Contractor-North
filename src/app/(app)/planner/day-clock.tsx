"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { clockIn, clockOut } from "../timeclock/actions";
import { ClockStartPicker } from "../timeclock/clock-start-picker";

interface JobOpt {
  id: string;
  label: string;
}

/** Live time clock on My Day: ticks while on the clock, one tap to start/stop —
 *  so a contractor can clock into the current job without leaving the page. */
export function DayClock({
  open,
  closedHoursToday,
  closedHoursWeek,
  currentJobId,
  jobs,
  isStaff = true,
}: {
  open: { id: string; clock_in: string; jobLabel: string | null } | null;
  closedHoursToday: number;
  closedHoursWeek: number;
  currentJobId: string;
  jobs: JobOpt[];
  isStaff?: boolean;
}) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(currentJobId);
  const [startAt, setStartAt] = useState(""); // "" = now; otherwise a chosen ISO
  const [err, setErr] = useState<string | null>(null);

  // Tick once a second only while on the clock.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const liveMs = open ? Math.max(0, now - new Date(open.clock_in).getTime()) : 0;
  const totalMs = closedHoursToday * 3_600_000 + liveMs;
  // The open entry started today, so its live time is also part of this week.
  const totalWeekMs = closedHoursWeek * 3_600_000 + liveMs;

  const fmtHm = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  };
  const fmtHms = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr(null);
    setBusy(true);
    fn()
      .then((res) => {
        if (!res.ok) setErr(res.error ?? "Something went wrong.");
        else router.refresh();
      })
      .finally(() => setBusy(false));
  }

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-4">
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
              <div className="text-xl font-bold tabular-nums text-slate-900">{fmtHms(liveMs)}</div>
              <div className="truncate text-xs text-slate-500">
                On the clock{open.jobLabel ? ` · ${open.jobLabel}` : ""} · {fmtHm(totalMs)} today · {fmtHm(totalWeekMs)} week
              </div>
            </>
          ) : (
            <>
              {/* Two stat units that never break apart: each "value + label" is
                  nowrap, so on a narrow phone they stack cleanly (0h 00m today /
                  19h 40m this week) instead of orphaning "this week". */}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="whitespace-nowrap">
                  <span className="text-xl font-bold text-slate-900">{fmtHm(totalMs)}</span>
                  <span className="ml-1.5 text-xs font-normal text-slate-400">today</span>
                </span>
                <span className="whitespace-nowrap">
                  <span className="text-base font-semibold text-slate-600">{fmtHm(totalWeekMs)}</span>
                  <span className="ml-1.5 text-xs font-normal text-slate-400">this week</span>
                </span>
              </div>
              {jobs.length > 0 && (
                <Select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  className="mt-1 h-8 max-w-[230px] text-xs"
                  aria-label="Job to clock into"
                >
                  <option value="">No job</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>{j.label}</option>
                  ))}
                </Select>
              )}
              <div className="mt-1.5">
                <ClockStartPicker onChange={(iso) => setStartAt(iso ?? "")} staff={isStaff} />
              </div>
            </>
          )}
          {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
        </div>
        {open ? (
          isStaff ? (
            <Button
              variant="outline"
              onClick={() => run(() => clockOut({ entry_id: open.id, lunch_minutes: 0, notes: "", gps: null }))}
              disabled={busy}
              className="shrink-0 text-red-600"
            >
              <Square className="h-4 w-4" /> Clock out
            </Button>
          ) : (
            // Field crew clock out on the full timeclock so they answer the codes+hours
            // question (this quick widget can't capture the breakdown).
            <Button variant="outline" onClick={() => router.push("/timeclock")} className="shrink-0 text-red-600">
              <Square className="h-4 w-4" /> Clock out
            </Button>
          )
        ) : (
          <Button
            onClick={() => run(() => clockIn({ job_id: jobId || null, job_code: null, gps: null, clock_in_at: startAt || null }))}
            disabled={busy}
            className="shrink-0"
          >
            <Play className="h-4 w-4" /> Clock in
          </Button>
        )}
      </div>
    </Card>
  );
}
