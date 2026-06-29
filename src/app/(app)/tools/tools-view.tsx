"use client";

import { useMemo, useState } from "react";
import {
  Zap, Cable, Calculator, Ruler, Box, Layers, PaintBucket, Percent, TrendingUp,
  HardHat, Receipt, Triangle, Spline, ArrowRightLeft, Search, ChevronDown,
  Fan, Plug, Thermometer, ShieldCheck, Sun, Frame, Square, type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";

/* ── NEC reference tables ─────────────────────────────────────────────── */
/* Circular mils per AWG/kcmil size (NEC chapter 9 table 8). */
const CMIL: Record<string, number> = {
  "14": 4110, "12": 6530, "10": 10380, "8": 16510, "6": 26240, "4": 41740,
  "3": 52620, "2": 66360, "1": 83690, "1/0": 105600, "2/0": 133100,
  "3/0": 167800, "4/0": 211600, "250": 250000, "300": 300000,
  "350": 350000, "500": 500000,
};
/* THHN conductor areas, in² (NEC ch. 9 table 5). */
const THHN_AREA: Record<string, number> = {
  "14": 0.0097, "12": 0.0133, "10": 0.0211, "8": 0.0366, "6": 0.0507,
  "4": 0.0824, "3": 0.0973, "2": 0.1158, "1": 0.1562, "1/0": 0.1855,
  "2/0": 0.2223, "3/0": 0.2679, "4/0": 0.3237, "250": 0.397,
  "300": 0.4608, "350": 0.5242, "500": 0.7073,
};
/* 40% fill areas, in² (over 2 conductors) per conduit trade size. */
const CONDUIT_FILL: Record<string, Record<string, number>> = {
  "PVC Sch 40": { '1/2"': 0.114, '3/4"': 0.203, '1"': 0.333, '1-1/4"': 0.581, '1-1/2"': 0.794, '2"': 1.316, '2-1/2"': 1.878, '3"': 2.907, '4"': 5.022 },
  EMT: { '1/2"': 0.122, '3/4"': 0.213, '1"': 0.346, '1-1/4"': 0.598, '1-1/2"': 0.814, '2"': 1.342, '2-1/2"': 2.343, '3"': 3.538, '4"': 5.901 },
};
/* Ampacity, 75°C copper / aluminum (NEC 310.16). */
const AMPACITY_CU: Record<string, number> = {
  "14": 20, "12": 25, "10": 35, "8": 50, "6": 65, "4": 85, "3": 100, "2": 115,
  "1": 130, "1/0": 150, "2/0": 175, "3/0": 200, "4/0": 230, "250": 255,
  "300": 285, "350": 310, "500": 380,
};
const AMPACITY_AL: Record<string, number> = {
  "12": 20, "10": 35, "8": 40, "6": 50, "4": 65, "3": 75, "2": 90, "1": 100,
  "1/0": 120, "2/0": 135, "3/0": 155, "4/0": 180, "250": 205, "300": 230,
  "350": 250, "500": 310,
};
// Smallest→largest in AWG/kcmil order. NOT Object.keys(CMIL) — that sorts the integer-string
// keys numerically (1,2,3,…,12,14, then kcmil), so .find() returned #1 AWG for nearly every load.
const SIZES = ["14", "12", "10", "8", "6", "4", "3", "2", "1", "1/0", "2/0", "3/0", "4/0", "250", "300", "350", "500"].filter((s) => s in CMIL);
/* Per-conductor volume allowance, in³ (NEC 314.16(B) table). */
const BOX_VOL: Record<string, number> = { "14": 2.0, "12": 2.25, "10": 2.5, "8": 3.0, "6": 5.0 };
/* Common metal boxes, usable in³ (NEC 314.16(A)). */
const STD_BOXES: { name: string; vol: number }[] = [
  { name: "3×2×2 device", vol: 10.0 },
  { name: "3×2×2½ device", vol: 12.5 },
  { name: '4" round/oct ×1½', vol: 15.5 },
  { name: "3×2×3½ device", vol: 18.0 },
  { name: "4×4×1½ square", vol: 21.0 },
  { name: "4×4×2⅛ square", vol: 30.3 },
  { name: "4-11/16×2⅛ square", vol: 42.0 },
];
/* Standard OCPD sizes (NEC 240.6). */
const STD_BREAKERS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250, 300, 350, 400];
const nextBreaker = (a: number) => STD_BREAKERS.find((b) => b >= a) ?? STD_BREAKERS[STD_BREAKERS.length - 1];
/* Motor full-load current, A (NEC 430.248 single-φ, 430.250 three-φ), by HP. */
const MOTOR_FLC: Record<string, Record<string, Record<string, number>>> = {
  "1φ": {
    "115V": { "0.5": 9.8, "0.75": 13.8, "1": 16, "1.5": 20, "2": 24, "3": 34, "5": 56, "7.5": 80, "10": 100 },
    "230V": { "0.5": 4.9, "0.75": 6.9, "1": 8, "1.5": 10, "2": 12, "3": 17, "5": 28, "7.5": 40, "10": 50 },
  },
  "3φ": {
    "230V": { "1": 3.6, "1.5": 5.2, "2": 6.8, "3": 9.6, "5": 15.2, "7.5": 22, "10": 28, "15": 42, "20": 54, "25": 68, "30": 80, "40": 104, "50": 130, "60": 154, "75": 192, "100": 248 },
    "460V": { "1": 1.8, "1.5": 2.6, "2": 3.4, "3": 4.8, "5": 7.6, "7.5": 11, "10": 14, "15": 21, "20": 27, "25": 34, "30": 40, "40": 52, "50": 65, "60": 77, "75": 96, "100": 124 },
  },
};
/* Ambient temp correction, 75°C column (NEC 310.15(B)(1)); reference 86°F = 1.00. [maxF, factor] */
const AMBIENT_75: [number, number][] = [
  [50, 1.2], [59, 1.15], [68, 1.11], [77, 1.05], [86, 1.0], [95, 0.94], [104, 0.88],
  [113, 0.82], [122, 0.75], [131, 0.67], [140, 0.58], [158, 0.47],
];
const ambientFactor = (f: number) => (AMBIENT_75.find(([maxF]) => f <= maxF)?.[1] ?? 0.41);
/* Bundling adjustment, # current-carrying conductors (NEC 310.15(C)(1)). */
const bundleFactor = (n: number) => (n <= 3 ? 1 : n <= 6 ? 0.8 : n <= 9 ? 0.7 : n <= 20 ? 0.5 : n <= 30 ? 0.45 : n <= 40 ? 0.4 : 0.35);
/* GFCI / AFCI requirement by dwelling location (NEC 210.8 / 210.12, ~2020 baseline). */
const PROTECTION: { area: string; gfci: boolean; afci: boolean; ref: string }[] = [
  { area: "Kitchen — countertop", gfci: true, afci: true, ref: "210.8(A)(6) / 210.12(A)" },
  { area: "Bathroom", gfci: true, afci: false, ref: "210.8(A)(1)" },
  { area: "Bedroom", gfci: false, afci: true, ref: "210.12(A)" },
  { area: "Living / family room", gfci: false, afci: true, ref: "210.12(A)" },
  { area: "Hallway / closet", gfci: false, afci: true, ref: "210.12(A)" },
  { area: "Laundry area", gfci: true, afci: true, ref: "210.8(A)(10) / 210.12(A)" },
  { area: "Garage", gfci: true, afci: false, ref: "210.8(A)(2)" },
  { area: "Outdoors", gfci: true, afci: false, ref: "210.8(A)(3)" },
  { area: "Unfinished basement", gfci: true, afci: true, ref: "210.8(A)(5) / 210.12(D)" },
  { area: "Crawl space", gfci: true, afci: false, ref: "210.8(A)(4)" },
  { area: "Wet bar (within 6 ft of sink)", gfci: true, afci: false, ref: "210.8(A)(7)" },
];

