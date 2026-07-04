"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Plus, Pencil, Trash2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { createCompliance, updateCompliance, deleteCompliance } from "./actions";
import { ImportDocsButton } from "./import-docs-button";

export interface ComplianceItem {
  id: string;
  type: string;
  name: string;
  policy_number: string | null;
  amount: number;
  issued_date: string | null;
  expires_date: string | null;
  notes: string | null;
  /** Storage path + signed view link when a document was imported/attached. */
  file_url?: string | null;
  signedUrl?: string | null;
}

import { COMPLIANCE_TYPES as TYPES } from "@/lib/compliance-types";

export function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const d = new Date(date + "T00:00:00");
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export function expiryBadge(date: string | null) {
  const d = daysUntil(date);
  if (d === null) return { tone: "slate" as const, label: "No expiry" };
  if (d < 0) return { tone: "red" as const, label: `Expired ${-d}d ago` };
  if (d <= 30) return { tone: "red" as const, label: `Expires in ${d}d` };
  if (d <= 60) return { tone: "amber" as const, label: `Expires in ${d}d` };
  return { tone: "green" as const, label: `Active` };
}

export function ComplianceManager({ items, orgId }: { items: ComplianceItem[]; orgId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState("Contractor License");
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState("");
  const [amount, setAmount] = useState(0);
  const [issued, setIssued] = useState("");
  const [expires, setExpires] = useState("");
  const [notes, setNotes] = useState("");

  const [editing, setEditing] = useState<ComplianceItem | null>(null);
  const [eType, setEType] = useState("");
  const [eName, setEName] = useState("");
  const [ePolicy, setEPolicy] = useState("");
  const [eAmount, setEAmount] = useState(0);
  const [eIssued, setEIssued] = useState("");
  const [eExpires, setEExpires] = useState("");
  const [eNotes, setENotes] = useState("");

  function openEdit(c: ComplianceItem) {
    setError(null);
    setEditing(c);
    setEType(c.type);
    setEName(c.name);
    setEPolicy(c.policy_number ?? "");
    setEAmount(Number(c.amount) || 0);
    setEIssued(c.issued_date ?? "");
    setEExpires(c.expires_date ?? "");
    setENotes(c.notes ?? "");
  }

  function add() {
    setError(null);
    start(async () => {
      // Name is optional — the server defaults a blank one, so a save never blocks on typing.
      const res = await createCompliance({ type, name: name.trim() || "Untitled policy", policy_number: policy, amount, issued_date: issued || null, expires_date: expires || null, notes });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setName(""); setPolicy(""); setAmount(0); setIssued(""); setExpires(""); setNotes("");
      setAdding(false);
      router.refresh();
    });
  }

  function saveEdit() {
    if (!editing) return;
    setError(null);
    start(async () => {
      const res = await updateCompliance(editing.id, { type: eType, name: eName, policy_number: ePolicy, amount: eAmount, issued_date: eIssued || null, expires_date: eExpires || null, notes: eNotes });
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
      {/* flex-wrap + items-center so the 3 action buttons wrap as a neat group on
          a narrow phone instead of cramping/overflowing (bug: button alignment). */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ImportDocsButton orgId={orgId} page="Compliance" />
        <Button size="sm" onClick={() => setAdding((a) => !a)}><Plus className="h-3.5 w-3.5" /> Add Item</Button>
      </div>

      {adding && (
        <Card className="space-y-3 p-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><Label htmlFor="c-type">Type</Label><Select id="c-type" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
            <div className="col-span-2 sm:col-span-1"><Label htmlFor="c-name">Provider / name</Label><Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. State Farm GL (optional)" /></div>
            <div><Label htmlFor="c-policy">Policy / # </Label><Input id="c-policy" value={policy} onChange={(e) => setPolicy(e.target.value)} /></div>
            <div><Label htmlFor="c-amount">Annual cost</Label><NumberInput id="c-amount" value={amount} onValueChange={setAmount} /></div>
            <div><Label htmlFor="c-issued">Issued</Label><Input id="c-issued" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} /></div>
            <div><Label htmlFor="c-expires">Expires</Label><Input id="c-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
          </div>
          <div><Label htmlFor="c-notes">Notes</Label><Textarea id="c-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Agent, renewal contact, submission portal…" /></div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          Track insurance, workers' comp, bonds, and licenses here so nothing lapses.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sorted.map((c) => {
            const b = expiryBadge(c.expires_date);
            return (
              <Card key={c.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="font-medium text-slate-900">{c.name}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {c.type}{c.policy_number ? ` · #${c.policy_number}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEdit(c)} className="text-slate-300 hover:text-slate-700" title="Edit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => { if (!confirm("Delete this item?")) return; start(async () => { const res = await deleteCompliance(c.id); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Item deleted", "success"); router.refresh(); }); }} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <Badge tone={b.tone}>{b.label}</Badge>
                  {c.expires_date && <span>Renews {formatDate(c.expires_date)}</span>}
                  {Number(c.amount) > 0 && <span>· {formatCurrency(c.amount)}/yr</span>}
                  {c.signedUrl && (
                    <a href={c.signedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline">
                      <FileText className="h-3.5 w-3.5" /> Document
                    </a>
                  )}
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
        title="Edit item"
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={saveEdit} saving={pending} />}
      >
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><Label htmlFor="ce-type">Type</Label><Select id="ce-type" value={eType} onChange={(e) => setEType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
          <div className="col-span-2 sm:col-span-1"><Label htmlFor="ce-name">Provider / name</Label><Input id="ce-name" value={eName} onChange={(e) => setEName(e.target.value)} placeholder="e.g. State Farm GL (optional)" /></div>
          <div><Label htmlFor="ce-policy">Policy / # </Label><Input id="ce-policy" value={ePolicy} onChange={(e) => setEPolicy(e.target.value)} /></div>
          <div><Label htmlFor="ce-amount">Annual cost</Label><NumberInput id="ce-amount" value={eAmount} onValueChange={setEAmount} /></div>
          <div><Label htmlFor="ce-issued">Issued</Label><Input id="ce-issued" type="date" value={eIssued} onChange={(e) => setEIssued(e.target.value)} /></div>
          <div><Label htmlFor="ce-expires">Expires</Label><Input id="ce-expires" type="date" value={eExpires} onChange={(e) => setEExpires(e.target.value)} /></div>
        </div>
        <div className="mt-3"><Label htmlFor="ce-notes">Notes</Label><Textarea id="ce-notes" rows={2} value={eNotes} onChange={(e) => setENotes(e.target.value)} placeholder="Agent, renewal contact, submission portal…" /></div>
      </Modal>
    </div>
  );
}
