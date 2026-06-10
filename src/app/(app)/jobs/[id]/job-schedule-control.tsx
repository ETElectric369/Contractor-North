"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { setJobSchedule } from "../../schedule/actions";

/** ISO → yyyy-mm-dd in local time for a date input. */
function toLocalDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Build an ISO timestamp from a local date string at a fixed local hour, so
 *  jobs land on the right calendar day in the user's timezone. */
function dateToIso(date: string, hour: number): string | null {
  if (!date) return null;
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).toISOString();
}

/** Date-only start/end editor on the Job tab — saves as soon as a date is picked. */
export function JobScheduleControl({
  id,
  start,
  end,
}: {
  id: string;
  start: string | null;
  end: string | null;
}) {
  const router = useRouter();
  const [s, setS] = useState(toLocalDate(start));
  const [e, setE] = useState(toLocalDate(end));
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save(nextS: string, nextE: string) {
    setError(null);
    if (nextS && nextE && nextE < nextS) {
      setError("End date is before the start date.");
      return;
    }
    startT(async () => {
      // Start lands at 8am local, end at 4pm, so the Scheduler shows a work day.
      const res = await setJobSchedule(id, dateToIso(nextS, 8), dateToIso(nextE, 16));
      if (!res.ok) {
        setError(res.error ?? "Could not save.");
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={s}
          onChange={(ev) => {
            setS(ev.target.value);
            save(ev.target.value, e);
          }}
          disabled={pending}
          className="h-9 w-[150px]"
          aria-label="Start date"
        />
        <span className="text-xs text-slate-400">to</span>
        <Input
          type="date"
          value={e}
          onChange={(ev) => {
            setE(ev.target.value);
            save(s, ev.target.value);
          }}
          disabled={pending}
          className="h-9 w-[150px]"
          aria-label="End date"
        />
        {pending && <span className="text-xs text-slate-400">Saving…</span>}
        {saved && !pending && (
          <span className="flex items-center gap-1 text-xs font-medium text-green-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
