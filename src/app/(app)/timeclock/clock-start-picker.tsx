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
}: {
  onChange: (iso: string | null) => void;
  className?: string;
}) {
  const [custom, setCustom] = useState(false);
  const init = nowParts();
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);

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
      </div>
      <p className="mt-1 text-xs text-amber-600">
        Starting the shift at the time above — use this if you forgot to clock in.
      </p>
    </div>
  );
}