/* ── shared UI bits ───────────────────────────────────────────────────── */
type Tone = "green" | "amber" | "red" | "slate";
const TONE: Record<Tone, string> = {
  green: "bg-green-50 text-green-700",
  amber: "bg-amber-50 text-amber-800",
  red: "bg-red-50 text-red-700",
  slate: "bg-slate-50 text-slate-700",
};
function Result({ tone = "slate", children }: { tone?: Tone; children: React.ReactNode }) {
  return <div className={`rounded-lg px-4 py-3 text-sm ${TONE[tone]}`}>{children}</div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><Label>{label}</Label>{children}</div>;
}
function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>;
}

/* ── ELECTRICAL ───────────────────────────────────────────────────────── */
function WireSize() {
  const [amps, setAmps] = useState(80);
  const [volts, setVolts] = useState(240);
  const [feet, setFeet] = useState(100);
  const [metal, setMetal] = useState<"cu" | "al">("cu");
  const [maxPct, setMaxPct] = useState(3);
  const amp = metal === "cu" ? AMPACITY_CU : AMPACITY_AL;
  const k = metal === "cu" ? 12.9 : 21.2;
  const pick = SIZES.find((s) => {
    const a = amp[s];
    if (!a || a < amps) return false;
    const vd = (2 * k * amps * feet) / CMIL[s];
    return volts > 0 && (vd / volts) * 100 <= maxPct;
  });
  const detail = pick ? { vd: (2 * k * amps * feet) / CMIL[pick], pct: ((2 * k * amps * feet) / CMIL[pick] / volts) * 100, amp: amp[pick] } : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Amps (load)"><NumberInput value={amps} onValueChange={setAmps} /></Field>
        <Field label="Volts"><NumberInput value={volts} onValueChange={setVolts} /></Field>
        <Field label="One-way feet"><NumberInput value={feet} onValueChange={setFeet} /></Field>
        <Field label="Metal"><Select value={metal} onChange={(e) => setMetal(e.target.value as "cu" | "al")}><option value="cu">Copper</option><option value="al">Aluminum</option></Select></Field>
        <Field label="Max drop %"><Select value={String(maxPct)} onChange={(e) => setMaxPct(Number(e.target.value))}><option value="3">3% (branch)</option><option value="5">5% (feeder)</option></Select></Field>
      </div>
      <Result tone={pick ? "green" : "red"}>
        {pick && detail ? (
          <>Use <strong>{pick} AWG/kcmil {metal === "cu" ? "copper" : "aluminum"}</strong> — ampacity {detail.amp} A (75°C), drop {detail.vd.toFixed(2)} V ({detail.pct.toFixed(2)}%) at {feet} ft.</>
        ) : (
          <>No single conductor up to 500 kcmil meets that — parallel runs or shorten the distance.</>
        )}
      </Result>
    </div>
  );
}

function VoltageDrop() {
  const [size, setSize] = useState("2/0");
  const [metal, setMetal] = useState<"cu" | "al">("cu");
  const [volts, setVolts] = useState(240);
  const [amps, setAmps] = useState(80);
  const [feet, setFeet] = useState(100);
  const k = metal === "cu" ? 12.9 : 21.2;
  const vd = volts > 0 && CMIL[size] ? (2 * k * amps * feet) / CMIL[size] : 0;
  const pct = volts > 0 ? (vd / volts) * 100 : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Wire size"><Select value={size} onChange={(e) => setSize(e.target.value)}>{SIZES.map((s) => <option key={s} value={s}>{s} AWG/kcmil</option>)}</Select></Field>
        <Field label="Metal"><Select value={metal} onChange={(e) => setMetal(e.target.value as "cu" | "al")}><option value="cu">Copper</option><option value="al">Aluminum</option></Select></Field>
        <Field label="Volts"><NumberInput value={volts} onValueChange={setVolts} /></Field>
        <Field label="Amps"><NumberInput value={amps} onValueChange={setAmps} /></Field>
        <Field label="One-way feet"><NumberInput value={feet} onValueChange={setFeet} /></Field>
      </div>
      <Result tone={pct > 5 ? "red" : pct > 3 ? "amber" : "green"}>
        Drop: <strong>{vd.toFixed(2)} V</strong> ({pct.toFixed(2)}%) → {pct > 5 ? "over 5% — upsize the conductor" : pct > 3 ? "OK for a feeder (≤5%), high for a branch (≤3%)" : "within 3% — good"}
      </Result>
    </div>
  );
}

