"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import { Input } from "@/components/ui/input";

function nowParts() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/**
 * The one start-time control for clocking in. Collapsed it's a quiet "Starting
 * now · pick a time" link so the common one-tap path stays clean; expanded it's
 * a free date + time so the start can be ANY time the user chooses (e.g. forgot
 * to clock in). Emits an ISO string, or null when left at "now". Used by every
 * clock-in surface (Timeclock panel, My Day, the job Time tab) so backdating
 * works identically everywhere.
 */
export function ClockStartPicker({
  onChange,
  className = "",
  staff = true,
  startExpanded = false,
  caption,
}: {
  onChange: (iso: string | null) => void;
  className?: string;
  /** Staff get the free date/time picker (backdate corrections). A tech/field
   *  employee can ONLY round the live start back to the nearest half hour. */
  staff?: boolean;
  /** Open straight into the date+time inputs (e.g. the geofence "pick when you
   *  left" sheet, where the whole point is choosing a time). */
  startExpanded?: boolean;
  /** Replaces the default "starting the shift…" helper line when the picker is
   *  reused outside the clock-in context (e.g. picking a clock-OUT time). */
  caption?: string;
}) {
  const [custom, setCustom] = useState(startExpanded);
  const [rounded, setRounded] = useState(false);
  const init = nowParts();
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);

  // Employee path: no free picker — just toggle the start between "now" and the
  // nearest half-hour BEFORE now. (The server clamps it the same way regardless.)
  if (!staff) {
    const now = Date.now();
    const floor = new Date(now - (now % 1_800_000));
    const p = (n: number) => String(n).padStart(2, "0");
    const lbl = `${p(floor.getHours())}:${p(floor.getMinutes())}`;
    const onBoundary = now - floor.getTime() < 60_000;
    return (
      <button
        type="button"
        onClick={() => {
          const t = Date.now();
          const next = !rounded;
          setRounded(next);
          onChange(next ? new Date(t - (t % 1_800_000)).toISOString() : null);
        }}
        className={`inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-brand ${className}`}
      >
        <Clock className="h-3.5 w-3.5" />
        {rounded ? `Rounded to ${lbl} · tap for now` : onBoundary ? "Starting now" : `Starting now · round back to ${lbl}`}
      </button>
    );
  }

  function emit(d: string, t: string) {
    const iso = new Date(`${d}T${t}:00`);
    onChange(isNaN(iso.getTime()) ? null : iso.toISOString());
  }

  if (!custom) {
    return (
      <button
        type="button"
        onClick={() => {
          const n = nowParts();
          setDate(n.date);
          setTime(n.time);
          setCustom(true);
          emit(n.date, n.time);
        }}
        className={`inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-brand ${className}`}
      >
        <Clock className="h-3.5 w-3.5" /> Starting now · pick a different time
      </button>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            emit(e.target.value, time);
          }}
          className="h-9 w-[9.5rem]"
          aria-label="Start date"
        />
        <Input
          type="time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value);
            emit(date, e.target.value);
          }}
          className="h-9 w-28"
          aria-label="Start time"
        />
        {/* In startExpanded mode the HOST owns escape/"now" (its buttons), and
            collapsing here would show the clock-IN "Starting now" label in the
            wrong context. */}
        {!startExpanded && (
          <button
            type="button"
            onClick={() => {
              setCustom(false);
              onChange(null);
            }}
            className="text-xs font-medium text-slate-400 hover:text-slate-700"
          >
            Use now
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-amber-600">
        {caption ?? "Starting the shift at the time above — use this if you forgot to clock in."}
      </p>
    </div>
  );
}
