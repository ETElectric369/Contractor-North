/**
 * Electrical engineering calculators, as PURE functions + Anthropic tool definitions, so the estimator
 * AI can CALL them for exact NEC numbers (wire size, voltage drop, conduit fill, box fill) instead of
 * reasoning the tables itself. Same tables the /tools calculators use (NEC ch. 9 / 310.16 / 314.16).
 */

/* Circular mils per AWG/kcmil (NEC ch.9 table 8). */
const CMIL: Record<string, number> = {
  "14": 4110, "12": 6530, "10": 10380, "8": 16510, "6": 26240, "4": 41740, "3": 52620, "2": 66360,
  "1": 83690, "1/0": 105600, "2/0": 133100, "3/0": 167800, "4/0": 211600, "250": 250000, "300": 300000,
  "350": 350000, "500": 500000,
};
/* THHN conductor areas, in² (NEC ch.9 table 5). */
const THHN_AREA: Record<string, number> = {
  "14": 0.0097, "12": 0.0133, "10": 0.0211, "8": 0.0366, "6": 0.0507, "4": 0.0824, "3": 0.0973,
  "2": 0.1158, "1": 0.1562, "1/0": 0.1855, "2/0": 0.2223, "3/0": 0.2679, "4/0": 0.3237, "250": 0.397,
  "300": 0.4608, "350": 0.5242, "500": 0.7073,
};
/* 40%-fill conductor area, in², per conduit trade size. */
const CONDUIT_FILL: Record<string, Record<string, number>> = {
  "PVC Sch 40": { '1/2"': 0.114, '3/4"': 0.203, '1"': 0.333, '1-1/4"': 0.581, '1-1/2"': 0.794, '2"': 1.316, '2-1/2"': 1.878, '3"': 2.907, '4"': 5.022 },
  EMT: { '1/2"': 0.122, '3/4"': 0.213, '1"': 0.346, '1-1/4"': 0.598, '1-1/2"': 0.814, '2"': 1.342, '2-1/2"': 2.343, '3"': 3.538, '4"': 5.901 },
};
/* Ampacity, 75°C (NEC 310.16). */
const AMPACITY_CU: Record<string, number> = {
  "14": 20, "12": 25, "10": 35, "8": 50, "6": 65, "4": 85, "3": 100, "2": 115, "1": 130, "1/0": 150,
  "2/0": 175, "3/0": 200, "4/0": 230, "250": 255, "300": 285, "350": 310, "500": 380,
};
const AMPACITY_AL: Record<string, number> = {
  "12": 20, "10": 35, "8": 40, "6": 50, "4": 65, "3": 75, "2": 90, "1": 100, "1/0": 120, "2/0": 135,
  "3/0": 155, "4/0": 180, "250": 205, "300": 230, "350": 250, "500": 310,
};
/* Per-conductor box-fill volume allowance, in³ (NEC 314.16(B)). */
const BOX_VOL: Record<string, number> = { "14": 2.0, "12": 2.25, "10": 2.5, "8": 3.0, "6": 5.0 };
/* Common metal boxes, usable in³ (NEC 314.16(A)). */
const STD_BOXES: { name: string; vol: number }[] = [
  { name: "3×2×2 device", vol: 10.0 }, { name: "3×2×2½ device", vol: 12.5 }, { name: '4" round/oct ×1½', vol: 15.5 },
  { name: "3×2×3½ device", vol: 18.0 }, { name: "4×4×1½ square", vol: 21.0 }, { name: "4×4×2⅛ square", vol: 30.3 },
  { name: "4-11/16×2⅛ square", vol: 42.0 },
];
// EXPLICIT smallest→largest conductor order. (Don't use Object.keys — JS reorders integer-string keys
// numerically, i.e. 1,2,3,…,14, which is BACKWARDS for AWG, so the wire-size search would pick #1 first.)
const ORDER = ["14", "12", "10", "8", "6", "4", "3", "2", "1", "1/0", "2/0", "3/0", "4/0", "250", "300", "350", "500"];

const K = (metal: string) => (metal === "al" ? 21.2 : 12.9); // ohm-cmil/ft, ~75°C

/** Voltage drop for a run. phase: 1 or 3. Returns volts dropped, % of source, and pass (≤3% branch). */
export function voltageDrop(p: { amps: number; lengthFt: number; sizeAwg: string; metal?: "cu" | "al"; phase?: 1 | 3; sourceVolts: number }) {
  const cmil = CMIL[p.sizeAwg];
  if (!cmil) return { error: `Unknown wire size "${p.sizeAwg}". Use AWG/kcmil like 12, 1/0, 250.` };
  const factor = p.phase === 3 ? Math.sqrt(3) : 2;
  const vd = (factor * K(p.metal ?? "cu") * p.amps * p.lengthFt) / cmil;
  const pct = p.sourceVolts > 0 ? (vd / p.sourceVolts) * 100 : 0;
  return { volts_dropped: Math.round(vd * 100) / 100, percent: Math.round(pct * 100) / 100, ok_under_3pct: pct <= 3, voltage_at_load: Math.round((p.sourceVolts - vd) * 10) / 10 };
}

/** Smallest conductor whose 75°C ampacity (× optional derate) carries the load. */
export function wireSizeForLoad(p: { amps: number; metal?: "cu" | "al"; derate?: number }) {
  const tbl = (p.metal ?? "cu") === "al" ? AMPACITY_AL : AMPACITY_CU;
  const d = p.derate && p.derate > 0 ? p.derate : 1;
  for (const size of ORDER) {
    const amp = tbl[size];
    if (amp && amp * d >= p.amps) return { size_awg: size, ampacity_75c: amp, derated_ampacity: Math.round(amp * d), metal: p.metal ?? "cu" };
  }
  return { error: `No listed size carries ${p.amps}A on ${(p.metal ?? "cu")} at 75°C — use parallel sets or a bus.` };
}

