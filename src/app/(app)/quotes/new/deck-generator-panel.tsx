"use client";

import { useMemo, useState } from "react";
import { Wand2, ChevronDown, ChevronRight } from "lucide-react";
import { computeDeckEstimate, type DeckAnswers, type DeckMaterial, type DeckShape } from "@/lib/estimate/deck";
import { Card, CardContent } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import type { DraftLineItem } from "../actions";

// Height at the tallest point → a representative ft for the band adder (mirrors the public
// configurator's bands, so office + web produce identical estimates).
const HEIGHT_BANDS = [
  { value: "ground", label: "On the ground / low", ft: 2 },
  { value: "under10", label: "Up to 10 ft", ft: 8 },
  { value: "10_20", label: "10–20 ft", ft: 15 },
  { value: "20_30", label: "20–30 ft", ft: 25 },
  { value: "over30", label: "Over 30 ft", ft: 35 },
];

type Form = {
  projectType: string;
  material: DeckMaterial;
  lengthFt: number;
  widthFt: number;
  heightBand: string;
  shape: DeckShape;
  wrapAround: boolean;
  railingLf: number;
  stairFlights: number;
  stairSteps: number;
  stairRailingLf: number;
  manDoors: number;
  sliderDoors: number;
  trpa: boolean;
};

/**
 * The deck GENERATOR on the office estimate page (catalog orgs). Chris types the deck's
 * dimensions and it runs the SAME computeDeckEstimate engine as the public configurator (one
 * SSOT, so office and web agree), then drops the priced lines straight into the estimate
 * tagged group "Decks" — he can hand-edit quantities after. Erik: "the generator on the same
 * page fills it in for him right there."
 */
export function DeckGeneratorPanel({
  rates,
  onDrop,
}: {
  rates: Record<string, number>;
  onDrop: (lines: DraftLineItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Form>({
    projectType: "new_deck",
    material: "wood",
    lengthFt: 0,
    widthFt: 0,
    heightBand: "under10",
    shape: "rectangle",
    wrapAround: false,
    railingLf: 0,
    stairFlights: 0,
    stairSteps: 0,
    stairRailingLf: 0,
    manDoors: 0,
    sliderDoors: 0,
    trpa: false,
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const answers: DeckAnswers = useMemo(
    () => ({
      projectType: f.projectType,
      material: f.material,
      lengthFt: f.lengthFt,
      widthFt: f.widthFt,
      heightFt: HEIGHT_BANDS.find((b) => b.value === f.heightBand)?.ft ?? 8,
      railingLf: f.railingLf > 0 ? f.railingLf : null,
      stairFlights: f.stairFlights,
      stairSteps: f.stairSteps,
      stairRailingLf: f.stairRailingLf,
      shape: f.shape,
      wrapAround: f.wrapAround,
      manDoors: f.manDoors,
      sliderDoors: f.sliderDoors,
      trpa: f.trpa,
    }),
    [f],
  );
  const est = useMemo(() => computeDeckEstimate(answers, (c) => rates[c] ?? 0), [answers, rates]);

  function drop() {
    const lines: DraftLineItem[] = est.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unit_price,
      group: "Decks",
    }));
    if (lines.length) onDrop(lines);
    setOpen(false);
  }

  return (
    <Card className="mb-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-[color:rgb(var(--color-brand-light))]/50 px-5 py-3 text-left hover:bg-slate-50"
      >
        {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
        <Wand2 className="h-4 w-4 text-[color:rgb(var(--glass-ink))]" />
        <span className="text-sm font-semibold text-slate-800">Deck generator</span>
        <span className="hidden text-xs text-slate-400 sm:inline">— type the dimensions, auto-fill the lines</span>
      </button>
      {open && (
        <CardContent className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <Label>Project</Label>
              <Select value={f.projectType} onChange={(e) => set("projectType", e.target.value)}>
                <option value="new_deck">New deck</option>
                <option value="full_replacement">Full replacement</option>
                <option value="resurface">Resurface (reuse frame)</option>
                <option value="extension">Extension</option>
              </Select>
            </div>
            <div>
              <Label>Material</Label>
              <Select value={f.material} onChange={(e) => set("material", e.target.value as DeckMaterial)}>
                <option value="wood">Wood</option>
                <option value="composite">Composite</option>
              </Select>
            </div>
            <div>
              <Label>Height</Label>
              <Select value={f.heightBand} onChange={(e) => set("heightBand", e.target.value)}>
                {HEIGHT_BANDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Length (ft)</Label>
              <NumberInput value={f.lengthFt} onValueChange={(n) => set("lengthFt", n)} />
            </div>
            <div>
              <Label>Width (ft)</Label>
              <NumberInput value={f.widthFt} onValueChange={(n) => set("widthFt", n)} />
            </div>
            <div>
              <Label>Shape</Label>
              <Select value={f.shape} onChange={(e) => set("shape", e.target.value as DeckShape)}>
                <option value="rectangle">Rectangle</option>
                <option value="irregular">Irregular</option>
              </Select>
            </div>
            <div>
              <Label>Railing (LF)</Label>
              <NumberInput value={f.railingLf} onValueChange={(n) => set("railingLf", n)} placeholder="auto" />
            </div>
            <div>
              <Label>Sets of stairs</Label>
              <NumberInput value={f.stairFlights} onValueChange={(n) => set("stairFlights", n)} />
            </div>
            <div>
              <Label>Stairs (total steps)</Label>
              <NumberInput value={f.stairSteps} onValueChange={(n) => set("stairSteps", n)} />
            </div>
            <div>
              <Label>Stair railing (LF)</Label>
              <NumberInput value={f.stairRailingLf} onValueChange={(n) => set("stairRailingLf", n)} />
            </div>
            <div>
              <Label>Slider doors</Label>
              <NumberInput value={f.sliderDoors} onValueChange={(n) => set("sliderDoors", n)} />
            </div>
            <div>
              <Label>Man doors</Label>
              <NumberInput value={f.manDoors} onValueChange={(n) => set("manDoors", n)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={f.wrapAround} onChange={(e) => set("wrapAround", e.target.checked)} /> Wrap-around
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={f.trpa} onChange={(e) => set("trpa", e.target.checked)} /> TRPA (Tahoe basin)
            </label>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
            <div className="text-sm text-slate-600">
              {est.lines.length} line{est.lines.length === 1 ? "" : "s"} ·{" "}
              <span className="font-semibold text-slate-900">{formatCurrency(est.total)}</span>
            </div>
            <Button type="button" onClick={drop} disabled={est.lines.length === 0}>
              Drop into estimate
            </Button>
          </div>
          {est.assumptions.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-400">
              {est.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
