"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { saveCodeTemplate, deleteCodeTemplate } from "./code-template-actions";

type Template = { id: string; name: string; codes: string[] };
type Code = { code: string; description: string };

/** Manage job-code templates: named groups of codes per job type. Applying a template
 *  to a job narrows the crew's clock-in/out code picker to those codes. */
export function CodeTemplatesManager({ templates, codes }: { templates: Template[]; codes: Code[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openNew() { setEditing("new"); setName(""); setSelected([]); setError(null); }
  function openEdit(t: Template) { setEditing(t); setName(t.name); setSelected(t.codes); setError(null); }
  function toggle(code: string) {
    setSelected((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]));
  }

  function save() {
    setError(null);
    start(async () => {
      const res = await saveCodeTemplate({ id: editing && editing !== "new" ? editing.id : null, name, codes: selected });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setEditing(null);
      router.refresh();
    });
  }
  function remove(id: string) {
    if (!confirm("Delete this template?")) return;
    start(async () => {
      await deleteCodeTemplate(id);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Group your job codes by type of job. Apply a template to a job (on the job&apos;s edit screen) and the crew&apos;s
        clock-in / clock-out code picker shows only those codes — so they pick the right one.
      </p>
      {templates.length === 0 ? (
        <p className="text-xs text-slate-400">No templates yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {templates.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 font-medium text-slate-800">
                  <Layers className="h-4 w-4 text-slate-400" /> {t.name}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.codes.map((c) => (
                    <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{c}</span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button onClick={() => openEdit(t)} className="text-slate-400 hover:text-brand" aria-label="Edit template"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => remove(t.id)} className="text-slate-400 hover:text-red-600" aria-label="Delete template"><Trash2 className="h-4 w-4" /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" onClick={openNew}><Plus className="h-4 w-4" /> New Template</Button>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing && editing !== "new" ? "Edit template" : "New template"}
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={save} saving={pending} saveLabel="Save template" disabled={!name.trim() || !selected.length} />}
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="tname">Template name</Label>
            <Input id="tname" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Full deck build" />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="mb-0">Codes for this job type</Label>
              {codes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected(selected.length === codes.length ? [] : codes.map((c) => c.code))}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  {selected.length === codes.length ? "Clear all" : "Select all"}
                </button>
              )}
            </div>
            {codes.length === 0 ? (
              <p className="text-xs text-slate-400">This org has no job codes yet.</p>
            ) : (
              <div className="mt-1 grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
                {codes.map((c) => (
                  <label key={c.code} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                    <input type="checkbox" checked={selected.includes(c.code)} onChange={() => toggle(c.code)} className="h-4 w-4 rounded border-slate-300 text-brand" />
                    <span className="font-medium text-slate-700">{c.code}</span>
                    <span className="truncate text-xs text-slate-400">{c.description}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-slate-400">{selected.length} selected</p>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </div>
  );
}
