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
import { autoClockoutPromptState } from "./close-math";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";

type JobOpt = {
  id: string;
  job_number: string;
  name: string;
  address?: string | null;
  customer_name?: string | null; // feeds the codes-off customer · address label
  codes?: string[];
};
type Entry = {
  id: string;
  clock_in: string;
  clock_out: string;
  lunch_minutes: number;
  jobId: string | null;
  jobLabel: string;
  /** Hours ALREADY recorded on the entry — the segments a mid-shift job switch wrote,
   *  which now survive a geofence close instead of being deleted by it. Everything here
   *  is about the REMAINDER: completeAutoClockOut inserts alongside those rows, so
   *  seeding the full shift would double-bill them (and, since the entry points at the
   *  post-switch job, would re-file the whole day onto the wrong customer). */
  allocatedHours?: number;
};
type AllocRow = { job_id: string; job_code: string; hours: number; minutes: number; description: string };

/** Shown on /timeclock when a clock-out left the breakdown unfinished — either the geofence
 *  auto-clocked the tech out (they drove off the job) OR they tapped "break it down later" at
 *  clock-out. They answer the questions after the fact: which code(s) + hours (codes-off orgs:
 *  which JOB(s) + hours — no code question), and whether they took lunch. The clock in/out
 *  times are locked; only the split + lunch are added here. */
export function AutoClockoutPrompt({
  entry,
  jobCodes,
  jobs,
  jobCodesEnabled = true,
}: {
  entry: Entry;
  jobCodes: JobCode[];
  jobs: JobOpt[];
  /** org setting timeclock_job_codes — false hides every code control here. */
  jobCodesEnabled?: boolean;
}) {
  const router = useRouter();
  const optionLabel = (j: JobOpt) => (jobCodesEnabled ? jobLabel(j) : jobSiteLabel(j));
  const already = Math.max(0, Number(entry.allocatedHours) || 0);
  const gross0 = hoursBetween(entry.clock_in, entry.clock_out, 0);
  const worked0 = hoursBetween(entry.clock_in, entry.clock_out, entry.lunch_minutes);
  const remaining0 = Math.max(0, worked0 - already);
  // MEAL-ONLY: the whole shift is ALREADY recorded (a mid-shift switch's segments + the
  // close's tail backstop filled it) and the only thing the auto-close skipped is the
  // 30-min meal on a >5h shift. Then this prompt is a lunch-only confirmation — there's
  // nothing left to break down. Same pure gate the page uses to decide to show us at all.
  const { mealOnly } = autoClockoutPromptState({
    grossHours: gross0,
    lunchMinutes: entry.lunch_minutes,
    allocatedHours: already,
  });
  const [allocations, setAllocations] = useState<AllocRow[]>([
    {
      job_id: entry.jobId ?? "",
      job_code: "",
      hours: Math.max(0, Math.floor(remaining0)),
      minutes: Math.max(0, Math.round((remaining0 - Math.floor(remaining0)) * 60)),
      description: "",
    },
  ]);
  // In meal-only mode default the meal to TAKEN — the shift is over 5h and the auto-close
  // deducted none, so a one-tap Save applies the 30-min meal (matching the server's ">5
  // gross hours ⇒ deduct 30 min" auto-lunch); uncheck only if the tech truly skipped it.
  // The normal breakdown flow keeps its existing default (whatever lunch is on the entry).
  const [lunch, setLunch] = useState(entry.lunch_minutes > 0 || mealOnly);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The number this form is filling: hours worked MINUS what the shift already recorded.
  const worked = Math.max(0, hoursBetween(entry.clock_in, entry.clock_out, lunch ? 30 : 0) - already);
  const allocated = allocations.reduce((s, a) => s + (a.hours || 0) + (a.minutes || 0) / 60, 0);
  // Codes off: the split identifies work by the JOB, so a job (not a code) unlocks Save.
  // Meal-only: the hours are already on the entry, so Save just writes the lunch.
  const ok =
    mealOnly ||
    allocations.some(
      (a) => (jobCodesEnabled ? a.job_code : a.job_id) && (a.hours || 0) + (a.minutes || 0) / 60 > 0,
    );

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
            <div className="text-xs text-amber-700">
              {mealOnly
                ? "Your hours are already recorded from switching jobs — just confirm your lunch below so the meal break is deducted."
                : jobCodesEnabled
                  ? "Break down the hours you worked: which code(s) and how long, so they bill to the right job."
                  : "Break down the hours you worked: which job(s) and how long, so they bill to the right job."}
            </div>
            {!mealOnly && already > 0.01 && (
              <div className="mt-1 text-xs text-amber-700">
                {`${formatDuration(already)} is already recorded from switching jobs — this is just the rest of the day.`}
              </div>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white/60 px-3 py-2 text-sm">
          <input type="checkbox" checked={lunch} onChange={(e) => setLunch(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
          <Coffee className="h-4 w-4 text-slate-400" />
          <span className="text-slate-700">Took a 30-minute lunch</span>
        </label>

        {!mealOnly && (
        <div className="space-y-2">
          {allocations.map((a, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-amber-100 bg-white/60 p-2">
              <div className="flex items-center gap-2">
                <Select value={a.job_id} onChange={(e) => update(i, { job_id: e.target.value })} className="h-9 flex-1">
                  <option value="">— Job —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>{optionLabel(j)}</option>
                  ))}
                </Select>
                {jobCodesEnabled && (
                  <Select value={a.job_code} onChange={(e) => update(i, { job_code: e.target.value })} className="h-9 w-28">
                    <option value="">Code</option>
                    {codesForJob(a.job_id).map((c) => (
                      <option key={c.id} value={c.code}>{c.code}</option>
                    ))}
                  </Select>
                )}
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
              <Plus className="h-4 w-4 shrink-0" /> {jobCodesEnabled ? "Add Another Code" : "Add Another Job"}
            </button>
            <span className={`text-xs ${Math.abs(allocated - worked) > 0.1 ? "text-amber-600" : "text-slate-500"}`}>
              {formatDuration(allocated)} of {formatDuration(worked)} {already > 0.01 ? "left to log" : "worked"}
            </span>
          </div>
        </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button onClick={save} disabled={pending || !ok} className="w-full">
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving</> : "Save My Hours"}
        </Button>
      </CardContent>
    </Card>
  );
}
