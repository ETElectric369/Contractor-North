"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { saveJobCode, setJobCodeActive, deleteJobCode } from "./actions";

type JobCode = {
  id: string;
  code: string;
  description: string;
  billable: boolean;
  active: boolean;
};

/** Manage the org's job codes (the cost/labor codes the timeclock uses).
 *  Add / edit inline (Pencil) / soft-toggle active / delete. */
export function JobCodesManager({ jobCodes }: { jobCodes: JobCode[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<JobCode | "new" | null>(null);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [billable, setBillable] = useState(true);
  const [active, setActive] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openNew() {
    setEditing("new");
    setCode("");
    setDescription("");
    setBillable(true);
    setActive(true);
    setError(null);
  }
  function openEdit(c: JobCode) {
    setEditing(c);
    setCode(c.code);
    setDescription(c.description);
    setBillable(c.billable);
    setActive(c.active);
    setError(null);
  }

  function save() {
    setError(null);
    if (!code.trim()) return setError("Code is required.");
    if (!description.trim()) return setError("Description is required.");
    start(async () => {
      const res = await saveJobCode({
        id: editing && editing !== "new" ? editing.id : null,
        code,
        description,
        billable,
        active,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setEditing(null);
      router.refresh();
    });
  }

  function toggleActive(c: JobCode) {
    start(async () => {
      await setJobCodeActive(c.id, !c.active);
      router.refresh();
    });
  }

  function remove(c: JobCode) {
    if (!confirm(`Delete job code "${c.code}"?`)) return;
    start(async () => {
      await deleteJobCode(c.id);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        The cost / labor codes your crew picks on clock-in. Inactive codes drop out of the timeclock picker
        but stay on past entries.
      </p>
      {jobCodes.length === 0 ? (
        <p className="text-xs text-slate-400">No job codes yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {jobCodes.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Tag className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="font-mono font-medium text-slate-800">{c.code}</span>
              <span className="min-w-0 flex-1 truncate text-slate-600">{c.description}</span>
              {!c.billable && <Badge tone="slate">non-billable</Badge>}
              <button
                onClick={() => toggleActive(c)}
                className={c.active ? "text-green-600 hover:text-slate-400" : "text-slate-400 hover:text-green-600"}
                title={c.active ? "Active — click to deactivate" : "Inactive — click to activate"}
                aria-label={c.active ? "Deactivate code" : "Activate code"}
              >
                <Badge tone={c.active ? "green" : "slate"}>{c.active ? "active" : "inactive"}</Badge>
              </button>
              <button onClick={() => openEdit(c)} className="text-slate-400 hover:text-brand" title="Edit" aria-label="Edit job code">
                <Pencil className="h-4 w-4" />
              </button>
              <button onClick={() => remove(c)} className="text-slate-400 hover:text-red-600" title="Delete" aria-label="Delete job code">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" onClick={openNew}><Plus className="h-4 w-4" /> New job code</Button>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing && editing !== "new" ? "Edit job code" : "New job code"}
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={save} saving={pending} saveLabel="Save code" disabled={!code.trim() || !description.trim()} />}
      >
        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="w-32">
              <Label htmlFor="jc-code">Code</Label>
              <Input id="jc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. T&M" />
            </div>
            <div className="flex-1">
              <Label htmlFor="jc-desc">Description</Label>
              <Input id="jc-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Time & materials" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            Billable
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            Active (shows in the timeclock picker)
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </div>
  );
}
