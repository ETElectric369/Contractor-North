"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

export function SchedulingSettings({
  settings,
  employees = [],
  ownerName,
}: {
  settings: OrgSettings;
  employees?: { id: string; full_name: string | null }[];
  ownerName?: string;
}) {
  const [start, setStart] = useState(settings.work_day_start);
  const [end, setEnd] = useState(settings.work_day_end);
  const [weekStart, setWeekStart] = useState(settings.week_start);
  const [method, setMethod] = useState(settings.time_tracking_method);
  const [remindClock, setRemindClock] = useState(settings.remind_timeclock);
  const [askJobCodes, setAskJobCodes] = useState(settings.timeclock_job_codes);
  const [geofence, setGeofence] = useState(settings.geofence_logout);
  const [radius, setRadius] = useState(settings.geofence_radius_m);
  const [supervisor, setSupervisor] = useState(settings.timecard_supervisor_id);
  const [paySchedule, setPaySchedule] = useState(settings.pay_schedule);
  const [payAnchor, setPayAnchor] = useState(settings.pay_anchor);
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
        remind_timeclock: remindClock,
        timeclock_job_codes: askJobCodes,
        geofence_logout: geofence,
        geofence_radius_m: Math.max(50, Math.round(Number(radius) || 300)),
        timecard_supervisor_id: supervisor,
        pay_schedule: paySchedule,
        pay_anchor: payAnchor,
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
        <div className="text-sm font-medium text-slate-700">Timeclock (labor law)</div>
        <p className="text-xs text-slate-500">
          A 30-minute unpaid lunch is deducted automatically on shifts over 5 hours — nobody
          confirms checkboxes. The office can adjust any entry&apos;s lunch from Timecards.
        </p>
        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={remindClock} onChange={(e) => setRemindClock(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
          <span>Text timeclock reminders to techs — a morning nudge if they haven&apos;t clocked in, and an end-of-day reminder to clock out / fill in the day&apos;s details.</span>
        </label>
      </div>

      <div className="space-y-2 border-t border-slate-100 pt-4">
        <div className="text-sm font-medium text-slate-700">Job codes on the timeclock</div>
        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={askJobCodes} onChange={(e) => setAskJobCodes(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
          <span>Ask the crew for job codes (the clock-out code breakdown and the code pickers).</span>
        </label>
        {!askJobCodes && (
          <p className="pl-6 text-xs text-slate-400">
            Codes off: each entry just carries its job — no code questions anywhere on the clock —
            and job pickers identify work by customer &amp; street address instead of the job number.
            Mid-shift job switching and hours still work the same, and pay math is unchanged.
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-slate-100 pt-4">
        <div className="text-sm font-medium text-slate-700">Geofence auto clock-out</div>
        <label className="flex items-start gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={geofence} onChange={(e) => setGeofence(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
          <span>Clock an employee out when they leave the job they clocked into — at the time they left, so a forgotten clock-out can&apos;t over-bill.</span>
        </label>
        {geofence && (
          <div className="flex items-center gap-2 pl-6">
            <Label htmlFor="geo-r" className="text-xs text-slate-500">Leave radius (meters)</Label>
            <Input id="geo-r" type="number" min={50} step={50} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="h-8 w-24" />
            <span className="text-xs text-slate-400">~{Math.round((Number(radius) || 300) * 3.28)} ft</span>
          </div>
        )}
        <p className="text-xs text-slate-400">Runs while the app is open on the employee&apos;s phone. (True background tracking needs the native app.)</p>
      </div>

      <div className="space-y-1.5 border-t border-slate-100 pt-4">
        <Label htmlFor="sup">Timecard supervisor</Label>
        <Select id="sup" value={supervisor} onChange={(e) => setSupervisor(e.target.value)}>
          <option value="">Owner{ownerName ? ` — ${ownerName}` : ""} (default)</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.full_name ?? "Unnamed"}</option>
          ))}
        </Select>
        <p className="text-xs text-slate-400">Who reviews &amp; approves timecards. Defaults to the owner.</p>
      </div>

      <div className="space-y-3 border-t border-slate-100 pt-4">
        <div className="text-sm font-medium text-slate-700">Payroll</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="pay-sched">Pay period</Label>
            <Select id="pay-sched" value={paySchedule} onChange={(e) => setPaySchedule(e.target.value as any)}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks (biweekly)</option>
              <option value="semimonthly">Twice a month (1st &amp; 16th)</option>
              <option value="monthly">Monthly</option>
            </Select>
          </div>
          {(paySchedule === "weekly" || paySchedule === "biweekly") && (
            <div>
              <Label htmlFor="pay-anchor">A period start date</Label>
              <Input id="pay-anchor" type="date" value={payAnchor} onChange={(e) => setPayAnchor(e.target.value)} />
            </div>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Sets the boundaries for &ldquo;hours this pay period&rdquo; and payroll runs. We report gross
          hours, pay &amp; mileage in the export — tax deductions &amp; withholdings stay with your
          accountant / payroll service.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save Changes"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
