"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { createManualEntry } from "./actions";
import type { JobCode } from "@/lib/types";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}
interface Member {
  id: string;
  full_name: string | null;
}

export function AddEntryButton({
  isStaff,
  members,
  jobCodes,
  jobs,
}: {
  isStaff: boolean;
  members: Member[];
  jobCodes: JobCode[];
  jobs: JobOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const today = new Date().toISOString().slice(0, 10);
  const [member, setMember] = useState("");
  const [date, setDate] = useState(today);
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("16:00");
  const [jobId, setJobId] = useState("");
  const [jobCode, setJobCode] = useState("");
  const [lunchTaken, setLunchTaken] = useState(false);
  const [breaksTaken, setBreaksTaken] = useState(false);
  const [miles, setMiles] = useState(0);
  const [notes, setNotes] = useState("");

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

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add entry
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Add past timecard entry">
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
            <div>
              <Label htmlFor="m-miles">Miles</Label>
              <NumberInput id="m-miles" value={miles} onValueChange={setMiles} />
            </div>
          </div>
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
                  {j.job_number} · {j.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="m-notes">Notes</Label>
            <Textarea id="m-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? "Saving…" : "Add entry"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