function ConduitFill() {
  const [size, setSize] = useState("2/0");
  const [count, setCount] = useState(4);
  const [type, setType] = useState("PVC Sch 40");
  const area = (THHN_AREA[size] ?? 0) * count;
  const table = CONDUIT_FILL[type];
  const fit = Object.entries(table).find(([, a]) => a >= area)?.[0];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Conductor size (THHN)"><Select value={size} onChange={(e) => setSize(e.target.value)}>{SIZES.map((s) => <option key={s} value={s}>{s} AWG/kcmil</option>)}</Select></Field>
        <Field label="# of conductors"><NumberInput value={count} onValueChange={setCount} /></Field>
        <Field label="Conduit type"><Select value={type} onChange={(e) => setType(e.target.value)}>{Object.keys(CONDUIT_FILL).map((t) => <option key={t}>{t}</option>)}</Select></Field>
      </div>
      <Result tone={fit ? "green" : "red"}>
        Conductor area: <strong>{area.toFixed(3)} in²</strong> → {fit ? <>minimum <strong>{fit} {type}</strong> at 40% fill ({((area / table[fit]) * 100).toFixed(0)}% full)</> : <strong>too big for a single 4&quot; conduit — split the run</strong>}
      </Result>
    </div>
  );
}

function OhmsLaw() {
  const [volts, setVolts] = useState(240);
  const [amps, setAmps] = useState(0);
  const [watts, setWatts] = useState(6800);
  const i = amps || (volts ? watts / volts : 0);
  const p = watts || volts * amps;
  const r = i > 0 ? volts / i : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Volts"><NumberInput value={volts} onValueChange={setVolts} /></Field>
        <Field label="Amps (or 0)"><NumberInput value={amps} onValueChange={setAmps} /></Field>
        <Field label="Watts (or 0)"><NumberInput value={watts} onValueChange={setWatts} /></Field>
      </div>
      <Result>
        I = <strong>{i.toFixed(1)} A</strong> · P = <strong>{Math.round(p)} W</strong> · R = <strong>{r > 0 ? r.toFixed(1) : "—"} Ω</strong>
        {i > 0 && <span className="ml-2 text-slate-500">→ breaker ≥ <strong>{Math.ceil((i * 1.25) / 5) * 5} A</strong> (125% continuous)</span>}
      </Result>
    </div>
  );
}

function BoxFill() {
  const [size, setSize] = useState("12");
  const [cond, setCond] = useState(6);
  const [devices, setDevices] = useState(1);
  const [clamps, setClamps] = useState(true);
  const [grounds, setGrounds] = useState(true);
  const v = BOX_VOL[size] ?? 0;
  // NEC 314.16(B): conductor ×1, each device yoke ×2, all clamps one allowance, all grounds one allowance.
  const required = cond * v + devices * 2 * v + (clamps ? v : 0) + (grounds ? v : 0);
  const box = STD_BOXES.find((b) => b.vol >= required);
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">Assumes all conductors are the same gauge (the common case). Each device yoke counts as 2, all clamps together as 1, all grounds together as 1.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Conductor size"><Select value={size} onChange={(e) => setSize(e.target.value)}>{Object.keys(BOX_VOL).map((s) => <option key={s} value={s}>{s} AWG</option>)}</Select></Field>
        <Field label="# insulated conductors"><NumberInput value={cond} onValueChange={setCond} /></Field>
        <Field label="# devices (yokes)"><NumberInput value={devices} onValueChange={setDevices} /></Field>
        <Field label="Internal clamps?"><Select value={clamps ? "y" : "n"} onChange={(e) => setClamps(e.target.value === "y")}><option value="y">Yes</option><option value="n">No</option></Select></Field>
        <Field label="Ground wire(s)?"><Select value={grounds ? "y" : "n"} onChange={(e) => setGrounds(e.target.value === "y")}><option value="y">Yes</option><option value="n">No</option></Select></Field>
      </div>
      <Result tone={box ? "green" : "red"}>
        Required fill: <strong>{required.toFixed(2)} in³</strong> → {box ? <>use a <strong>{box.name}</strong> ({box.vol} in³) or larger</> : <>exceeds a 42 in³ box — use a larger junction box</>}
      </Result>
    </div>
  );
}

/* ── ESTIMATING ───────────────────────────────────────────────────────── */
function BoardFeet() {
  const [thick, setThick] = useState(2);
  const [width, setWidth] = useState(6);
  const [lengthFt, setLengthFt] = useState(8);
  const [qty, setQty] = useState(1);
  const bf = ((thick * width * lengthFt) / 12) * qty;
  return (
    <div className="space-y-3">
      <Grid>
        <Field label="Thickness (in)"><NumberInput value={thick} onValueChange={setThick} /></Field>
        <Field label="Width (in)"><NumberInput value={width} onValueChange={setWidth} /></Field>
        <Field label="Length (ft)"><NumberInput value={lengthFt} onValueChange={setLengthFt} /></Field>
        <Field label="Quantity"><NumberInput value={qty} onValueChange={setQty} /></Field>
      </Grid>
      <Result><strong>{bf.toFixed(2)} board feet</strong></Result>
    </div>
  );
}

