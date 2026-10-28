"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Sparkles, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import {
  createMaterialList,
  generateMaterialDraft,
  type DraftMaterial,
} from "./actions";
import { jobLabel } from "@/lib/schedule-options";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

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
  const [mDesc, setMDesc] = useState("");
  const [mQty, setMQty] = useState(1);
  const [mUnit, setMUnit] = useState("ea");
  const [error, setError] = useState<string | null>(null);

  function addManual() {
    if (!mDesc.trim()) return;
    setItems((p) => [
      ...p,
      { description: mDesc.trim(), part_number: null, quantity: mQty || 1, unit: mUnit || "ea", vendor: null, est_cost: null }, // no money on a checklist (2026-10-15)
    ]);
    setMDesc("");
    setMQty(1);
    setMUnit("ea");
  }
  const [generating, startGen] = useTransition();
  const [saving, startSave] = useTransition();
  const router = useRouter();
  const t = translator(useLang());

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
      if (!res.ok) return setError(res.error ?? t("mt_couldNotSave"));
      setOpen(false);
      if (res.id) router.push(`/materials/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> {t("mt_newList")}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("mt_newMaterialList")}
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={onSave}
            saving={saving}
            disabled={!name.trim()}
            saveLabel={t("mt_createList")}
            cancelLabel={t("mt_cancel")}
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ml-name">{t("mt_listName")}</Label>
              <Input
                id="ml-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("mt_listNamePlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="ml-job">{t("mt_jobOptional")}</Label>
              <Select id="ml-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">{t("mt_noneOption")}</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {jobLabel(j)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="rounded-lg border border-brand/30 bg-brand-light/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" />
              <span className="text-sm font-semibold text-slate-900">
                {t("mt_generateFromScope")}
              </span>
            </div>
            <Textarea
              rows={2}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder={t("mt_scopePlaceholder")}
            />
            <Button
              size="sm"
              className="mt-2"
              onClick={onGenerate}
              disabled={generating}
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("mt_generating")}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> {t("mt_generateItems")}
                </>
              )}
            </Button>
          </div>

          {/* Or add items by hand */}
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 text-sm font-semibold text-slate-900">{t("mt_addAnItemHeading")}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Input value={mDesc} onChange={(e) => setMDesc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addManual())} placeholder={t("mt_itemPlaceholder")} className="min-w-[160px] flex-1" />
              <NumberInput value={mQty} onValueChange={setMQty} className="w-16 text-center" placeholder={t("mt_qty")} />
              <Input value={mUnit} onChange={(e) => setMUnit(e.target.value)} className="w-14" placeholder={t("mt_ea")} />
              <Button size="sm" variant="outline" onClick={addManual} disabled={!mDesc.trim()}>
                <Plus className="h-3.5 w-3.5" /> {t("mt_add")}
              </Button>
            </div>
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
                      <td className="px-2 py-1.5 text-right">
                        <button
                          onClick={() =>
                            setItems((p) => p.filter((_, i) => i !== idx))
                          }
                          className="text-slate-400 hover:text-red-600"
                          aria-label={t("mt_remove")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-between border-t border-slate-100 px-3 py-2 text-xs font-medium text-slate-700">
                <span>{fillText(t("mt_nItems"), { n: String(items.length) })}</span>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
