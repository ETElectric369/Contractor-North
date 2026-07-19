"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { createManualEntry } from "./actions";
import { todayStrInTz } from "@/lib/tz";
import type { JobCode } from "@/lib/types";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
  address?: string | null;
  customer_name?: string | null; // feeds the codes-off customer · address label
}
interface Member {
  id: string;
  full_name: string | null;
  // Pay-rate anchor (staff-only pages pass these): the person's real base pay,
  // plus the customer bill rate so the Rate field can warn when it's typed by
  // mistake. bill_rate is never offered or defaulted into the pay field.
  hourly_rate?: number | null;
  bill_rate?: number | null;
}

export function AddEntryButton({
  isStaff,
  members,
  jobCodes,
  jobs,
  tz = "America/Los_Angeles",
  jobCodesEnabled = true,
}: {
  isStaff: boolean;
  members: Member[];
  jobCodes: JobCode[];
  jobs: JobOption[];
  /** Org IANA timezone, so the default date is the business's local "today"
   *  rather than the browser/UTC day. Defaults to the org-settings default. */
  tz?: string;
  /** org setting timeclock_job_codes — false drops the code question and labels
   *  jobs customer · address. Default true = today's form. */
  jobCodesEnabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const today = todayStrInTz(tz);
  const [member, setMember] = useState("");
  const [date, setDate] = useState(today);
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("16:00");
  const [jobId, setJobId] = useState("");
  const [jobCode, setJobCode] = useState("");
  // Default to "taken" so a normal workday entry saves in one tap; uncheck if
  // the person actually skipped them. (Unchecked-by-default was silently
  // blocking saves on any shift over 5 hrs.)
  const [lunchTaken, setLunchTaken] = useState(true);
  const [breaksTaken, setBreaksTaken] = useState(true);
  const [miles, setMiles] = useState(0);
  const [rate, setRate] = useState(0);
  const [notes, setNotes] = useState("");

  // Pay-rate guardrails: anchor the free Rate input to the selected person's REAL
  // base rate, and trip a non-blocking amber warning when the typed value is their
  // BILL rate — the $75-in-the-pay-slot mistake can never happen silently again.
  // ("Me" has no anchor — the viewer isn't identified client-side.)
  const person = members.find((m) => m.id === member);
  const baseRate = Number(person?.hourly_rate ?? 0);
  const billRate = Number(person?.bill_rate ?? 0);
  const billRateTyped =
    rate > 0 && billRate > 0 && Math.abs(rate - billRate) <= 0.01 && Math.abs(billRate - baseRate) > 0.01;

  const grossHrs = (() => {
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime()) || co <= ci) return 0;
    return (co.getTime() - ci.getTime()) / 3_600_000;
  })();
  const lunchRequired = grossHrs > 5;
  const breaksRequired = grossHrs > 3.5;
  const twoBreaks = grossHrs > 5;

  function submit() {
    setError(null);
    // Build ISO from local date + time so the user's timezone is respected.
    const clockIn = new Date(`${date}T${startT}:00`);
    const clockOut = new Date(`${date}T${endT}:00`);
    if (isNaN(clockIn.getTime()) || isNaN(clockOut.getTime())) {
      setError("Enter a valid date and times.");
      return;
    }
    if (clockOut <= clockIn) {
      setError("End time must be after start time.");
      return;
    }
    if (lunchRequired && !lunchTaken) {
      setError("Confirm the 30-minute lunch — it's required for shifts over 5 hours.");
      return;
    }
    if (breaksRequired && !breaksTaken) {
      setError("Confirm the rest break(s) — required by labor law.");
      return;
    }
    start(async () => {
      const res = await createManualEntry({
        profile_id: member,
        clock_in: clockIn.toISOString(),
        clock_out: clockOut.toISOString(),
        job_id: jobId || null,
        job_code: jobCode || null,
        lunch_minutes: lunchTaken ? 30 : 0,
        notes,
        miles,
        // Blank/0 ⇒ default rate; a positive number sets a per-entry override.
        rate_override: rate > 0 ? rate : null,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not add entry.");
        return;
      }
      setOpen(false);
      setNotes("");
      router.refresh();
    });
  }

  if (!isStaff) return null; // techs clock in/out live — only the office adds entries

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add Entry
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add past timecard entry"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={submit}
            saving={pending}
            saveLabel="Add Entry"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {isStaff && (
            <div>
              <Label htmlFor="member">Crew member</Label>
              <Select id="member" value={member} onChange={(e) => setMember(e.target.value)}>
                <option value="">Me</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name ?? "Unnamed"}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1">
              <Label htmlFor="date">Date</Label>
              <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="start">Start</Label>
              <Input id="start" type="time" value={startT} onChange={(e) => setStartT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="end">End</Label>
              <Input id="end" type="time" value={endT} onChange={(e) => setEndT(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {/* Codes off: no code question — the entry carries just its job below. */}
            {jobCodesEnabled && (
              <div className="col-span-2">
                <Label htmlFor="m-code">Job code</Label>
                <Select id="m-code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
                  <option value="">— Code —</option>
                  {jobCodes.map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code} — {c.description}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="m-miles">Miles</Label>
              <NumberInput id="m-miles" value={miles} onValueChange={setMiles} />
            </div>
            <div className="col-span-2 sm:col-span-3">
              <Label htmlFor="m-rate">Rate ($/hr, blank/0 = default)</Label>
              <NumberInput id="m-rate" value={rate} onValueChange={setRate} step={0.5} />
              {baseRate > 0 && (
                <p className="mt-1 text-xs text-slate-400">{`Base $${baseRate.toFixed(2)}/hr — leave blank to use it`}</p>
              )}
            </div>
          </div>
          {billRateTyped && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {`That's ${person?.full_name ?? "this person"}'s bill rate (what customers are charged)${baseRate > 0 ? ` — their pay rate is $${baseRate.toFixed(2)}/hr.` : "."}`}
            </div>
          )}
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${lunchRequired && !lunchTaken ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
            <input type="checkbox" checked={lunchTaken} onChange={(e) => setLunchTaken(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            <span className="text-slate-700">Took a 30-minute lunch{lunchRequired ? <span className="font-medium text-amber-700"> · required (over 5 hrs)</span> : null}</span>
          </label>
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${breaksRequired && !breaksTaken ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
            <input type="checkbox" checked={breaksTaken} onChange={(e) => setBreaksTaken(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            <span className="text-slate-700">Took {twoBreaks ? "two 10-minute rest breaks" : "a 10-minute rest break"}{breaksRequired ? <span className="font-medium text-amber-700"> · required</span> : null}</span>
          </label>

          <div>
            <Label htmlFor="m-job">Job (optional)</Label>
            <Select id="m-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">— No job —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {jobCodesEnabled ? jobLabel(j) : jobSiteLabel(j)}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="m-notes">Notes</Label>
            <Textarea id="m-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
