"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { updatePermit } from "./actions";

type Permit = {
  id: string;
  job_id?: string | null;
  permit_number?: string | null;
  type?: string | null;
  authority?: string | null;
  status?: string | null;
  applied_date?: string | null;
  issued_date?: string | null;
  expires_date?: string | null;
  inspection_date?: string | null;
  inspector?: string | null;
  notes?: string | null;
  portal_url?: string | null;
};

const TYPES = ["Electrical", "Plumbing", "Mechanical", "Building", "Solar", "Other"];
const STATUSES: [string, string][] = [
  ["applied", "Applied"],
  ["issued", "Issued"],
  ["inspection_scheduled", "Inspection scheduled"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["closed", "Closed"],
];

const d = (s?: string | null) => (s ? String(s).slice(0, 10) : "");

/** Edit every field of an existing permit (the inline status select only covers status). Shared by
 *  the job Permits card and the standalone /permits list, so a typo in the number/authority/dates is
 *  fixable from either place. `jobId` is passed through so the action revalidates the right job page. */
export function EditPermitButton({ permit, jobId }: { permit: Permit; jobId?: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState(permit.type ?? "Electrical");
  const [num, setNum] = useState(permit.permit_number ?? "");
  const [authority, setAuthority] = useState(permit.authority ?? "");
  const [status, setStatus] = useState(permit.status ?? "applied");
  const [applied, setApplied] = useState(d(permit.applied_date));
  const [issued, setIssued] = useState(d(permit.issued_date));
  const [expires, setExpires] = useState(d(permit.expires_date));
  const [inspDate, setInspDate] = useState(d(permit.inspection_date));
  const [inspector, setInspector] = useState(permit.inspector ?? "");
  const [portal, setPortal] = useState(permit.portal_url ?? "");
  const [notes, setNotes] = useState(permit.notes ?? "");

  function save() {
    setError(null);
    start(async () => {
      const res = await updatePermit(permit.id, {
        job_id: jobId ?? permit.job_id ?? null,
        type,
        permit_number: num || null,
        authority: authority || null,
        status,
        applied_date: applied || null,
        issued_date: issued || null,
        expires_date: expires || null,
        inspection_date: inspDate || null,
        inspector: inspector || null,
        portal_url: portal || null,
        notes: notes || null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title="Edit permit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit permit"
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} saveLabel="Save changes" />}
      >
        <div className="space-y-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="ep-type">Type</Label><Select id="ep-type" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
            <div><Label htmlFor="ep-num">Permit #</Label><Input id="ep-num" value={num} onChange={(e) => setNum(e.target.value)} /></div>
            <div><Label htmlFor="ep-auth">Authority</Label><Input id="ep-auth" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="e.g. Washoe County" /></div>
            <div><Label htmlFor="ep-status">Status</Label><Select id="ep-status" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
            <div><Label htmlFor="ep-applied">Applied date</Label><Input id="ep-applied" type="date" value={applied} onChange={(e) => setApplied(e.target.value)} /></div>
            <div><Label htmlFor="ep-issued">Issued date</Label><Input id="ep-issued" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} /></div>
            <div><Label htmlFor="ep-expires">Expires</Label><Input id="ep-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
            <div><Label htmlFor="ep-insp">Inspection date</Label><Input id="ep-insp" type="date" value={inspDate} onChange={(e) => setInspDate(e.target.value)} /></div>
            <div><Label htmlFor="ep-inspector">Inspector</Label><Input id="ep-inspector" value={inspector} onChange={(e) => setInspector(e.target.value)} /></div>
          </div>
          <div><Label htmlFor="ep-portal">Portal URL</Label><Input id="ep-portal" value={portal} onChange={(e) => setPortal(e.target.value)} placeholder="https://… status page" /></div>
          <div><Label htmlFor="ep-notes">Notes</Label><Textarea id="ep-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
      </Modal>
    </>
  );
}
