"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { formatDate } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { createPermit, updatePermit, deletePermit } from "../../permits/actions";
import { EditPermitButton } from "../../permits/edit-permit-button";
// Canonical permit options + tones (the inline dropdown now writes the same status keys the
// standalone editor uses — was "scheduled" here vs "inspection_scheduled" there).
import { PERMIT_TYPES as TYPES, PERMIT_PICKABLE_STATUSES as STATUSES, permitStatusOptions } from "@/lib/permit-options";
import type { PermitInspection } from "@/lib/permit-inspections";
import { PermitInspections } from "./permit-inspections";

/** THE THREE SUPERSEDED COLUMNS ARE NOT HERE (0378). permits.inspection_date / inspector /
 *  inspection_result carried ONE inspection inline, and a permit needs several from different
 *  authorities: they live in permit_inspections now, drawn by <PermitInspections> on each card.
 *  permits.authority STAYS and keeps its own meaning — who ISSUED the permit. */
export interface Permit {
  id: string;
  permit_number: string | null;
  type: string;
  authority: string | null;
  status: string;
  applied_date: string | null;
  issued_date: string | null;
  fee: number;
  notes: string | null;
}


/** `canAdd` = the Permits & Inspections switch (0352). Off, Add Permit goes; the permits already on
 *  the job stay listed and editable (the tab shows the Off line above them). */
export function JobPermits({
  jobId,
  permits,
  canAdd = true,
  inspections = [],
  inspectionsUnread = false,
  todayStr = "",
  authorities = [],
}: {
  jobId: string;
  permits: Permit[];
  canAdd?: boolean;
  /** Every inspection on this job's permits (0378) in one list; each card takes its own. */
  inspections?: PermitInspection[];
  /** The read failed: each card says so rather than reading as a permit with no inspections. */
  inspectionsUnread?: boolean;
  /** The COMPANY's today, from the server: the gate is read against it, never the browser's clock. */
  todayStr?: string;
  /** The authorities this company has called before, suggested under the free text box. */
  authorities?: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState("Electrical");
  const [num, setNum] = useState("");
  const [authority, setAuthority] = useState("");
  const [status, setStatus] = useState("applied");
  const [applied, setApplied] = useState("");
  const [fee, setFee] = useState(0);
  const [notes, setNotes] = useState("");
  const [portalUrl, setPortalUrl] = useState("");

  function add() {
    setError(null);
    start(async () => {
      const res = await createPermit({
        job_id: jobId, type, permit_number: num, authority, status,
        applied_date: applied || null, fee, notes, portal_url: portalUrl,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setNum(""); setAuthority(""); setApplied(""); setFee(0); setNotes(""); setPortalUrl("");
      setAdding(false);
      toast("Permit added", "success");
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">{permits.length} permit{permits.length === 1 ? "" : "s"}</div>
        {canAdd && <Button variant="outline" onClick={() => setAdding((a) => !a)}><Plus className="h-3.5 w-3.5" /> Add Permit</Button>}
      </div>

      {canAdd && adding && (
        <div className="mb-3 space-y-3 rounded-lg border border-slate-200 p-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><Label htmlFor="p-type">Type</Label><Select id="p-type" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
            <div><Label htmlFor="p-num">Permit #</Label><Input id="p-num" value={num} onChange={(e) => setNum(e.target.value)} /></div>
            <div><Label htmlFor="p-auth">Authority</Label><Input id="p-auth" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="e.g. County Building Department" /></div>
            <div><Label htmlFor="p-status">Status</Label><Select id="p-status" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
            <div><Label htmlFor="p-applied">Applied date</Label><Input id="p-applied" type="date" value={applied} onChange={(e) => setApplied(e.target.value)} /></div>
            <div><Label htmlFor="p-fee">Fee</Label><NumberInput id="p-fee" value={fee} onValueChange={setFee} /></div>
          </div>
          <div>
            <Label htmlFor="p-portal">City portal link</Label>
            <Input id="p-portal" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} placeholder="https://… (the authority's permit-status page)" />
          </div>
          <div><Label htmlFor="p-notes">Notes</Label><Textarea id="p-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          {/* The inspections are not fields on the permit any more (0378): save the permit, then Add
              Inspection on its own card books each authority that has to come. One permit, many visits. */}
          <p className="text-xs text-slate-500">Save it, then add the inspections it needs on the permit&rsquo;s own card.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={pending}>{pending ? "Saving…" : "Save Permit"}</Button>
          </div>
        </div>
      )}

      {permits.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No permits yet. Add one to track applications & inspections.</p>
      ) : (
        <ul className="space-y-2">
          {permits.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-200 p-3">
              {/* ONE COLUMN. The status select, Edit and Delete sat in a fixed column BESIDE the body:
                  on a 390-px phone its 160-px select left the body ~150 px, and every chip, line and
                  button stacked down the left edge (Erik, 2026-10-15: "all crammed onto the left side
                  lined up vertically, unreadable"). Nothing of fixed width stands beside the body now:
                  the controls are a wrapping row under the title, and the select is full width on a
                  phone. The status's colour is carried by the inspections' own line below it. */}
              <div className="flex items-start gap-3">
                <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-slate-900">{p.type}</span>
                    {p.permit_number && <span className="font-mono text-xs text-slate-500">#{p.permit_number}</span>}
                    {p.authority && <span className="text-xs text-slate-400">· {p.authority}</span>}
                    {(p as any).portal_url && (
                      <a
                        href={(p as any).portal_url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                      >
                        Check with City ↗
                      </a>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                    {p.applied_date && <span>Applied {formatDate(p.applied_date)}</span>}
                    {Number(p.fee) > 0 && <span>· ${Number(p.fee).toFixed(2)}</span>}
                  </div>
                  {p.notes && <div className="mt-1 whitespace-pre-wrap text-xs text-slate-500">{p.notes}</div>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {/* THE PERMIT'S OWN PAPERWORK (lib/permit-options, PERMIT_PICKABLE_STATUSES): what its
                        inspections say is read here, never picked here. */}
                    <Select
                      value={p.status}
                      aria-label="Permit status"
                      className="h-11 w-full text-sm sm:h-9 sm:w-48 sm:text-xs"
                      onChange={(e) => { const v = e.target.value; start(async () => { const res = await updatePermit(p.id, { status: v, job_id: jobId }); if (!res?.ok) { toast(res?.error ?? "Couldn't update status — try again.", "error"); return; } router.refresh(); }); }}
                    >
                      {permitStatusOptions(p.status).map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
                    </Select>
                    <EditPermitButton permit={p as any} jobId={jobId} />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete this permit"
                      title="Delete"
                      className="min-h-11 min-w-11 text-slate-400 hover:text-red-600"
                      onClick={() => { if (confirm("Delete this permit?")) start(async () => { const res = await deletePermit(p.id, jobId); if (!res?.ok) { toast(res?.error ?? "Couldn't delete permit — try again.", "error"); return; } toast("Permit deleted", "success"); router.refresh(); }); }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {/* WHO STILL HAS TO COME (0378): this permit's own inspections, in the order they come. */}
                  <PermitInspections
                    permitId={p.id}
                    rows={(inspections ?? []).filter((i) => i.permit_id === p.id)}
                    todayStr={todayStr}
                    suggestions={authorities}
                    canWrite={canAdd}
                    unread={inspectionsUnread}
                    authority={p.authority}
                    permitStatus={p.status}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
