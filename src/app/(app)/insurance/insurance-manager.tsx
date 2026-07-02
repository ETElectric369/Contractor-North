"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Paperclip, Plus, Pencil, Trash2, Umbrella, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { createClient } from "@/lib/supabase/client";
import { createCompliance, updateCompliance, deleteCompliance, setComplianceFile } from "../compliance/actions";
import { daysUntil, expiryBadge, type ComplianceItem } from "../compliance/compliance-manager";
import { INSURANCE_TYPES } from "@/lib/compliance-types";

type InsuranceItem = ComplianceItem & { file_url?: string | null; signedUrl?: string | null };

/** Certificates ride the private "documents" bucket (org-folder RLS, 0013). */
async function uploadCertificate(orgId: string, file: File): Promise<string> {
  if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} is over 15 MB.`);
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${orgId}/insurance/${Date.now()}-${safe}`;
  const supabase = createClient();
  const { error } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export function InsuranceManager({ items, orgId }: { items: InsuranceItem[]; orgId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [certFile, setCertFile] = useState<File | null>(null);
  const certInputRef = useRef<HTMLInputElement>(null);
  const editCertRef = useRef<HTMLInputElement>(null);

  const [type, setType] = useState("General Liability");
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
    if (!name.trim()) return setError("Carrier / policy name is required.");
    start(async () => {
      let file_url: string | null = null;
      if (certFile) {
        try {
          file_url = await uploadCertificate(orgId, certFile);
        } catch (err: any) {
          return setError(err?.message ?? "Certificate upload failed.");
        }
      }
      const res = await createCompliance({ type, name, policy_number: policy, amount, issued_date: issued || null, expires_date: expires || null, notes, file_url });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setName(""); setPolicy(""); setAmount(0); setIssued(""); setExpires(""); setNotes(""); setCertFile(null);
      setAdding(false);
      router.refresh();
    });
  }

  function attachTo(item: InsuranceItem, file: File) {
    setError(null);
    start(async () => {
      try {
        const path = await uploadCertificate(orgId, file);
        const res = await setComplianceFile(item.id, path);
        if (!res.ok) throw new Error(res.error);
        toast(item.file_url ? "Certificate replaced" : "Certificate attached", "success");
        router.refresh();
      } catch (err: any) {
        toast(err?.message ?? "Certificate upload failed.", "error");
      }
    });
  }

  function removeCert(item: InsuranceItem) {
    if (!confirm("Remove the attached certificate?")) return;
    start(async () => {
      const res = await setComplianceFile(item.id, null);
      if (!res.ok) { toast(res.error ?? "Couldn't remove — try again.", "error"); return; }
      toast("Certificate removed", "success");
      router.refresh();
    });
  }

  function saveEdit() {
    if (!editing) return;
    setError(null);
    if (!eName.trim()) return setError("Carrier / policy name is required.");
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
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAdding((a) => !a)}><Plus className="h-3.5 w-3.5" /> Add policy</Button>
      </div>

      {adding && (
        <Card className="space-y-3 p-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><Label htmlFor="i-type">Policy type</Label><Select id="i-type" value={type} onChange={(e) => setType(e.target.value)}>{INSURANCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
            <div className="col-span-2 sm:col-span-1"><Label htmlFor="i-name">Carrier / name *</Label><Input id="i-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. State Farm" /></div>
            <div><Label htmlFor="i-policy">Policy #</Label><Input id="i-policy" value={policy} onChange={(e) => setPolicy(e.target.value)} /></div>
            <div><Label htmlFor="i-amount">Annual premium</Label><NumberInput id="i-amount" value={amount} onValueChange={setAmount} /></div>
            <div><Label htmlFor="i-issued">Effective</Label><Input id="i-issued" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} /></div>
            <div><Label htmlFor="i-expires">Expires</Label><Input id="i-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
          </div>
          <div><Label htmlFor="i-notes">Notes</Label><Textarea id="i-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Coverage limit, agent, renewal contact…" /></div>
          <div>
            <Label htmlFor="i-cert">Certificate (PDF or photo)</Label>
            <input ref={certInputRef} id="i-cert" type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => setCertFile(e.target.files?.[0] ?? null)} />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => certInputRef.current?.click()}>
                <Paperclip className="h-3.5 w-3.5" /> {certFile ? "Change file" : "Attach file"}
              </Button>
              {certFile && (
                <span className="flex min-w-0 items-center gap-1 text-xs text-slate-500">
                  <span className="truncate">{certFile.name}</span>
                  <button onClick={() => { setCertFile(null); if (certInputRef.current) certInputRef.current.value = ""; }} className="text-slate-300 hover:text-red-600" title="Remove"><X className="h-3.5 w-3.5" /></button>
                </span>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          Track your policies — workers' comp, general liability, auto — with renewal alerts so coverage never lapses.
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
                      <Umbrella className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="font-medium text-slate-900">{c.name}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                      {c.type}{c.policy_number ? ` · #${c.policy_number}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEdit(c)} className="text-slate-300 hover:text-slate-700" title="Edit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => { if (!confirm("Delete this policy?")) return; start(async () => { const res = await deleteCompliance(c.id); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Policy deleted", "success"); router.refresh(); }); }} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <Badge tone={b.tone}>{b.label}</Badge>
                  {c.expires_date && <span>Renews {formatDate(c.expires_date)}</span>}
                  {Number(c.amount) > 0 && <span>· {formatCurrency(c.amount)}/yr</span>}
                  {c.signedUrl && (
                    <a href={c.signedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-sky-700 hover:underline">
                      <FileText className="h-3.5 w-3.5" /> Certificate
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
        title="Edit policy"
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={saveEdit} saving={pending} disabled={!eName.trim()} />}
      >
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><Label htmlFor="ie-type">Policy type</Label><Select id="ie-type" value={eType} onChange={(e) => setEType(e.target.value)}>{INSURANCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
          <div className="col-span-2 sm:col-span-1"><Label htmlFor="ie-name">Carrier / name *</Label><Input id="ie-name" value={eName} onChange={(e) => setEName(e.target.value)} placeholder="e.g. State Farm" /></div>
          <div><Label htmlFor="ie-policy">Policy #</Label><Input id="ie-policy" value={ePolicy} onChange={(e) => setEPolicy(e.target.value)} /></div>
          <div><Label htmlFor="ie-amount">Annual premium</Label><NumberInput id="ie-amount" value={eAmount} onValueChange={setEAmount} /></div>
          <div><Label htmlFor="ie-issued">Effective</Label><Input id="ie-issued" type="date" value={eIssued} onChange={(e) => setEIssued(e.target.value)} /></div>
          <div><Label htmlFor="ie-expires">Expires</Label><Input id="ie-expires" type="date" value={eExpires} onChange={(e) => setEExpires(e.target.value)} /></div>
        </div>
        <div className="mt-3"><Label htmlFor="ie-notes">Notes</Label><Textarea id="ie-notes" rows={2} value={eNotes} onChange={(e) => setENotes(e.target.value)} placeholder="Coverage limit, agent, renewal contact…" /></div>
        {editing && (
          <div className="mt-3">
            <Label>Certificate</Label>
            <input ref={editCertRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && editing) attachTo(editing, f); e.target.value = ""; }} />
            <div className="flex flex-wrap items-center gap-2">
              {(editing as InsuranceItem).signedUrl && (
                <a href={(editing as InsuranceItem).signedUrl!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-sky-700 hover:underline">
                  <FileText className="h-4 w-4" /> View current
                </a>
              )}
              <Button size="sm" variant="outline" onClick={() => editCertRef.current?.click()} disabled={pending}>
                <Paperclip className="h-3.5 w-3.5" /> {(editing as InsuranceItem).file_url ? "Replace" : "Attach file"}
              </Button>
              {(editing as InsuranceItem).file_url && (
                <Button size="sm" variant="outline" onClick={() => removeCert(editing as InsuranceItem)} disabled={pending}>
                  <X className="h-3.5 w-3.5" /> Remove
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">Uploads save immediately, even before you hit Save.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