function ConcreteSlab() {
  const [L, setL] = useState(10);
  const [W, setW] = useState(10);
  const [D, setD] = useState(4);
  const [waste, setWaste] = useState(5);
  const cfRaw = L * W * (D / 12);
  const cf = cfRaw * (1 + waste / 100);
  const cy = cf / 27;
  const bags60 = Math.ceil(cf / 0.45); // 60-lb bag yields 0.45 ft³
  const bags80 = Math.ceil(cf / 0.6); // 80-lb bag yields 0.60 ft³
  return (
    <div className="space-y-3">
      <Grid>
        <Field label="Length (ft)"><NumberInput value={L} onValueChange={setL} /></Field>
        <Field label="Width (ft)"><NumberInput value={W} onValueChange={setW} /></Field>
        <Field label="Depth (in)"><NumberInput value={D} onValueChange={setD} /></Field>
        <Field label="Waste %"><NumberInput value={waste} onValueChange={setWaste} /></Field>
      </Grid>
      <Result tone={cy <= 1.5 ? "green" : cy <= 3 ? "amber" : "red"}>
        <strong>{cy.toFixed(2)} cubic yards</strong> ({cf.toFixed(1)} ft³ incl. {waste}% waste) · <strong>{bags80}</strong> × 80-lb bags <em>or</em> <strong>{bags60}</strong> × 60-lb
        {cy > 3 && <span className="ml-1">— order ready-mix instead of bags</span>}
      </Result>
    </div>
  );
}

function Paint() {
  const [L, setL] = useState(12);
  const [W, setW] = useState(12);
  const [H, setH] = useState(8);
  const [coverage, setCoverage] = useState(350);
  const [coats, setCoats] = useState(2);
  const [openings, setOpenings] = useState(15);
  const wall = 2 * (L + W) * H;
  const adj = wall * (1 - openings / 100);
  const gal = coverage > 0 ? (adj / coverage) * coats * 1.1 : 0; // +10% waste
  const buy = Math.ceil(gal * 2) / 2;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Length (ft)"><NumberInput value={L} onValueChange={setL} /></Field>
        <Field label="Width (ft)"><NumberInput value={W} onValueChange={setW} /></Field>
        <Field label="Wall height (ft)"><NumberInput value={H} onValueChange={setH} /></Field>
        <Field label="Coverage ft²/gal"><NumberInput value={coverage} onValueChange={setCoverage} /></Field>
        <Field label="Coats"><NumberInput value={coats} onValueChange={setCoats} /></Field>
        <Field label="Doors/windows %"><NumberInput value={openings} onValueChange={setOpenings} /></Field>
      </div>
      <Result tone={buy > 5 ? "amber" : "green"}>
        Wall area <strong>{adj.toFixed(0)} ft²</strong> ({coats} coats) → need <strong>{gal.toFixed(1)} gal</strong>, buy <strong>{buy} gal</strong>{buy > 5 ? " (5-gal buckets)" : ""}
      </Result>
    </div>
  );
}

/* ── MONEY ────────────────────────────────────────────────────────────── */
function MarkupMargin() {
  const [cost, setCost] = useState(1000);
  const [mode, setMode] = useState<"markup" | "margin">("markup");
  const [pct, setPct] = useState(30);
  const sell = mode === "markup" ? cost * (1 + pct / 100) : pct < 100 ? cost / (1 - pct / 100) : 0;
  const profit = sell - cost;
  const markup = cost > 0 ? (profit / cost) * 100 : 0;
  const margin = sell > 0 ? (profit / sell) * 100 : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Cost ($)"><NumberInput value={cost} onValueChange={setCost} /></Field>
        <Field label="I know the"><Select value={mode} onChange={(e) => setMode(e.target.value as "markup" | "margin")}><option value="markup">Markup %</option><option value="margin">Margin %</option></Select></Field>
        <Field label={mode === "markup" ? "Markup %" : "Margin %"}><NumberInput value={pct} onValueChange={setPct} /></Field>
      </div>
      <Result tone={markup >= 15 ? "green" : "amber"}>
        Sell <strong>${sell.toFixed(2)}</strong> · profit <strong>${profit.toFixed(2)}</strong> · markup <strong>{markup.toFixed(1)}%</strong> · margin <strong>{margin.toFixed(1)}%</strong>
      </Result>
      <p className="text-xs text-slate-400">Markup is on cost; margin is on the sell price. A 30% markup is only a 23% margin.</p>
    </div>
  );
}

function JobProfit() {
  const [hours, setHours] = useState(40);
  const [rate, setRate] = useState(65);
  const [matCost, setMatCost] = useState(2000);
  const [price, setPrice] = useState(8000);
  const labor = hours * rate;
  const cost = labor + matCost;
  const profit = price - cost;
  const margin = price > 0 ? (profit / price) * 100 : 0;
  return (
    <div className="space-y-3">
      <Grid>
        <Field label="Labor hours"><NumberInput value={hours} onValueChange={setHours} /></Field>
        <Field label="Your cost $/hr"><NumberInput value={rate} onValueChange={setRate} /></Field>
        <Field label="Material cost $"><NumberInput value={matCost} onValueChange={setMatCost} /></Field>
        <Field label="Quote / price $"><NumberInput value={price} onValueChange={setPrice} /></Field>
      </Grid>
      <Result tone={margin >= 20 ? "green" : margin >= 10 ? "amber" : "red"}>
        Cost <strong>${cost.toFixed(0)}</strong> (labor ${labor.toFixed(0)} + materials ${matCost.toFixed(0)}) → profit <strong>${profit.toFixed(0)}</strong> · margin <strong>{margin.toFixed(1)}%</strong>
        {margin < 10 && <span className="ml-1">— thin, re-check the price</span>}
      </Result>
    </div>
  );
}

function LaborBurden() {
  const [base, setBase] = useState(50);
  const [tax, setTax] = useState(7.65);
  const [wc, setWc] = useState(8);
  const [benefits, setBenefits] = useState(0);
  const [other, setOther] = useState(0);
  const loaded = base * (1 + (tax + wc + other) / 100) + benefits;
  const burden = base > 0 ? (loaded / base - 1) * 100 : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Base wage $/hr"><NumberInput value={base} onValueChange={setBase} /></Field>
        <Field label="Payroll tax %"><NumberInput value={tax} onValueChange={setTax} /></Field>
        <Field label="Workers comp %"><NumberInput value={wc} onValueChange={setWc} /></Field>
        <Field label="Benefits $/hr"><NumberInput value={benefits} onValueChange={setBenefits} /></Field>
        <Field label="Other %"><NumberInput value={other} onValueChange={setOther} /></Field>
      </div>
      <Result>
        Loaded cost <strong>${loaded.toFixed(2)}/hr</strong> — a <strong>{burden.toFixed(0)}%</strong> burden over the base wage.
      </Result>
      <p className="text-xs text-slate-400">Verify your real workers-comp + state unemployment rates with your broker. FICA is 7.65%.</p>
    </div>
  );
}

