"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createPermit } from "./actions";

type JobOpt = { id: string; label: string };

const TYPES = ["Electrical", "Plumbing", "Mechanical", "Building", "Solar", "Other"];
const STATUSES: [string, string][] = [
  ["applied", "Applied"],
  ["issued", "Issued"],
  ["inspection_scheduled", "Inspection scheduled"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["closed", "Closed"],
];

/** Standalone "Add permit" on the /permits page — the job is OPTIONAL (a permit can stand
 *  alone), so the page is no longer view-only. Mirrors the job-tab form, wraps createPermit. */
export function AddPermitButton({ jobs }: { jobs: JobOpt[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [jobId, setJobId] = useState("");
  const [type, setType] = useState("Electrical");
  const [num, setNum] = useState("");
  const [authority, setAuthority] = useState("");
  const [status, setStatus] = useState("applied");
  const [applied, setApplied] = useState("");
  const [inspDate, setInspDate] = useState("");
  const [notes, setNotes] = useState("");

  function save() {
    setError(null);
    start(async () => {
      const res = await createPermit({
        job_id: jobId || null,
        type,
        permit_number: num,
        authority,
        status,
        applied_date: applied || null,
        inspection_date: inspDate || null,
        notes,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setNum(""); setAuthority(""); setApplied(""); setInspDate(""); setNotes(""); setJobId("");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add permit
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a permit"
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} saveLabel="Add permit" />}
      >
        <div className="space-y-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div>
            <Label htmlFor="ap-job">Job (optional)</Label>
            <Select id="ap-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">— No job —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{j.label}</option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="ap-type">Type</Label><Select id="ap-type" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
            <div><Label htmlFor="ap-num">Permit #</Label><Input id="ap-num" value={num} onChange={(e) => setNum(e.target.value)} /></div>
            <div><Label htmlFor="ap-auth">Authority</Label><Input id="ap-auth" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="e.g. Washoe County" /></div>
            <div><Label htmlFor="ap-status">Status</Label><Select id="ap-status" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
            <div><Label htmlFor="ap-applied">Applied date</Label><Input id="ap-applied" type="date" value={applied} onChange={(e) => setApplied(e.target.value)} /></div>
            <div><Label htmlFor="ap-insp">Inspection date</Label><Input id="ap-insp" type="date" value={inspDate} onChange={(e) => setInspDate(e.target.value)} /></div>
          </div>
          <div><Label htmlFor="ap-notes">Notes</Label><Textarea id="ap-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
      </Modal>
    </>
  );
}
