"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, Plus, Trash2, Coffee, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { hoursBetween, formatDuration } from "@/lib/utils";
import type { JobCode } from "@/lib/types";
import { completeAutoClockOut } from "./actions";

type JobOpt = { id: string; job_number: string; name: string; codes?: string[] };
type Entry = { id: string; clock_in: string; clock_out: string; lunch_minutes: number; jobId: string | null; jobLabel: string };
type AllocRow = { job_id: string; job_code: string; hours: number; minutes: number; description: string };

/** Shown on /timeclock when a clock-out left the breakdown unfinished — either the geofence
 *  auto-clocked the tech out (they drove off the job) OR they tapped "break it down later" at
 *  clock-out. They answer the questions after the fact: which code(s) + hours, and whether they
 *  took lunch. The clock in/out times are locked; only the code split + lunch are added here. */
export function AutoClockoutPrompt({ entry, jobCodes, jobs }: { entry: Entry; jobCodes: JobCode[]; jobs: JobOpt[] }) {
  const router = useRouter();
  const worked0 = hoursBetween(entry.clock_in, entry.clock_out, entry.lunch_minutes);
  const [allocations, setAllocations] = useState<AllocRow[]>([
    {
      job_id: entry.jobId ?? "",
      job_code: "",
      hours: Math.max(0, Math.floor(worked0)),
      minutes: Math.max(0, Math.round((worked0 - Math.floor(worked0)) * 60)),
      description: "",
    },
  ]);
  const [lunch, setLunch] = useState(entry.lunch_minutes > 0);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const worked = hoursBetween(entry.clock_in, entry.clock_out, lunch ? 30 : 0);
  const allocated = allocations.reduce((s, a) => s + (a.hours || 0) + (a.minutes || 0) / 60, 0);
  const ok = allocations.some((a) => a.job_code && (a.hours || 0) + (a.minutes || 0) / 60 > 0);

  function update(i: number, patch: Partial<AllocRow>) {
    setAllocations((p) => p.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function codesForJob(jobId: string): JobCode[] {
    const j = jobs.find((x) => x.id === jobId);
    if (j?.codes && j.codes.length) return jobCodes.filter((c) => j.codes!.includes(c.code));
    return jobCodes;
  }
  function save() {
    setError(null);
    start(async () => {
      const res = await completeAutoClockOut({
        entry_id: entry.id,
        lunch_minutes: lunch ? 30 : 0,
        allocations: allocations.map((a) => ({
          job_id: a.job_id || null,
          job_code: a.job_code || null,
          hours: (a.hours || 0) + (a.minutes || 0) / 60,
          description: a.description,
        })),
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      router.refresh();
    });
  }

  return (
    <Card className="mb-4 border-amber-300 bg-amber-50/60">
      <CardContent className="space-y-4 py-5">
        <div className="flex items-start gap-2">
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <div className="text-sm font-semibold text-amber-800">
              Finish your timecard — you clocked out at {new Date(entry.clock_out).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
            </div>
            <div className="text-xs text-amber-700">Break down the hours you worked: which code(s) and how long, so they bill to the right job.</div>
          </div>
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white/60 px-3 py-2 text-sm">
          <input type="checkbox" checked={lunch} onChange={(e) => setLunch(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
          <Coffee className="h-4 w-4 text-slate-400" />
          <span className="text-slate-700">Took a 30-minute lunch</span>
        </label>

        <div className="space-y-2">
          {allocations.map((a, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-amber-100 bg-white/60 p-2">
              <div className="flex items-center gap-2">
                <Select value={a.job_id} onChange={(e) => update(i, { job_id: e.target.value })} className="h-9 flex-1">
                  <option value="">— Job —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>
                  ))}
                </Select>
                <Select value={a.job_code} onChange={(e) => update(i, { job_code: e.target.value })} className="h-9 w-28">
                  <option value="">Code</option>
                  {codesForJob(a.job_id).map((c) => (
                    <option key={c.id} value={c.code}>{c.code}</option>
                  ))}
                </Select>
                <div className="flex items-center gap-1">
                  <NumberInput value={a.hours} onValueChange={(n) => update(i, { hours: n })} className="h-9 w-12 text-center" placeholder="h" />
                  <span className="text-xs text-slate-400">h</span>
                  <NumberInput value={a.minutes} onValueChange={(n) => update(i, { minutes: n })} className="h-9 w-12 text-center" placeholder="m" />
                  <span className="text-xs text-slate-400">m</span>
                </div>
                <button type="button" onClick={() => setAllocations((p) => p.filter((_, idx) => idx !== i))} className="text-slate-400 hover:text-red-600" aria-label="Remove">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <Input placeholder="What did you do? (optional)" value={a.description} onChange={(e) => update(i, { description: e.target.value })} />
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setAllocations((p) => [...p, { job_id: "", job_code: "", hours: 0, minutes: 0, description: "" }])} className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">
              <Plus className="h-4 w-4 shrink-0" /> Add Another Code
            </button>
            <span className={`text-xs ${Math.abs(allocated - worked) > 0.1 ? "text-amber-600" : "text-slate-500"}`}>
              {formatDuration(allocated)} of {formatDuration(worked)} worked
            </span>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button onClick={save} disabled={pending || !ok} className="w-full">
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving</> : "Save My Hours"}
        </Button>
      </CardContent>
    </Card>
  );
}