function SalesTax() {
  const [amt, setAmt] = useState(1000);
  const [rate, setRate] = useState(7.25);
  const [mode, setMode] = useState<"add" | "extract">("add");
  const pre = mode === "add" ? amt : amt / (1 + rate / 100);
  const total = mode === "add" ? amt * (1 + rate / 100) : amt;
  const taxAmt = total - pre;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label={mode === "add" ? "Pre-tax $" : "Total (with tax) $"}><NumberInput value={amt} onValueChange={setAmt} /></Field>
        <Field label="Tax rate %"><NumberInput value={rate} onValueChange={setRate} /></Field>
        <Field label="Mode"><Select value={mode} onChange={(e) => setMode(e.target.value as "add" | "extract")}><option value="add">Add tax</option><option value="extract">Back out tax</option></Select></Field>
      </div>
      <Result>
        Pre-tax <strong>${pre.toFixed(2)}</strong> · tax <strong>${taxAmt.toFixed(2)}</strong> · total <strong>${total.toFixed(2)}</strong>
      </Result>
    </div>
  );
}

/* ── FIELD ────────────────────────────────────────────────────────────── */
function RightTriangle() {
  const [a, setA] = useState(3);
  const [b, setB] = useState(4);
  const [c, setC] = useState(0);
  let A = a, B = b, C = c; // legs a,b; hypotenuse c. 0 = solve for it.
  if (c === 0 && a > 0 && b > 0) C = Math.hypot(a, b);
  else if (a === 0 && b > 0 && c > b) A = Math.sqrt(c * c - b * b);
  else if (b === 0 && a > 0 && c > a) B = Math.sqrt(c * c - a * a);
  const ok = A > 0 && B > 0 && C > 0;
  const angA = ok ? (Math.atan2(A, B) * 180) / Math.PI : 0;
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">Enter any two; leave the unknown at 0. Legs A &amp; B, hypotenuse C — e.g. the 3-4-5 for a square offset.</p>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Side A (0=solve)"><NumberInput value={a} onValueChange={setA} /></Field>
        <Field label="Side B (0=solve)"><NumberInput value={b} onValueChange={setB} /></Field>
        <Field label="Hyp C (0=solve)"><NumberInput value={c} onValueChange={setC} /></Field>
      </div>
      <Result tone={ok ? "green" : "red"}>
        {ok ? <>A = <strong>{A.toFixed(3)}</strong> · B = <strong>{B.toFixed(3)}</strong> · C = <strong>{C.toFixed(3)}</strong> · angles <strong>{angA.toFixed(1)}°</strong> / <strong>{(90 - angA).toFixed(1)}°</strong></> : <>Enter two valid sides (a hypotenuse must be the largest).</>}
      </Result>
    </div>
  );
}

function ConduitOffset() {
  const [angle, setAngle] = useState(45);
  const [rise, setRise] = useState(6);
  const rad = (angle * Math.PI) / 180;
  const mult = 1 / Math.sin(rad);
  const dist = rise * mult;
  const shrink = rise * ((1 - Math.cos(rad)) / Math.sin(rad));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Bend angle"><Select value={String(angle)} onChange={(e) => setAngle(Number(e.target.value))}>{[10, 22.5, 30, 45, 60].map((d) => <option key={d} value={d}>{d}°</option>)}</Select></Field>
        <Field label="Offset / rise (in)"><NumberInput value={rise} onValueChange={setRise} /></Field>
      </div>
      <Result>
        Multiplier <strong>{mult.toFixed(2)}</strong> → mark bends <strong>{dist.toFixed(2)}&quot;</strong> apart · shrink <strong>{shrink.toFixed(2)}&quot;</strong>
      </Result>
    </div>
  );
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
function FractionConvert() {
  const [dec, setDec] = useState(6.375);
  const [denom, setDenom] = useState(16);
  const whole = Math.floor(dec);
  const frac = dec - whole;
  const rawN = Math.round(frac * denom);
  const exact = Math.abs(frac * denom - rawN) < 1e-9;
  let n = rawN, d = denom;
  const g = gcd(n, d) || 1;
  if (n > 0) { n /= g; d /= g; }
  const str = n === 0 ? `${whole}"` : `${whole > 0 ? whole + " " : ""}${n}/${d}"`;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Decimal inches"><NumberInput value={dec} onValueChange={setDec} /></Field>
        <Field label="Round to"><Select value={String(denom)} onChange={(e) => setDenom(Number(e.target.value))}>{[8, 16, 32, 64].map((x) => <option key={x} value={x}>1/{x}&quot;</option>)}</Select></Field>
      </div>
      <Result tone={exact ? "green" : "amber"}>
        <strong>{str}</strong> {exact ? "(exact)" : `(nearest 1/${denom}\")`}
      </Result>
    </div>
  );
}

