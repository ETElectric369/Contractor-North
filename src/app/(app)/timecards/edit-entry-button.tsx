"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { updateTimeEntry, deleteTimeEntry } from "../timeclock/actions";
import type { JobCode } from "@/lib/types";

interface Entry {
  id: string;
  clock_in: string;
  clock_out: string | null;
  lunch_minutes: number;
  job_code: string | null;
  notes: string | null;
}

function parts(iso: string | null) {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

export function EditEntryButton({
  entry,
  jobCodes,
}: {
  entry: Entry;
  jobCodes: JobCode[];
}) {
  const router = useRouter();
  const inP = parts(entry.clock_in);
  const outP = parts(entry.clock_out);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [date, setDate] = useState(inP.date);
  const [startT, setStartT] = useState(inP.time);
  const [endT, setEndT] = useState(outP.time || inP.time);
  const [jobCode, setJobCode] = useState(entry.job_code ?? "");
  const [lunch, setLunch] = useState(entry.lunch_minutes ?? 0);
  const [notes, setNotes] = useState(entry.notes ?? "");

  function save() {
    setError(null);
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime())) return setError("Invalid date/time.");
    if (co <= ci) return setError("End must be after start.");
    start(async () => {
      const res = await updateTimeEntry({
        id: entry.id,
        clock_in: ci.toISOString(),
        clock_out: co.toISOString(),
        lunch_minutes: lunch,
        job_code: jobCode || null,
        notes,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }

  function remove() {
    if (!confirm("Delete this time entry? This can't be undone.")) return;
    start(async () => {
      const res = await deleteTimeEntry(entry.id);
      if (!res.ok) return setError(res.error ?? "Could not delete.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title="Edit entry"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Edit time entry">
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="e-date">Date</Label>
              <Input id="e-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-start">Start</Label>
              <Input id="e-start" type="time" value={startT} onChange={(e) => setStartT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-end">End</Label>
              <Input id="e-end" type="time" value={endT} onChange={(e) => setEndT(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="e-code">Job code</Label>
              <Select id="e-code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
                <option value="">— Code —</option>
                {jobCodes.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.code} — {c.description}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="e-lunch">Lunch (minutes)</Label>
              <NumberInput id="e-lunch" value={lunch} onValueChange={setLunch} />
            </div>
          </div>
          <div>
            <Label htmlFor="e-notes">Notes</Label>
            <Textarea id="e-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" onClick={remove} disabled={pending} className="text-red-600 hover:bg-red-50">
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
