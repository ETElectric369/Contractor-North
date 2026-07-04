"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/page-header";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatDate } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { createCompliance, updateCompliance, deleteCompliance } from "../compliance/actions";
import { daysUntil, type ComplianceItem } from "../compliance/compliance-manager";
import { AUDIT_TYPES } from "@/lib/compliance-types";

function dueBadge(date: string | null) {
  const d = daysUntil(date);
  if (d === null) return { tone: "slate" as const, label: "No follow-up" };
  if (d < 0) return { tone: "red" as const, label: `Overdue ${-d}d` };
  if (d <= 30) return { tone: "amber" as const, label: `Due in ${d}d` };
  return { tone: "green" as const, label: `Due ${d}d` };
}

export function AuditsManager({ items }: { items: ComplianceItem[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState("Safety Audit");
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [date, setDate] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [findings, setFindings] = useState("");

  const [editing, setEditing] = useState<ComplianceItem | null>(null);
  const [eType, setEType] = useState("");
  const [eName, setEName] = useState("");
  const [eRef, setERef] = useState("");
  const [eDate, setEDate] = useState("");
  const [eNextDue, setENextDue] = useState("");
  const [eFindings, setEFindings] = useState("");

  function openEdit(c: ComplianceItem) {
    setError(null);
    setEditing(c);
    setEType(c.type);
    setEName(c.name);
    setERef(c.policy_number ?? "");
    setEDate(c.issued_date ?? "");
    setENextDue(c.expires_date ?? "");
    setEFindings(c.notes ?? "");
  }

  function add() {
    setError(null);
    if (!name.trim()) return setError("Subject / auditor is required.");
    start(async () => {
      const res = await createCompliance({ type, name, policy_number: ref, issued_date: date || null, expires_date: nextDue || null, notes: findings });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setName(""); setRef(""); setDate(""); setNextDue(""); setFindings("");
      setAdding(false);
      router.refresh();
    });
  }

  function saveEdit() {
    if (!editing) return;
    setError(null);
    if (!eName.trim()) return setError("Subject / auditor is required.");
    start(async () => {
      const res = await updateCompliance(editing.id, { type: eType, name: eName, policy_number: eRef, issued_date: eDate || null, expires_date: eNextDue || null, notes: eFindings });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setEditing(null);
      router.refresh();
    });
  }

  const sorted = [...items].sort((a, b) => {
    const da = daysUntil(a.expires_date), db = daysUntil(b.expires_date);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAdding((a) => !a)}><Plus className="h-3.5 w-3.5" /> Log audit</Button>
      </div>

      {adding && (
        <Card className="space-y-3 p-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><Label htmlFor="a-type">Audit type</Label><Select id="a-type" value={type} onChange={(e) => setType(e.target.value)}>{AUDIT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
            <div className="col-span-2 sm:col-span-1"><Label htmlFor="a-name">Subject / auditor *</Label><Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OSHA inspector, Internal" /></div>
            <div><Label htmlFor="a-ref">Report / ref #</Label><Input id="a-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
            <div><Label htmlFor="a-date">Audit date</Label><Input id="a-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div><Label htmlFor="a-due">Next due / follow-up</Label><Input id="a-due" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></div>
          </div>
          <div><Label htmlFor="a-find">Findings / result</Label><Textarea id="a-find" rows={2} value={findings} onChange={(e) => setFindings(e.target.value)} placeholder="Pass / fail, corrective actions, deadlines…" /></div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No audits logged yet"
          description="Log safety, OSHA, insurance, and financial audits — with their findings and the next follow-up date."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sorted.map((c) => {
            const b = dueBadge(c.expires_date);
            return (
              <Card key={c.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ClipboardCheck className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="font-medium text-slate-900">{c.name}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {c.type}{c.policy_number ? ` · #${c.policy_number}` : ""}
                      {c.issued_date ? ` · ${formatDate(c.issued_date)}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEdit(c)} className="text-slate-300 hover:text-slate-700" title="Edit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => { if (!confirm("Delete this audit?")) return; start(async () => { const res = await deleteCompliance(c.id); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Audit deleted", "success"); router.refresh(); }); }} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <Badge tone={b.tone}>{b.label}</Badge>
                  {c.expires_date && <span>Follow-up {formatDate(c.expires_date)}</span>}
                </div>
                {c.notes && <div className="mt-2 whitespace-pre-wrap border-t border-slate-100 pt-2 text-xs text-slate-500">{c.notes}</div>}
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit audit"
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={saveEdit} saving={pending} disabled={!eName.trim()} />}
      >
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><Label htmlFor="ae-type">Audit type</Label><Select id="ae-type" value={eType} onChange={(e) => setEType(e.target.value)}>{AUDIT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
          <div className="col-span-2 sm:col-span-1"><Label htmlFor="ae-name">Subject / auditor *</Label><Input id="ae-name" value={eName} onChange={(e) => setEName(e.target.value)} placeholder="e.g. OSHA inspector, Internal" /></div>
          <div><Label htmlFor="ae-ref">Report / ref #</Label><Input id="ae-ref" value={eRef} onChange={(e) => setERef(e.target.value)} /></div>
          <div><Label htmlFor="ae-date">Audit date</Label><Input id="ae-date" type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} /></div>
          <div><Label htmlFor="ae-due">Next due / follow-up</Label><Input id="ae-due" type="date" value={eNextDue} onChange={(e) => setENextDue(e.target.value)} /></div>
        </div>
        <div className="mt-3"><Label htmlFor="ae-find">Findings / result</Label><Textarea id="ae-find" rows={2} value={eFindings} onChange={(e) => setEFindings(e.target.value)} placeholder="Pass / fail, corrective actions, deadlines…" /></div>
      </Modal>
    </div>
  );
}
