"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Check, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge } from "@/components/ui/badge";
import type { OrgSettings } from "@/lib/org-settings";
import { createTaxRate, setDefaultTaxRate, deleteTaxRate, updateOrgSettings } from "./actions";

interface TaxRate {
  id: string;
  name: string;
  rate: number;
  is_default: boolean;
}

export function TaxRatesManager({
  taxRates,
  settings,
}: {
  taxRates: TaxRate[];
  settings: OrgSettings;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [rate, setRate] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [laborRate, setLaborRate] = useState(settings.default_labor_rate);
  const [savedLabor, setSavedLabor] = useState(false);

  function add() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    start(async () => {
      const res = await createTaxRate({ name, rate, is_default: taxRates.length === 0 });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setName("");
      setRate(0);
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
                  onClick={() => start(async () => { await deleteTaxRate(t.id); router.refresh(); })}
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
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-900">Defaults</h4>
        <div className="flex items-end gap-3">
          <div className="w-48">
            <Label htmlFor="fin-labor">Default labor rate ($/hr)</Label>
            <NumberInput id="fin-labor" value={laborRate} onValueChange={setLaborRate} />
          </div>
          <Button
            size="sm"
            onClick={() => start(async () => { await updateOrgSettings({ default_labor_rate: laborRate }); setSavedLabor(true); setTimeout(() => setSavedLabor(false), 2000); })}
            disabled={pending}
          >
            Save
          </Button>
          {savedLabor && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
        </div>
      </div>
    </div>
  );
}
