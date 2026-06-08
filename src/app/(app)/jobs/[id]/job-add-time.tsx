"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
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
}: {
  jobId: string;
  techs: Tech[];
  jobCodes: JobCode[];
  defaultProfileId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const [date, setDate] = useState(`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`);
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("16:00");
  const [profileId, setProfileId] = useState(defaultProfileId);
  const [jobCode, setJobCode] = useState("");
  const [lunch, setLunch] = useState(0);
  const [notes, setNotes] = useState("");

  function save() {
    setError(null);
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime())) return setError("Invalid date/time.");
    if (co <= ci) return setError("End must be after start.");
    start(async () => {
      const res = await createManualEntry({
        profile_id: profileId,
        clock_in: ci.toISOString(),
        clock_out: co.toISOString(),
        job_id: jobId,
        job_code: jobCode || null,
        lunch_minutes: lunch,
        notes,
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
          <div className="grid grid-cols-3 gap-3">
            <div>
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
          <div className="w-1/2 pr-1.5">
            <Label htmlFor="at-lunch">Lunch (minutes)</Label>
            <NumberInput id="at-lunch" value={lunch} onValueChange={setLunch} />
          </div>
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