/** Smallest conduit (per type) that holds the given conductors at 40% fill. conductors: [{size, count}]. */
export function conduitFill(p: { conductors: { size_awg: string; count: number }[]; conduit_type?: string }) {
  const type = p.conduit_type && CONDUIT_FILL[p.conduit_type] ? p.conduit_type : "EMT";
  let area = 0;
  for (const c of p.conductors) {
    const a = THHN_AREA[c.size_awg];
    if (!a) return { error: `Unknown wire size "${c.size_awg}".` };
    area += a * (c.count || 0);
  }
  const sizes = CONDUIT_FILL[type];
  const fit = Object.keys(sizes).find((trade) => sizes[trade] >= area);
  return {
    conduit_type: type,
    total_conductor_area_in2: Math.round(area * 1000) / 1000,
    recommended_size: fit ?? null,
    fill_percent_at_recommended: fit ? Math.round((area / (sizes[fit] / 0.4)) * 100) : null,
    note: fit ? `${fit} ${type} fits at ≤40% fill.` : `Needs larger than ${Object.keys(sizes).slice(-1)[0]} ${type}.`,
  };
}

/** Box fill: required in³ + the smallest standard box that holds it (NEC 314.16). devices each = 2×. */
export function boxFill(p: { wire_size_awg: string; conductors: number; devices?: number; has_grounds?: boolean; has_clamps?: boolean }) {
  const per = BOX_VOL[p.wire_size_awg];
  if (!per) return { error: `Box-fill volume not listed for ${p.wire_size_awg} (use 14–6 AWG).` };
  const units = (p.conductors || 0) + (p.devices ?? 0) * 2 + (p.has_grounds ? 1 : 0) + (p.has_clamps ? 1 : 0);
  const required = Math.round(units * per * 100) / 100;
  const box = STD_BOXES.find((b) => b.vol >= required);
  return { required_volume_in3: required, volume_allowance_per_unit: per, fill_units: units, recommended_box: box?.name ?? null, recommended_box_volume_in3: box?.vol ?? null, note: box ? `${box.name} (${box.vol} in³) holds it.` : "Exceeds the largest standard box — use a larger enclosure." };
}

/* ── Anthropic tool defs (pure compute — safe for any role) ───────────────── */
export const CALC_TOOLS = [
  {
    name: "calc_voltage_drop",
    description: "Calculate voltage drop on a wire run (NEC). Use to verify a feeder/branch holds ≤3% drop and to upsize wire when a run is long. Returns volts dropped, % of source, and pass/fail.",
    input_schema: {
      type: "object",
      required: ["amps", "lengthFt", "sizeAwg", "sourceVolts"],
      properties: {
        amps: { type: "number", description: "load current in amps" },
        lengthFt: { type: "number", description: "ONE-WAY run length in feet" },
        sizeAwg: { type: "string", description: 'wire size: "12", "1/0", "250", etc.' },
        metal: { type: "string", enum: ["cu", "al"], description: "copper (default) or aluminum" },
        phase: { type: "number", enum: [1, 3], description: "1 = single-phase (default), 3 = three-phase" },
        sourceVolts: { type: "number", description: "source voltage, e.g. 120, 240, 480" },
      },
    },
  },
  {
    name: "calc_wire_size",
    description: "Smallest copper/aluminum conductor that carries a load at 75°C (NEC 310.16). Optional derate factor (ambient/bundling). Use to pick the wire to buy for a given amperage.",
    input_schema: {
      type: "object",
      required: ["amps"],
      properties: {
        amps: { type: "number", description: "load current in amps" },
        metal: { type: "string", enum: ["cu", "al"] },
        derate: { type: "number", description: "combined derate factor 0–1 (e.g. 0.8); omit if none" },
      },
    },
  },
  {
    name: "calc_conduit_fill",
    description: "Smallest EMT or PVC conduit that holds the given THHN conductors at 40% fill (NEC ch.9). Use to size the raceway + price the right conduit.",
    input_schema: {
      type: "object",
      required: ["conductors"],
      properties: {
        conductors: { type: "array", description: "list of conductor groups", items: { type: "object", required: ["size_awg", "count"], properties: { size_awg: { type: "string" }, count: { type: "number" } } } },
        conduit_type: { type: "string", enum: ["EMT", "PVC Sch 40"], description: "default EMT" },
      },
    },
  },
  {
    name: "calc_box_fill",
    description: "Required box volume + the smallest standard box for a count of conductors/devices (NEC 314.16). Use to size + price the right box.",
    input_schema: {
      type: "object",
      required: ["wire_size_awg", "conductors"],
      properties: {
        wire_size_awg: { type: "string", description: "largest conductor size, 14–6 AWG" },
        conductors: { type: "number", description: "count of insulated conductors entering the box" },
        devices: { type: "number", description: "count of devices (each counts as 2)" },
        has_grounds: { type: "boolean" },
        has_clamps: { type: "boolean" },
      },
    },
  },
] as const;

export function runCalc(name: string, input: any): string {
  switch (name) {
    case "calc_voltage_drop": return JSON.stringify(voltageDrop(input));
    case "calc_wire_size": return JSON.stringify(wireSizeForLoad(input));
    case "calc_conduit_fill": return JSON.stringify(conduitFill(input));
    case "calc_box_fill": return JSON.stringify(boxFill(input));
    default: return JSON.stringify({ error: `unknown calc ${name}` });
  }
}

export const CALC_TOOL_NAMES = new Set(CALC_TOOLS.map((t) => t.name));
