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

// Height is a CUSTOM number here (inches — Chris measures off the ground), unlike the public
// configurator's bands. Chips just prefill the input around the 30-in guardrail rule: at or
// under 30 in the engine skips the derived railing, so Under 12/24 (11/23 in) omit it while
// Under 36 (35 in) deliberately keeps it. The tall chips are the public bands' representative
// heights so a chip-picked estimate matches the web configurator.
const HEIGHT_PRESETS = [
  { label: "Under 12 in", inches: 11 },
  { label: "Under 24 in", inches: 23 },
  { label: "Under 36 in", inches: 35 },
  { label: "Up to 10 ft", inches: 96 },
  { label: "10–20 ft", inches: 180 },
  { label: "20–30 ft", inches: 300 },
  { label: "Over 30 ft", inches: 420 },
];

type Form = {
  projectType: string;
  material: DeckMaterial;
  lengthFt: number;
  widthFt: number;
  heightIn: number;
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
    heightIn: 96,
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
      heightFt: f.heightIn / 12,
      heightIsExact: true,
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
            <div className="col-span-2 sm:col-span-3">
              <Label>Height off the ground (in)</Label>
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-24">
                  <NumberInput value={f.heightIn} onValueChange={(n) => set("heightIn", n)} />
                </div>
                {f.heightIn > 0 && (
                  <span className="text-xs tabular-nums text-slate-400">≈ {(f.heightIn / 12).toFixed(1)} ft</span>
                )}
                {HEIGHT_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => set("heightIn", p.inches)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                      f.heightIn === p.inches
                        ? "border-transparent bg-[color:rgb(var(--glass-ink))] text-white"
                        : "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
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
