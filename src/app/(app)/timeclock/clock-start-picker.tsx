"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { clockInputValue } from "@/lib/split-preview";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";

/** The phone's own zone: the fallback when a host passes no org timezone. */
function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
  } catch {
    return "America/Los_Angeles";
  }
}

/**
 * The date and time fields for an instant, read on the ORG's wall clock (audit v994 TZ1). A phone
 * set to Mountain time showed "Since 7:00 AM" (Pacific, the heading) over a picker that opened at
 * 8:00, and a typed 3:30 PM saved as 2:30 PM Pacific: the shift was paid and billed an hour short.
 */
export function pickerParts(iso: string | undefined, tz: string): { date: string; time: string } {
  const seeded = iso ? new Date(iso) : null;
  const d = seeded && !isNaN(seeded.getTime()) ? seeded : new Date();
  return { date: todayStrInTz(tz, d), time: clockInputValue(d.toISOString(), tz) };
}

/** The instant the fields name, on the org's wall clock; null when they don't name one. */
export function pickerInstant(date: string, time: string, tz: string): string | null {
  if (!/^\d{2}:\d{2}$/.test(time ?? "")) return null;
  const iso = tzDateTimeUtc(date, time, tz);
  return iso && !isNaN(Date.parse(iso)) ? iso : null;
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
  initialIso,
  fieldLabel = "Start",
  tz,
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
  /** Seed the date + time from this instant instead of now (device-local, like now). The long-shift
   *  stop picker opens on the CLOCK-IN, so a man who forgot yesterday starts from the right day. */
  initialIso?: string;
  /** What the two inputs set, for screen readers: "Start" on a clock-in, "Stop" when the picker is
   *  the stop time of a forgotten punch (the Timeclock long-shift block, the geofence sheet). */
  fieldLabel?: string;
  /** The org's timezone: the fields are its wall clock, whatever the phone is set to (audit v994
   *  TZ1). Absent: the phone's own zone, as before. */
  tz?: string;
}) {
  const zone = tz || deviceTz();
  const [custom, setCustom] = useState(startExpanded);
  const [rounded, setRounded] = useState(false);
  const init = pickerParts(initialIso, zone);
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);

  // Employee path: no free picker — just toggle the start between "now" and the
  // nearest half-hour BEFORE now. (The server clamps it the same way regardless.)
  if (!staff) {
    const now = Date.now();
    const floor = new Date(now - (now % 1_800_000));
    const lbl = clockInputValue(floor.toISOString(), zone);
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
    onChange(pickerInstant(d, t, zone));
  }

  if (!custom) {
    return (
      <button
        type="button"
        onClick={() => {
          const n = pickerParts(undefined, zone);
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
          // 44px when the picker IS the control (a stop time picked on a phone), 36px as the quiet
          // clock-in extra.
          className={startExpanded ? "h-11 w-[9.5rem]" : "h-9 w-[9.5rem]"}
          aria-label={`${fieldLabel} date`}
        />
        <Input
          type="time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value);
            emit(date, e.target.value);
          }}
          className={startExpanded ? "h-11 w-28" : "h-9 w-28"}
          aria-label={`${fieldLabel} time`}
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
            Use Now
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-amber-600">
        {caption ?? "Starting the shift at the time above — use this if you forgot to clock in."}
      </p>
    </div>
  );
}