const UNITS: Record<string, Record<string, number>> = {
  Length: { in: 1, ft: 12, yd: 36, mm: 1 / 25.4, cm: 10 / 25.4, m: 1000 / 25.4 },
  Area: { "in²": 1, "ft²": 144, "yd²": 1296, "m²": 1550.0031 },
  Volume: { "in³": 1, "ft³": 1728, "yd³": 46656, gal: 231, L: 61.0237 },
  Weight: { lb: 1, oz: 1 / 16, kg: 2.20462, g: 0.00220462, ton: 2000 },
};
function UnitConverter() {
  const [cat, setCat] = useState("Length");
  const [val, setVal] = useState(1);
  const [from, setFrom] = useState("ft");
  const [to, setTo] = useState("m");
  const isTemp = cat === "Temperature";
  const units = isTemp ? ["°F", "°C"] : Object.keys(UNITS[cat]);
  const f = units.includes(from) ? from : units[0];
  const t = units.includes(to) ? to : units[1] ?? units[0];
  let out = 0;
  if (isTemp) {
    const c = f === "°F" ? ((val - 32) * 5) / 9 : val;
    out = t === "°C" ? c : (c * 9) / 5 + 32;
  } else {
    out = (val * UNITS[cat][f]) / UNITS[cat][t];
  }
  function changeCat(next: string) {
    setCat(next);
    const u = next === "Temperature" ? ["°F", "°C"] : Object.keys(UNITS[next]);
    setFrom(u[0]);
    setTo(u[1] ?? u[0]);
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Category"><Select value={cat} onChange={(e) => changeCat(e.target.value)}>{[...Object.keys(UNITS), "Temperature"].map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Value"><NumberInput value={val} onValueChange={setVal} /></Field>
        <Field label="From"><Select value={f} onChange={(e) => setFrom(e.target.value)}>{units.map((u) => <option key={u}>{u}</option>)}</Select></Field>
        <Field label="To"><Select value={t} onChange={(e) => setTo(e.target.value)}>{units.map((u) => <option key={u}>{u}</option>)}</Select></Field>
      </div>
      <Result>
        <strong>{val}</strong> {f} = <strong>{out.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong> {t}
      </Result>
    </div>
  );
}

/* ── ELECTRICAL (phase 2) ─────────────────────────────────────────────── */
function MotorFLC() {
  const [phase, setPhase] = useState("3φ");
  const [volts, setVolts] = useState("230V");
  const [hp, setHp] = useState("5");
  const vOpts = Object.keys(MOTOR_FLC[phase]);
  const v = vOpts.includes(volts) ? volts : vOpts[0];
  const hpOpts = Object.keys(MOTOR_FLC[phase][v]);
  const h = hpOpts.includes(hp) ? hp : hpOpts[0];
  const flc = MOTOR_FLC[phase][v][h];
  const breaker = nextBreaker(flc * 2.5);
  const changePhase = (p: string) => { setPhase(p); setVolts(Object.keys(MOTOR_FLC[p])[0]); };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Phase"><Select value={phase} onChange={(e) => changePhase(e.target.value)}>{Object.keys(MOTOR_FLC).map((p) => <option key={p}>{p}</option>)}</Select></Field>
        <Field label="Voltage"><Select value={v} onChange={(e) => setVolts(e.target.value)}>{vOpts.map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label="Motor HP"><Select value={h} onChange={(e) => setHp(e.target.value)}>{hpOpts.map((x) => <option key={x} value={x}>{x} hp</option>)}</Select></Field>
      </div>
      <Result tone="green">
        FLC <strong>{flc} A</strong> · breaker (inverse-time, 250%) <strong>{breaker} A</strong> · overload <strong>{(flc * 1.15).toFixed(1)}–{(flc * 1.25).toFixed(1)} A</strong>
      </Result>
      <p className="text-xs text-slate-400">FLC per NEC 430.248/430.250 — use the table value (not nameplate) for branch-circuit + breaker sizing; overload uses the nameplate FLA × service factor.</p>
    </div>
  );
}

function KvaAmps() {
  const [phase, setPhase] = useState<"1" | "3">("3");
  const [volts, setVolts] = useState(240);
  const [kva, setKva] = useState(45);
  const [pf, setPf] = useState(1);
  const root = phase === "3" ? Math.sqrt(3) : 1;
  const amps = volts > 0 && pf > 0 ? (kva * 1000) / (root * volts * pf) : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Phase"><Select value={phase} onChange={(e) => setPhase(e.target.value as "1" | "3")}><option value="1">1-phase</option><option value="3">3-phase</option></Select></Field>
        <Field label="Volts"><NumberInput value={volts} onValueChange={setVolts} /></Field>
        <Field label="kVA"><NumberInput value={kva} onValueChange={setKva} /></Field>
        <Field label="Power factor"><NumberInput value={pf} onValueChange={setPf} /></Field>
      </div>
      <Result><strong>{kva} kVA</strong> at {volts} V {phase}-phase = <strong>{amps.toFixed(1)} A</strong></Result>
    </div>
  );
}

function Derating() {
  const [size, setSize] = useState("8");
  const [metal, setMetal] = useState<"cu" | "al">("cu");
  const [ambF, setAmbF] = useState(86);
  const [count, setCount] = useState(3);
  const base = (metal === "cu" ? AMPACITY_CU : AMPACITY_AL)[size] ?? 0;
  const tf = ambientFactor(ambF);
  const bf = bundleFactor(count);
  const derated = base * tf * bf;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Wire size"><Select value={size} onChange={(e) => setSize(e.target.value)}>{SIZES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
        <Field label="Metal"><Select value={metal} onChange={(e) => setMetal(e.target.value as "cu" | "al")}><option value="cu">Copper</option><option value="al">Aluminum</option></Select></Field>
        <Field label="Ambient °F"><NumberInput value={ambF} onValueChange={setAmbF} /></Field>
        <Field label="# current-carrying"><NumberInput value={count} onValueChange={setCount} /></Field>
      </div>
      <Result tone={derated < base ? "amber" : "green"}>
        Base {base} A (75°C) × temp {tf} × bundling {bf} = <strong>{derated.toFixed(1)} A</strong> usable
      </Result>
      <p className="text-xs text-slate-400">Ambient correction NEC 310.15(B)(1) (86°F = 1.0); bundling 310.15(C)(1) for 4+ current-carrying conductors.</p>
    </div>
  );
}

