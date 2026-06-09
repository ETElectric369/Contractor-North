"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

export function SchedulingSettings({ settings }: { settings: OrgSettings }) {
  const [start, setStart] = useState(settings.work_day_start);
  const [end, setEnd] = useState(settings.work_day_end);
  const [weekStart, setWeekStart] = useState(settings.week_start);
  const [method, setMethod] = useState(settings.time_tracking_method);
  const [laborLaw, setLaborLaw] = useState(settings.labor_law_breaks);
  const [autoLunch, setAutoLunch] = useState(settings.auto_lunch_30);
  const [pending, startT] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    setDone(false);
    startT(async () => {
      const res = await updateOrgSettings({
        work_day_start: start,
        work_day_end: end,
        week_start: weekStart,
        time_tracking_method: method,
        labor_law_breaks: laborLaw,
        auto_lunch_30: autoLunch,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="sc-start">Working day starts</Label>
          <Input id="sc-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="sc-end">Working day ends</Label>
          <Input id="sc-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="sc-week">Week starts on</Label>
          <Select id="sc-week" value={weekStart} onChange={(e) => setWeekStart(e.target.value as any)}>
            <option value="monday">Monday</option>
            <option value="sunday">Sunday</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="sc-method">Time tracking method</Label>
          <Select id="sc-method" value={method} onChange={(e) => setMethod(e.target.value as any)}>
            <option value="start_end">Track start &amp; end time</option>
            <option value="duration">Track duration only</option>
          </Select>
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Working hours set the visible range on the Scheduler calendar.
      </p>

      <div className="space-y-2 border-t border-slate-100 pt-4">
        <div className="text-sm font-medium text-slate-700">Labor-law compliance (timeclock)</div>
        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={laborLaw} onChange={(e) => setLaborLaw(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
          <span>Require crew to confirm rest breaks at clock-out (CA: 2× 10-min if 5+ hrs, otherwise 1×).</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={autoLunch} onChange={(e) => setAutoLunch(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
          <span>Auto-apply a 30-min unpaid lunch on shifts over 5 hours (not adjustable by the crew member).</span>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
