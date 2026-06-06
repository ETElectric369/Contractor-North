"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Sparkles, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import {
  createMaterialList,
  generateMaterialDraft,
  type DraftMaterial,
} from "./actions";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

export function NewListButton({ jobs }: { jobs: JobOption[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [jobId, setJobId] = useState("");
  const [scope, setScope] = useState("");
  const [items, setItems] = useState<DraftMaterial[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generating, startGen] = useTransition();
  const [saving, startSave] = useTransition();
  const router = useRouter();

  const estTotal = items.reduce(
    (s, i) => s + (i.est_cost ?? 0) * i.quantity,
    0,
  );

  function onGenerate() {
    setError(null);
    startGen(async () => {
      const res = await generateMaterialDraft(scope);
      if (!res.ok) return setError(res.error);
      setItems(res.items);
      if (!name && scope) setName(scope.slice(0, 50));
    });
  }

  function onSave() {
    setError(null);
    startSave(async () => {
      const res = await createMaterialList({
        name,
        job_id: jobId || null,
        items,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      if (res.id) router.push(`/materials/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New list
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="New material list">
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ml-name">List name</Label>
              <Input
                id="ml-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Panel upgrade materials"
              />
            </div>
            <div>
              <Label htmlFor="ml-job">Job (optional)</Label>
              <Select id="ml-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">— None —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.job_number} · {j.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="rounded-lg border border-brand/30 bg-brand-light/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" />
              <span className="text-sm font-semibold text-slate-900">
                Generate from a scope
              </span>
            </div>
            <Textarea
              rows={2}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="e.g. Rough-in 4 bedrooms: outlets, switches, smoke detectors, 14/2 & 12/2 wire."
            />
            <Button
              size="sm"
              className="mt-2"
              onClick={onGenerate}
              disabled={generating}
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Generate items
                </>
              )}
            </Button>
          </div>

          {items.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {items.map((it, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-1.5 text-slate-700">{it.description}</td>
                      <td className="px-2 py-1.5 text-right text-slate-500">
                        {it.quantity} {it.unit}
                      </td>
                      <td className="px-2 py-1.5 text-right text-slate-600">
                        {it.est_cost != null ? formatCurrency(it.est_cost) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          onClick={() =>
                            setItems((p) => p.filter((_, i) => i !== idx))
                          }
                          className="text-slate-400 hover:text-red-600"
                          aria-label="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-between border-t border-slate-100 px-3 py-2 text-xs font-medium text-slate-700">
                <span>{items.length} items · est. material cost</span>
                <span>{formatCurrency(estTotal)}</span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Create list"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