function SolarBusbar() {
  const [bus, setBus] = useState(200);
  const [main, setMain] = useState(200);
  const [pv, setPv] = useState(40);
  const limit = bus * 1.2;
  const sum = main + pv;
  const ok = sum <= limit;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Busbar rating A"><NumberInput value={bus} onValueChange={setBus} /></Field>
        <Field label="Main breaker A"><NumberInput value={main} onValueChange={setMain} /></Field>
        <Field label="PV breaker A"><NumberInput value={pv} onValueChange={setPv} /></Field>
      </div>
      <Result tone={ok ? "green" : "red"}>
        Main + PV = <strong>{sum} A</strong> vs 120% of busbar = <strong>{limit.toFixed(0)} A</strong> → {ok ? "OK to back-feed" : "exceeds — move PV to the opposite end, supply-side tap, or downsize the main"}
      </Result>
      <p className="text-xs text-slate-400">NEC 705.12(B)(3)(2): busbar × 120% ≥ main OCPD + PV OCPD, with the PV breaker at the opposite end of the bus.</p>
    </div>
  );
}

function GfciAfci() {
  const [area, setArea] = useState(PROTECTION[0].area);
  const sel = PROTECTION.find((p) => p.area === area) ?? PROTECTION[0];
  return (
    <div className="space-y-3">
      <Field label="Location / area"><Select value={area} onChange={(e) => setArea(e.target.value)}>{PROTECTION.map((p) => <option key={p.area}>{p.area}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Result tone={sel.gfci ? "amber" : "green"}>GFCI: <strong>{sel.gfci ? "Required" : "Not required"}</strong></Result>
        <Result tone={sel.afci ? "amber" : "green"}>AFCI: <strong>{sel.afci ? "Required" : "Not required"}</strong></Result>
      </div>
      <p className="text-xs text-slate-400">{sel.ref} · dwelling units, ~NEC 2020. The 2023 NEC expands AFCI/GFCI — verify your AHJ's adopted edition.</p>
    </div>
  );
}

/* ── ESTIMATING (phase 2) ─────────────────────────────────────────────── */
function ConcreteFooting() {
  const [L, setL] = useState(20);
  const [W, setW] = useState(16);
  const [D, setD] = useState(8);
  const [count, setCount] = useState(1);
  const [waste, setWaste] = useState(7);
  const cfPer = L * (W / 12) * (D / 12); // length ft, width/depth inches
  const cf = cfPer * count * (1 + waste / 100);
  const cy = cf / 27;
  const bags60 = Math.ceil(cf / 0.45);
  const bags80 = Math.ceil(cf / 0.6);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Length (ft)"><NumberInput value={L} onValueChange={setL} /></Field>
        <Field label="Width (in)"><NumberInput value={W} onValueChange={setW} /></Field>
        <Field label="Depth (in)"><NumberInput value={D} onValueChange={setD} /></Field>
        <Field label="# footings"><NumberInput value={count} onValueChange={setCount} /></Field>
        <Field label="Waste %"><NumberInput value={waste} onValueChange={setWaste} /></Field>
      </div>
      <Result tone={cy <= 1.5 ? "green" : cy <= 3 ? "amber" : "red"}>
        <strong>{cy.toFixed(2)} cubic yards</strong> total ({cf.toFixed(1)} ft³ incl. {waste}% waste) · <strong>{bags80}</strong> × 80-lb <em>or</em> <strong>{bags60}</strong> × 60-lb bags
      </Result>
    </div>
  );
}

function Framing() {
  const [L, setL] = useState(20);
  const [oc, setOc] = useState(16);
  const [corners, setCorners] = useState(2);
  const [openings, setOpenings] = useState(1);
  const studs = Math.ceil((L * 12) / oc) + 1 + corners * 2 + openings * 2;
  const plate = L * 3; // single bottom + double top
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Wall length (ft)"><NumberInput value={L} onValueChange={setL} /></Field>
        <Field label="Stud spacing"><Select value={String(oc)} onChange={(e) => setOc(Number(e.target.value))}><option value="16">16&quot; OC</option><option value="24">24&quot; OC</option></Select></Field>
        <Field label="# corners"><NumberInput value={corners} onValueChange={setCorners} /></Field>
        <Field label="# openings"><NumberInput value={openings} onValueChange={setOpenings} /></Field>
      </div>
      <Result><strong>{studs} studs</strong> · <strong>{plate} ft</strong> of plate stock (1 bottom + 2 top)</Result>
    </div>
  );
}

function Drywall() {
  const [area, setArea] = useState(500);
  const [sheet, setSheet] = useState(32);
  const [waste, setWaste] = useState(10);
  const adj = area * (1 + waste / 100);
  const sheets = Math.ceil(adj / sheet);
  const mud = (area / 100) * 20; // lbs, 2-coat all-purpose
  const tape = Math.ceil((area / 100) * 100); // ft, walls (rough)
  const screws = sheets * 32;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Area (ft²)"><NumberInput value={area} onValueChange={setArea} /></Field>
        <Field label="Sheet size"><Select value={String(sheet)} onChange={(e) => setSheet(Number(e.target.value))}><option value="32">4×8 (32 ft²)</option><option value="48">4×12 (48 ft²)</option></Select></Field>
        <Field label="Waste %"><NumberInput value={waste} onValueChange={setWaste} /></Field>
      </div>
      <Result>
        <strong>{sheets} sheets</strong> · ~<strong>{mud.toFixed(0)} lb</strong> mud · ~<strong>{tape} ft</strong> tape · ~<strong>{screws}</strong> screws
      </Result>
      <p className="text-xs text-slate-400">Rough 2-coat estimate; tape varies with layout — buy ~15% extra.</p>
    </div>
  );
}

