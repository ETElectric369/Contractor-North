"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { createPermit, updatePermit, deletePermit } from "../../permits/actions";

export interface Permit {
  id: string;
  permit_number: string | null;
  type: string;
  authority: string | null;
  status: string;
  applied_date: string | null;
  issued_date: string | null;
  inspection_date: string | null;
  inspector: string | null;
  inspection_result: string;
  fee: number;
  notes: string | null;
}

const TYPES = ["Electrical", "Building", "Mechanical", "Plumbing", "Solar/PV", "Low Voltage", "Other"];
const STATUSES = [
  ["not_submitted", "Not submitted"],
  ["applied", "Applied"],
  ["issued", "Issued"],
  ["scheduled", "Inspection scheduled"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["closed", "Closed / Final"],
] as const;
const RESULTS = [
  ["pending", "Pending"],
  ["passed", "Passed"],
  ["partial", "Partial"],
  ["failed", "Failed"],
] as const;

function statusTone(s: string): "green" | "red" | "amber" | "slate" {
  if (["issued", "passed", "closed"].includes(s)) return "green";
  if (s === "failed") return "red";
  if (["applied", "scheduled"].includes(s)) return "amber";
  return "slate";
}
function resultTone(s: string): "green" | "red" | "amber" | "slate" {
  if (s === "passed") return "green";
  if (s === "failed") return "red";
  if (s === "partial") return "amber";
  return "slate";
}

export function JobPermits({ jobId, permits }: { jobId: string; permits: Permit[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState("Electrical");
  const [num, setNum] = useState("");
  const [authority, setAuthority] = useState("");
  const [status, setStatus] = useState("applied");
  const [applied, setApplied] = useState("");
  const [fee, setFee] = useState(0);
  const [inspDate, setInspDate] = useState("");
  const [inspector, setInspector] = useState("");
  const [result, setResult] = useState("pending");
  const [notes, setNotes] = useState("");

  function add() {
    setError(null);
    start(async () => {
      const res = await createPermit({
        job_id: jobId, type, permit_number: num, authority, status,
        applied_date: applied || null, fee, inspection_date: inspDate || null,
        inspector, inspection_result: result, notes,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setNum(""); setAuthority(""); setApplied(""); setFee(0); setInspDate(""); setInspector(""); setNotes("");
      setAdding(false);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{permits.length} permit{permits.length === 1 ? "" : "s"}</div>
        <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}><Plus className="h-3.5 w-3.5" /> Add permit</Button>
      </div>

      {adding && (
        <div className="mb-3 space-y-3 rounded-lg border border-slate-200 p-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><Label htmlFor="p-type">Type</Label><Select id="p-type" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
            <div><Label htmlFor="p-num">Permit #</Label><Input id="p-num" value={num} onChange={(e) => setNum(e.target.value)} /></div>
            <div><Label htmlFor="p-auth">Authority</Label><Input id="p-auth" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="e.g. Washoe County" /></div>
            <div><Label htmlFor="p-status">Status</Label><Select id="p-status" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
            <div><Label htmlFor="p-applied">Applied date</Label><Input id="p-applied" type="date" value={applied} onChange={(e) => setApplied(e.target.value)} /></div>
            <div><Label htmlFor="p-fee">Fee</Label><NumberInput id="p-fee" value={fee} onValueChange={setFee} /></div>
            <div><Label htmlFor="p-idate">Inspection date</Label><Input id="p-idate" type="date" value={inspDate} onChange={(e) => setInspDate(e.target.value)} /></div>
            <div><Label htmlFor="p-insp">Inspector</Label><Input id="p-insp" value={inspector} onChange={(e) => setInspector(e.target.value)} /></div>
            <div><Label htmlFor="p-res">Inspection result</Label><Select id="p-res" value={result} onChange={(e) => setResult(e.target.value)}>{RESULTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
          </div>
          <div><Label htmlFor="p-notes">Notes</Label><Textarea id="p-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={pending}>{pending ? "Saving…" : "Save permit"}</Button>
          </div>
        </div>
      )}

      {permits.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No permits yet. Add one to track applications & inspections.</p>
      ) : (
        <ul className="space-y-2">
          {permits.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start gap-3">
                <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-slate-900">{p.type}</span>
                    {p.permit_number && <span className="font-mono text-xs text-slate-500">#{p.permit_number}</span>}
                    {p.authority && <span className="text-xs text-slate-400">· {p.authority}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                    {p.applied_date && <span>Applied {formatDate(p.applied_date)}</span>}
                    {p.inspection_date && <span>Inspection {formatDate(p.inspection_date)}</span>}
                    {p.inspector && <span>· {p.inspector}</span>}
                    {Number(p.fee) > 0 && <span>· ${Number(p.fee).toFixed(2)}</span>}
                  </div>
                  {p.notes && <div className="mt-1 whitespace-pre-wrap text-xs text-slate-500">{p.notes}</div>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Select
                    value={p.status}
                    className="h-7 w-40 text-xs"
                    onChange={(e) => start(async () => { await updatePermit(p.id, { status: e.target.value, job_id: jobId }); router.refresh(); })}
                  >
                    {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                  <div className="flex items-center gap-2">
                    <Badge tone={statusTone(p.status)}>{p.status.replace("_", " ")}</Badge>
                    <Badge tone={resultTone(p.inspection_result)}>{p.inspection_result}</Badge>
                    <button onClick={() => start(async () => { await deletePermit(p.id, jobId); router.refresh(); })} className="text-slate-400 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
