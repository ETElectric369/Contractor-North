"use client";

import { useState } from "react";
import { Zap, Cable, Calculator, Ruler } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";

/* Circular mils per AWG/kcmil size (NEC chapter 9). */
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

const SIZES = Object.keys(CMIL);

function Section({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
        <Icon className="h-4 w-4 text-brand" />
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

function VoltageDrop() {
  const [size, setSize] = useState("2/0");
  const [metal, setMetal] = useState<"cu" | "al">("cu");
  const [volts, setVolts] = useState(240);
  const [amps, setAmps] = useState(80);
  const [feet, setFeet] = useState(100);

  const k = metal === "cu" ? 12.9 : 21.2;
  const cm = CMIL[size];
  const vd = volts > 0 && cm ? (2 * k * amps * feet) / cm : 0;
  const pct = volts > 0 ? (vd / volts) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div>
          <Label>Wire size</Label>
          <Select value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((s) => <option key={s} value={s}>{s} AWG/kcmil</option>)}
          </Select>
        </div>
        <div>
          <Label>Metal</Label>
          <Select value={metal} onChange={(e) => setMetal(e.target.value as any)}>
            <option value="cu">Copper</option>
            <option value="al">Aluminum</option>
          </Select>
        </div>
        <div><Label>Volts</Label><NumberInput value={volts} onValueChange={setVolts} /></div>
        <div><Label>Amps</Label><NumberInput value={amps} onValueChange={setAmps} /></div>
        <div><Label>One-way feet</Label><NumberInput value={feet} onValueChange={setFeet} /></div>
      </div>
      <div className={`rounded-lg px-4 py-3 text-sm ${pct > 5 ? "bg-red-50 text-red-700" : pct > 3 ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-700"}`}>
        Drop: <strong>{vd.toFixed(2)} V</strong> ({pct.toFixed(2)}%) →{" "}
        {pct > 5 ? "over 5% — upsize the conductor" : pct > 3 ? "OK for a feeder (≤5%), high for a branch (target ≤3%)" : "within 3% — good"}
      </div>
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
        <div>
          <Label>Conductor size (THHN)</Label>
          <Select value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((s) => <option key={s} value={s}>{s} AWG/kcmil</option>)}
          </Select>
        </div>
        <div><Label># of conductors</Label><NumberInput value={count} onValueChange={setCount} /></div>
        <div>
          <Label>Conduit type</Label>
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.keys(CONDUIT_FILL).map((t) => <option key={t}>{t}</option>)}
          </Select>
        </div>
      </div>
      <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
        Conductor area: <strong>{area.toFixed(3)} in²</strong> →{" "}
        {fit ? (
          <>minimum <strong>{fit} {type}</strong> at 40% fill ({((area / table[fit]) * 100).toFixed(0)}% full)</>
        ) : (
          <strong>too big for a single 4&quot; conduit — split the run</strong>
        )}
      </div>
    </div>
  );
}

function OhmsLaw() {
  const [volts, setVolts] = useState(240);
  const [amps, setAmps] = useState(0);
  const [watts, setWatts] = useState(6800);

  // Whatever two are non-zero drive the rest (V is usually known).
  const i = amps || (volts ? watts / volts : 0);
  const p = watts || volts * amps;
  const r = i > 0 ? volts / i : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div><Label>Volts</Label><NumberInput value={volts} onValueChange={setVolts} /></div>
        <div><Label>Amps (or 0)</Label><NumberInput value={amps} onValueChange={setAmps} /></div>
        <div><Label>Watts (or 0)</Label><NumberInput value={watts} onValueChange={setWatts} /></div>
      </div>
      <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
        I = <strong>{i.toFixed(1)} A</strong> · P = <strong>{Math.round(p)} W</strong> · R = <strong>{r > 0 ? r.toFixed(1) : "—"} Ω</strong>
        {i > 0 && (
          <span className="ml-2 text-slate-500">
            → breaker ≥ <strong>{Math.ceil((i * 1.25) / 5) * 5} A</strong> (125% continuous)
          </span>
        )}
      </div>
    </div>
  );
}

function BoardFeet() {
  const [thick, setThick] = useState(2);
  const [width, setWidth] = useState(6);
  const [lengthFt, setLengthFt] = useState(8);
  const [qty, setQty] = useState(1);

  const bf = ((thick * width * lengthFt) / 12) * qty;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><Label>Thickness (in)</Label><NumberInput value={thick} onValueChange={setThick} /></div>
        <div><Label>Width (in)</Label><NumberInput value={width} onValueChange={setWidth} /></div>
        <div><Label>Length (ft)</Label><NumberInput value={lengthFt} onValueChange={setLengthFt} /></div>
        <div><Label>Quantity</Label><NumberInput value={qty} onValueChange={setQty} /></div>
      </div>
      <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <strong>{bf.toFixed(2)} board feet</strong>
      </div>
    </div>
  );
}

export function ToolsView() {
  return (
    <div className="space-y-5">
      <Section icon={Zap} title="Voltage drop">
        <VoltageDrop />
      </Section>
      <Section icon={Cable} title="Conduit fill (THHN, 40% NEC)">
        <ConduitFill />
      </Section>
      <Section icon={Calculator} title="Ohm's law / load">
        <OhmsLaw />
      </Section>
      <Section icon={Ruler} title="Board feet">
        <BoardFeet />
      </Section>
    </div>
  );
}