/* ── registry + packaged, searchable view ─────────────────────────────── */
type Pkg = "Electrical" | "Estimating" | "Money" | "Field";
const PKG_TONE: Record<Pkg, string> = {
  Electrical: "bg-amber-100 text-amber-700",
  Estimating: "bg-blue-100 text-blue-700",
  Money: "bg-green-100 text-green-700",
  Field: "bg-violet-100 text-violet-700",
};
type Tool = { id: string; name: string; pkg: Pkg; desc: string; icon: LucideIcon; render: () => React.ReactNode };
const TOOLS: Tool[] = [
  { id: "wire-size", name: "Wire size picker", pkg: "Electrical", desc: "Smallest AWG that meets ampacity + voltage drop", icon: Cable, render: () => <WireSize /> },
  { id: "voltage-drop", name: "Voltage drop", pkg: "Electrical", desc: "Volts + % dropped over a run", icon: Zap, render: () => <VoltageDrop /> },
  { id: "conduit-fill", name: "Conduit fill", pkg: "Electrical", desc: "Min conduit for THHN at 40% NEC fill", icon: Cable, render: () => <ConduitFill /> },
  { id: "ohms", name: "Ohm's law / load", pkg: "Electrical", desc: "V · I · P · R and breaker size", icon: Calculator, render: () => <OhmsLaw /> },
  { id: "box-fill", name: "Box fill (NEC 314.16)", pkg: "Electrical", desc: "Required box volume + box size", icon: Box, render: () => <BoxFill /> },
  { id: "motor-flc", name: "Motor FLC + breaker", pkg: "Electrical", desc: "Full-load amps, breaker, overload (NEC 430)", icon: Fan, render: () => <MotorFLC /> },
  { id: "kva-amps", name: "kVA ↔ amps", pkg: "Electrical", desc: "Transformer / generator sizing, 1φ & 3φ", icon: Plug, render: () => <KvaAmps /> },
  { id: "derating", name: "Ampacity derating", pkg: "Electrical", desc: "Temp + bundling adjusted ampacity", icon: Thermometer, render: () => <Derating /> },
  { id: "gfci-afci", name: "GFCI / AFCI lookup", pkg: "Electrical", desc: "Where protection is required (210.8 / 210.12)", icon: ShieldCheck, render: () => <GfciAfci /> },
  { id: "solar-busbar", name: "Solar 120% busbar", pkg: "Electrical", desc: "PV back-feed busbar check (705.12)", icon: Sun, render: () => <SolarBusbar /> },
  { id: "board-feet", name: "Board feet", pkg: "Estimating", desc: "Lumber board-foot volume", icon: Ruler, render: () => <BoardFeet /> },
  { id: "concrete-slab", name: "Concrete (slab)", pkg: "Estimating", desc: "Cubic yards + bag count for a slab", icon: Layers, render: () => <ConcreteSlab /> },
  { id: "paint", name: "Paint coverage", pkg: "Estimating", desc: "Gallons to paint a room", icon: PaintBucket, render: () => <Paint /> },
  { id: "concrete-footing", name: "Concrete (footing)", pkg: "Estimating", desc: "Yards + bags for footings / piers", icon: Layers, render: () => <ConcreteFooting /> },
  { id: "framing", name: "Framing studs", pkg: "Estimating", desc: "Stud count + plate stock for a wall", icon: Frame, render: () => <Framing /> },
  { id: "drywall", name: "Drywall + finish", pkg: "Estimating", desc: "Sheets, mud, tape, screws", icon: Square, render: () => <Drywall /> },
  { id: "markup", name: "Markup ↔ margin", pkg: "Money", desc: "Convert markup, margin, sell price", icon: Percent, render: () => <MarkupMargin /> },
  { id: "job-profit", name: "Job profit", pkg: "Money", desc: "Profit + margin on a quote", icon: TrendingUp, render: () => <JobProfit /> },
  { id: "labor-burden", name: "Labor burden", pkg: "Money", desc: "True loaded labor cost per hour", icon: HardHat, render: () => <LaborBurden /> },
  { id: "sales-tax", name: "Sales tax", pkg: "Money", desc: "Add tax or back it out of a total", icon: Receipt, render: () => <SalesTax /> },
  { id: "right-triangle", name: "Right triangle", pkg: "Field", desc: "Solve sides + angles (3-4-5)", icon: Triangle, render: () => <RightTriangle /> },
  { id: "conduit-offset", name: "Conduit offset", pkg: "Field", desc: "Bend multiplier, spacing, shrink", icon: Spline, render: () => <ConduitOffset /> },
  { id: "fraction", name: "Decimal ↔ fraction", pkg: "Field", desc: "Decimal inch to a tape-measure mark", icon: Ruler, render: () => <FractionConvert /> },
  { id: "unit-convert", name: "Unit converter", pkg: "Field", desc: "Length, area, volume, weight, temp", icon: ArrowRightLeft, render: () => <UnitConverter /> },
];

export function ToolsView() {
  const [pkg, setPkg] = useState<"All" | Pkg>("All");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return TOOLS.filter(
      (t) =>
        (pkg === "All" || t.pkg === pkg) &&
        (!query || t.name.toLowerCase().includes(query) || t.desc.toLowerCase().includes(query) || t.pkg.toLowerCase().includes(query)),
    );
  }, [pkg, q]);

  const chips: ("All" | Pkg)[] = ["All", "Electrical", "Estimating", "Money", "Field"];
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools — voltage, concrete, margin…" className="pl-9" />
      </div>

      <div className="flex flex-wrap gap-2">
        {chips.map((p) => {
          const count = p === "All" ? TOOLS.length : TOOLS.filter((t) => t.pkg === p).length;
          const active = pkg === p;
          return (
            <button
              key={p}
              onClick={() => setPkg(p)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${active ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              {p} <span className={active ? "text-white/70" : "text-slate-400"}>{count}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-2.5">
        {filtered.length === 0 && <p className="py-10 text-center text-sm text-slate-400">No tools match “{q}”.</p>}
        {filtered.map((t) => {
          const Icon = t.icon;
          const isOpen = open.has(t.id);
          return (
            <Card key={t.id} className="overflow-hidden">
              <button onClick={() => toggle(t.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{t.name}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PKG_TONE[t.pkg]}`}>{t.pkg}</span>
                  </span>
                  <span className="block truncate text-xs text-slate-500">{t.desc}</span>
                </span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              {isOpen && <div className="border-t border-slate-100 p-4">{t.render()}</div>}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
