"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { drivingDistanceMiles } from "@/lib/google-maps";
import { createManualEntry } from "../../timeclock/actions";
import type { JobCode } from "@/lib/types";

interface Tech {
  id: string;
  full_name: string | null;
}

export function JobAddTimeEntry({
  jobId,
  techs,
  jobCodes,
  defaultProfileId,
  companyAddress,
  jobAddress,
  mileageRate = 0,
}: {
  jobId: string;
  techs: Tech[];
  jobCodes: JobCode[];
  defaultProfileId: string;
  companyAddress?: string;
  jobAddress?: string;
  mileageRate?: number;
}) {
  const router = useRouter();
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [miles, setMiles] = useState(0);
  const [calcing, setCalcing] = useState(false);

  async function autoMiles() {
    if (!key || !companyAddress || !jobAddress) return;
    setCalcing(true);
    const oneWay = await drivingDistanceMiles(key, companyAddress, jobAddress);
    setCalcing(false);
    if (oneWay != null) setMiles(Math.round(oneWay * 2 * 10) / 10); // round trip
  }

  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const [date, setDate] = useState(`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`);
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("16:00");
  const [profileId, setProfileId] = useState(defaultProfileId);
  const [jobCode, setJobCode] = useState("");
  const [lunchTaken, setLunchTaken] = useState(false);
  const [notes, setNotes] = useState("");

  const lunchRequired = (() => {
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime()) || co <= ci) return false;
    return (co.getTime() - ci.getTime()) / 3_600_000 > 5;
  })();

  function save() {
    setError(null);
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime())) return setError("Invalid date/time.");
    if (co <= ci) return setError("End must be after start.");
    if (lunchRequired && !lunchTaken) return setError("Confirm the 30-minute lunch — required for shifts over 5 hours.");
    start(async () => {
      const res = await createManualEntry({
        profile_id: profileId,
        clock_in: ci.toISOString(),
        clock_out: co.toISOString(),
        job_id: jobId,
        job_code: jobCode || null,
        lunch_minutes: lunchTaken ? 30 : 0,
        notes,
        miles,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> Add time entry
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add time entry">
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1">
              <Label htmlFor="at-date">Date</Label>
              <Input id="at-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="at-start">Start</Label>
              <Input id="at-start" type="time" value={startT} onChange={(e) => setStartT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="at-end">End</Label>
              <Input id="at-end" type="time" value={endT} onChange={(e) => setEndT(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="at-emp">Employee</Label>
              <Select id="at-emp" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {techs.map((t) => (
                  <option key={t.id} value={t.id}>{t.full_name ?? "Unnamed"}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="at-code">Job code</Label>
              <Select id="at-code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
                <option value="">— Code —</option>
                {jobCodes.map((c) => (
                  <option key={c.id} value={c.code}>{c.code} — {c.description}</option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="at-miles">
              Miles{mileageRate > 0 && miles > 0 ? ` · $${(miles * mileageRate).toFixed(2)}` : ""}
            </Label>
            <div className="flex gap-2">
              <NumberInput id="at-miles" value={miles} onValueChange={setMiles} />
              {key && companyAddress && jobAddress && (
                <Button type="button" size="sm" variant="outline" onClick={autoMiles} disabled={calcing} title="Round trip: company ↔ job">
                  {calcing ? "…" : "Auto"}
                </Button>
              )}
            </div>
          </div>
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${lunchRequired && !lunchTaken ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
            <input type="checkbox" checked={lunchTaken} onChange={(e) => setLunchTaken(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            <span className="text-slate-700">Took a 30-minute lunch{lunchRequired ? <span className="font-medium text-amber-700"> · required (over 5 hrs)</span> : null}</span>
          </label>
          <div>
            <Label htmlFor="at-notes">Notes</Label>
            <Textarea id="at-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save entry"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
