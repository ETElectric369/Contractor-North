"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setJobSchedule } from "../../schedule/actions";

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Inline start/end schedule editor on the Job tab — change dates right here. */
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
  const [s, setS] = useState(toLocalInput(start));
  const [e, setE] = useState(toLocalInput(end));
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = s !== toLocalInput(start) || e !== toLocalInput(end);

  function save() {
    setError(null);
    if (s && e && new Date(e) <= new Date(s)) {
      setError("End must be after start.");
      return;
    }
    startT(async () => {
      const res = await setJobSchedule(
        id,
        s ? new Date(s).toISOString() : null,
        e ? new Date(e).toISOString() : null,
      );
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
          type="datetime-local"
          value={s}
          onChange={(ev) => setS(ev.target.value)}
          className="h-8 w-[200px] text-xs"
          aria-label="Scheduled start"
        />
        <span className="text-xs text-slate-400">to</span>
        <Input
          type="datetime-local"
          value={e}
          onChange={(ev) => setE(ev.target.value)}
          className="h-8 w-[200px] text-xs"
          aria-label="Scheduled end"
        />
        {dirty && (
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        )}
        {saved && (
          <span className="flex items-center gap-1 text-xs font-medium text-green-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
