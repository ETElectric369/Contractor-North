"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Check, Star, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge } from "@/components/ui/badge";
import type { OrgSettings } from "@/lib/org-settings";
import {
  createTaxRate, updateTaxRate, setDefaultTaxRate, deleteTaxRate, updateOrgSettings,
  createPricingLevel, updatePricingLevel, setDefaultPricingLevel, deletePricingLevel,
} from "./actions";

interface TaxRate {
  id: string;
  name: string;
  rate: number;
  is_default: boolean;
}
interface PricingLevel {
  id: string;
  name: string;
  markup_pct: number;
  labor_rate: number | null;
  is_default: boolean;
}

export function TaxRatesManager({
  taxRates,
  pricingLevels = [],
  settings,
}: {
  taxRates: TaxRate[];
  pricingLevels?: PricingLevel[];
  settings: OrgSettings;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [rate, setRate] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [laborRate, setLaborRate] = useState(settings.default_labor_rate);
  const [mileageRate, setMileageRate] = useState(settings.mileage_rate);
  const [materialMarkup, setMaterialMarkup] = useState(settings.material_markup_percent);
  const [materialBuffer, setMaterialBuffer] = useState(settings.material_buffer_percent);
  const [savedLabor, setSavedLabor] = useState(false);

  const [levelName, setLevelName] = useState("");
  const [levelMarkup, setLevelMarkup] = useState(0);
  const [levelRate, setLevelRate] = useState<number | "">(""); // "" = blank = fall back to org default
  const [editingLevelId, setEditingLevelId] = useState<string | null>(null);

  function editLevel(l: PricingLevel) {
    setEditingLevelId(l.id);
    setLevelName(l.name);
    setLevelMarkup(Number(l.markup_pct));
    setLevelRate(l.labor_rate != null ? Number(l.labor_rate) : "");
  }
  function cancelEditLevel() {
    setEditingLevelId(null);
    setLevelName("");
    setLevelMarkup(0);
    setLevelRate("");
  }

  function addLevel() {
    if (!levelName.trim()) return;
    const labor_rate = levelRate === "" ? null : Number(levelRate);
    start(async () => {
      const res = editingLevelId
        ? await updatePricingLevel(editingLevelId, { name: levelName, markup_pct: levelMarkup, labor_rate })
        : await createPricingLevel({ name: levelName, markup_pct: levelMarkup, labor_rate, is_default: pricingLevels.length === 0 });
      if (!res.ok) { setError(res.error ?? "Could not save."); return; }
      cancelEditLevel();
      router.refresh();
    });
  }

  function editRate(t: TaxRate) {
    setError(null);
    setEditingId(t.id);
    setName(t.name);
    setRate(Number(t.rate));
  }
  function cancelEdit() {
    setEditingId(null);
    setName("");
    setRate(0);
    setError(null);
  }

  function add() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    start(async () => {
      const res = editingId
        ? await updateTaxRate(editingId, { name, rate })
        : await createTaxRate({ name, rate, is_default: taxRates.length === 0 });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      cancelEdit();
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h4 className="mb-2 text-sm font-semibold text-slate-900">Tax rates</h4>
        <p className="mb-3 text-sm text-slate-500">
          Add named rates for the areas you work (e.g. Reno vs Truckee). The default applies to new quotes & invoices.
        </p>
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        {taxRates.length > 0 && (
          <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {taxRates.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="flex-1 font-medium text-slate-900">{t.name}</span>
                <span className="text-slate-700">{Number(t.rate).toFixed(3)}%</span>
                {t.is_default ? (
                  <Badge tone="green">default</Badge>
                ) : (
                  <button
                    onClick={() => start(async () => { await setDefaultTaxRate(t.id); router.refresh(); })}
                    className="text-slate-400 hover:text-amber-500"
                    title="Make default"
                  >
                    <Star className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => editRate(t)}
                  className="text-slate-400 hover:text-brand"
                  title="Edit"
                  aria-label="Edit tax rate"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => { if (confirm("Delete this tax rate?")) start(async () => { await deleteTaxRate(t.id); if (editingId === t.id) cancelEdit(); router.refresh(); }); }}
                  className="text-slate-400 hover:text-red-600"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="tr-name">Name</Label>
            <Input id="tr-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Truckee" />
          </div>
          <div className="w-28">
            <Label htmlFor="tr-rate">Rate %</Label>
            <NumberInput id="tr-rate" value={rate} onValueChange={setRate} />
          </div>
          <Button size="sm" onClick={add} disabled={pending || !name.trim()}>
            {editingId ? <><Check className="h-3.5 w-3.5" /> Save</> : <><Plus className="h-3.5 w-3.5" /> Add</>}
          </Button>
          {editingId && (
            <Button size="sm" variant="outline" onClick={cancelEdit} disabled={pending} title="Cancel edit">
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-900">Defaults</h4>
        <div className="flex items-end gap-3">
          <div className="w-44">
            <Label htmlFor="fin-labor">Default labor rate ($/hr)</Label>
            <NumberInput id="fin-labor" value={laborRate} onValueChange={setLaborRate} />
          </div>
          <div className="w-44">
            <Label htmlFor="fin-mileage">Mileage rate ($/mi)</Label>
            <NumberInput id="fin-mileage" value={mileageRate} onValueChange={setMileageRate} />
          </div>
          <div className="w-44">
            <Label htmlFor="fin-markup">Materials markup (%)</Label>
            <NumberInput id="fin-markup" value={materialMarkup} onValueChange={setMaterialMarkup} />
          </div>
          <div className="w-44">
            <Label htmlFor="fin-buffer">AI estimate buffer (%)</Label>
            <NumberInput id="fin-buffer" value={materialBuffer} onValueChange={setMaterialBuffer} />
          </div>
          <Button
            size="sm"
            onClick={() => start(async () => { await updateOrgSettings({ default_labor_rate: laborRate, mileage_rate: mileageRate, material_markup_percent: materialMarkup, material_buffer_percent: materialBuffer }); setSavedLabor(true); setTimeout(() => setSavedLabor(false), 2000); })}
            disabled={pending}
          >
            Save
          </Button>
          {savedLabor && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Mileage rate is used only for the tax-report deduction estimate — payroll mileage is settled separately, by hand.
        </p>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-900">Pricing levels</h4>
        <p className="mb-3 text-sm text-slate-500">
          Customer tiers — each level's markup % sets price-list sell prices on quotes (e.g. Retail vs Trade/Builder), and an optional labor rate sets the estimator's $/hr for customers on that level. Assign a level on the customer's page.
        </p>
        {pricingLevels.length > 0 && (
          <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {pricingLevels.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="flex-1 font-medium text-slate-900">{l.name}</span>
                <span className="text-slate-700">{Number(l.markup_pct)}% markup{l.labor_rate != null ? ` · $${Number(l.labor_rate)}/hr` : ""}</span>
                {l.is_default ? (
                  <Badge tone="green">default</Badge>
                ) : (
                  <button onClick={() => start(async () => { await setDefaultPricingLevel(l.id); router.refresh(); })} className="text-slate-400 hover:text-amber-500" title="Make default"><Star className="h-4 w-4" /></button>
                )}
                <button onClick={() => editLevel(l)} className="text-slate-400 hover:text-brand" title="Edit" aria-label="Edit pricing level"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => { if (confirm("Delete this pricing level?")) start(async () => { await deletePricingLevel(l.id); if (editingLevelId === l.id) cancelEditLevel(); router.refresh(); }); }} className="text-slate-400 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1"><Label htmlFor="pl-name">Name</Label><Input id="pl-name" value={levelName} onChange={(e) => setLevelName(e.target.value)} placeholder="e.g. Trade / Builder" /></div>
          <div className="w-24"><Label htmlFor="pl-markup">Markup %</Label><NumberInput id="pl-markup" value={levelMarkup} onValueChange={setLevelMarkup} /></div>
          <div className="w-28"><Label htmlFor="pl-rate">Labor $/hr</Label><Input id="pl-rate" type="number" inputMode="decimal" value={levelRate} onChange={(e) => setLevelRate(e.target.value === "" ? "" : Number(e.target.value))} placeholder="default" /></div>
          <Button size="sm" onClick={addLevel} disabled={pending || !levelName.trim()}>{editingLevelId ? <><Check className="h-3.5 w-3.5" /> Save</> : <><Plus className="h-3.5 w-3.5" /> Add</>}</Button>
          {editingLevelId && <Button size="sm" variant="outline" onClick={cancelEditLevel} disabled={pending} title="Cancel edit"><X className="h-3.5 w-3.5" /></Button>}
        </div>
        <p className="mt-1 text-xs text-slate-500">Leave labor $/hr blank to use the org default (${Number(settings.default_labor_rate)}/hr).</p>
      </div>
    </div>
  );
}
