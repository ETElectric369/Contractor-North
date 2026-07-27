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
/**
 * Ampacity, ALL THREE temperature columns (NEC 310.16). One column is not enough, and shipping
 * only 75°C was a real bug: NM cable (Romex) is a 60°C conductor by 334.80, so a 50A range
 * circuit sized off the 75°C column came back #8 when the correct answer is #6.
 *
 * WHICH COLUMN APPLIES is the judgment in this calculator, so it is an explicit input and the
 * answer always names the column it used:
 *   - NM / UF cable      → 60°C, always (334.80 / 340.80), regardless of what the panel is rated.
 *   - Conductors in a raceway → the TERMINATION rating governs (110.14(C)). ≤100A circuits are
 *     60°C unless the equipment is listed and marked for 75°C — most modern breakers and panels
 *     are marked 60/75°C, which is why 75°C is the default for raceway work, but it is an
 *     ASSUMPTION about the customer's gear, not a fact, so we say so in the output.
 *   - 90°C is never a termination column. It exists only as the starting point for derating
 *     (334.80 lets NM derate from the 90°C value as long as the result is clamped to 60°C).
 */
const AMPACITY_CU: Record<"60" | "75" | "90", Record<string, number>> = {
  "60": { "14": 15, "12": 20, "10": 30, "8": 40, "6": 55, "4": 70, "3": 85, "2": 95, "1": 110, "1/0": 125, "2/0": 145, "3/0": 165, "4/0": 195, "250": 215, "300": 240, "350": 260, "500": 320 },
  "75": { "14": 20, "12": 25, "10": 35, "8": 50, "6": 65, "4": 85, "3": 100, "2": 115, "1": 130, "1/0": 150, "2/0": 175, "3/0": 200, "4/0": 230, "250": 255, "300": 285, "350": 310, "500": 380 },
  "90": { "14": 25, "12": 30, "10": 40, "8": 55, "6": 75, "4": 95, "3": 115, "2": 130, "1": 145, "1/0": 170, "2/0": 195, "3/0": 225, "4/0": 260, "250": 290, "300": 320, "350": 350, "500": 430 },
};
const AMPACITY_AL: Record<"60" | "75" | "90", Record<string, number>> = {
  // NOTE: 10 AWG at 75°C is 30, not 35. The old single table carried 35 — the 90°C value — in a
  // table labelled 75°C, so every 31–35A aluminum answer was one size undersized.
  "60": { "12": 15, "10": 25, "8": 30, "6": 40, "4": 55, "3": 65, "2": 75, "1": 85, "1/0": 100, "2/0": 115, "3/0": 130, "4/0": 150, "250": 170, "300": 195, "350": 210, "500": 260 },
  "75": { "12": 20, "10": 30, "8": 40, "6": 50, "4": 65, "3": 75, "2": 90, "1": 100, "1/0": 120, "2/0": 135, "3/0": 155, "4/0": 180, "250": 205, "300": 230, "350": 250, "500": 310 },
  "90": { "12": 25, "10": 35, "8": 45, "6": 55, "4": 75, "3": 85, "2": 100, "1": 115, "1/0": 135, "2/0": 150, "3/0": 175, "4/0": 205, "250": 230, "300": 260, "350": 280, "500": 350 },
};

/**
 * NEC 240.4(D) — THE SMALL-CONDUCTOR RULE. A hard cap on the overcurrent device for the three
 * smallest copper and two smallest aluminum sizes, *regardless* of what the ampacity table says.
 * This is why a 20A circuit is #12 and not #14: #14 Cu is listed at 20A in the 75°C column, but
 * 240.4(D)(3) forbids protecting it above 15A. Omitting this rule is the single most dangerous
 * thing a wire-size calculator can do, because it errs small on the most common circuits in a house.
 * Sizes not listed here have no small-conductor cap.
 */
const MAX_OCPD_CU: Record<string, number> = { "14": 15, "12": 20, "10": 30 };
const MAX_OCPD_AL: Record<string, number> = { "12": 15, "10": 25 };
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

/* THE tables, exported so the /tools calculators read the SAME numbers as the assistant. They used
 * to be copy-pasted into tools-view.tsx, which meant a table fix landed in one place and not the
 * other — exactly how the 75°C-labelled 90°C aluminum value survived in both copies. */
export const AWG_SIZES = ORDER;
export const ampacityAt = (metal: "cu" | "al", col: "60" | "75" | "90", size: string): number =>
  (metal === "al" ? AMPACITY_AL : AMPACITY_CU)[col][size] ?? 0;
/** NEC 240.4(D) cap for a size, or null where the rule doesn't reach. */
export const maxOcpdFor = (metal: "cu" | "al", size: string): number | null =>
  (metal === "al" ? MAX_OCPD_AL : MAX_OCPD_CU)[size] ?? null;

/** Voltage drop for a run. phase: 1 or 3. Returns volts dropped, % of source, and pass (≤3% branch). */
export function voltageDrop(p: { amps: number; lengthFt: number; sizeAwg: string; metal?: "cu" | "al"; phase?: 1 | 3; sourceVolts: number }) {
  const cmil = CMIL[p.sizeAwg];
  if (!cmil) return { error: `Unknown wire size "${p.sizeAwg}". Use AWG/kcmil like 12, 1/0, 250.` };
  const factor = p.phase === 3 ? Math.sqrt(3) : 2;
  const vd = (factor * K(p.metal ?? "cu") * p.amps * p.lengthFt) / cmil;
  const pct = p.sourceVolts > 0 ? (vd / p.sourceVolts) * 100 : 0;
  return { volts_dropped: Math.round(vd * 100) / 100, percent: Math.round(pct * 100) / 100, ok_under_3pct: pct <= 3, voltage_at_load: Math.round((p.sourceVolts - vd) * 10) / 10 };
}

/** How the conductor is run. This picks the ampacity column, so it changes the answer. */
export type WiringMethod = "nm" | "uf" | "raceway";

/**
 * Smallest conductor for a circuit of `amps`, honouring BOTH limits that apply:
 *   1. ampacity in the governing temperature column (NEC 310.16, column chosen per method above), and
 *   2. the NEC 240.4(D) small-conductor cap on the overcurrent device.
 *
 * `amps` is the CIRCUIT / breaker rating, which is how the question actually gets asked in the
 * field ("what wire for a 20A circuit"). Derating starts from the 90°C column and is clamped to
 * the governing column — that is 334.80 for NM and standard 110.14(C) practice for THHN in a
 * raceway; it is never allowed to produce an answer above the termination rating.
 *
 * The answer always reports which column and which rule decided it, because the column choice is
 * an assumption about the customer's equipment and a number without its basis is not verifiable.
 */
export function wireSizeForLoad(p: {
  amps: number;
  metal?: "cu" | "al";
  derate?: number;
  method?: WiringMethod;
  termination_c?: 60 | 75;
}) {
  const metal = p.metal ?? "cu";
  const method = p.method ?? "raceway";
  const cable = method === "nm" || method === "uf";
  // NM/UF are 60°C conductors by code and no equipment marking can change that.
  const col: "60" | "75" = cable ? "60" : p.termination_c === 60 ? "60" : "75";
  const tbl = metal === "al" ? AMPACITY_AL : AMPACITY_CU;
  const caps = metal === "al" ? MAX_OCPD_AL : MAX_OCPD_CU;
  const d = p.derate && p.derate > 0 ? p.derate : 1;

  let blockedBySmallConductor = false;
  for (const size of ORDER) {
    const ampTerm = tbl[col][size];
    if (!ampTerm) continue; // aluminum isn't listed below 12 AWG
    // Derate off the 90°C column, then clamp to the governing column (334.80 / 110.14(C)).
    const effective = Math.min(tbl["90"][size] * d, ampTerm);
    const cap = caps[size] ?? Infinity;
    if (effective < p.amps) continue;
    if (cap < p.amps) {
      // Carries the current, but code forbids protecting it at this breaker size. Keep going.
      blockedBySmallConductor = true;
      continue;
    }
    const why = blockedBySmallConductor
      ? `NEC 240.4(D) — a smaller conductor had the ampacity but may not be protected at ${p.amps}A`
      : d < 1
        ? "derated ampacity"
        : "ampacity";
    return {
      size_awg: size,
      metal,
      wiring_method: method,
      ampacity_column: `${col}°C`,
      ampacity: ampTerm,
      derated_ampacity: Math.round(effective),
      max_ocpd_amps: Number.isFinite(cap) ? cap : null,
      limited_by: why,
      basis: [
        `NEC 310.16 ${col}°C column`,
        cable ? `NEC ${method === "nm" ? "334.80" : "340.80"} — ${method.toUpperCase()} cable uses the 60°C column` : null,
        blockedBySmallConductor ? "NEC 240.4(D) small-conductor rule" : null,
        !cable && col === "75" ? "assumes terminations listed 75°C — verify the panel/breaker marking" : null,
        d < 1 ? `derate ${d} applied to the 90°C ampacity, clamped to ${col}°C` : null,
      ].filter(Boolean).join("; "),
    };
  }
  return { error: `No listed size carries ${p.amps}A on ${metal} in the ${col}°C column — use parallel sets or a bus.` };
}

/** Smallest conduit (per type) that holds the given conductors at 40% fill. conductors: [{size, count}]. */
export function conduitFill(p: { conductors: { size_awg: string; count: number }[]; conduit_type?: string }) {
  const type = p.conduit_type && CONDUIT_FILL[p.conduit_type] ? p.conduit_type : "EMT";
  let count = 0;
  let area = 0;
  for (const c of p.conductors) {
    count += Math.max(0, Number(c.count) || 0);
    const a = THHN_AREA[c.size_awg];
    if (!a) return { error: `Unknown wire size "${c.size_awg}".` };
    area += a * (c.count || 0);
  }
  /**
   * THE FILL LIMIT DEPENDS ON THE CONDUCTOR COUNT (NEC ch.9 table 1) — it is not always 40%.
   * This calculator only ever applied 40%, which is right for three or more conductors and WRONG
   * for the two cases below it: a two-wire run is limited to 31%, so 40% under-sizes the pipe and
   * the estimate buys conduit that won't pass; a single conductor is allowed 53%, so 40% oversizes
   * it and the customer pays for pipe they don't need. Both errors are quiet.
   */
  const limit = count === 1 ? 0.53 : count === 2 ? 0.31 : 0.4;
  const sizes = CONDUIT_FILL[type]; // tabulated at 40%, so recover the raw internal area
  const usable = (trade: string) => (sizes[trade] / 0.4) * limit;
  const fit = Object.keys(sizes).find((trade) => usable(trade) >= area);
  const pct = Math.round(limit * 100);
  return {
    conduit_type: type,
    conductor_count: count,
    fill_limit_percent: pct,
    total_conductor_area_in2: Math.round(area * 1000) / 1000,
    recommended_size: fit ?? null,
    fill_percent_at_recommended: fit ? Math.round((area / (sizes[fit] / 0.4)) * 100) : null,
    note: fit
      ? `${fit} ${type} fits at ≤${pct}% fill (NEC ch.9 table 1: ${count === 1 ? "one conductor 53%" : count === 2 ? "two conductors 31%" : "over two conductors 40%"}).`
      : `Needs larger than ${Object.keys(sizes).slice(-1)[0]} ${type} at the ${pct}% limit.`,
  };
}

/** Box fill: required in³ + the smallest standard box that holds it (NEC 314.16). devices each = 2×. */
export function boxFill(p: { wire_size_awg: string; conductors: number; devices?: number; has_grounds?: boolean; has_clamps?: boolean }) {
  const per = BOX_VOL[p.wire_size_awg];
  // An ERROR here is the worst outcome, because it sends the model straight back to reasoning the
  // table from memory — the exact failure this tool exists to prevent. NEC 314.16(B) genuinely
  // stops at 6 AWG; above that the box is sized by 314.28 pull-box rules, which are a different
  // calculation. So SAY that, and say what to do instead, rather than returning a bare failure.
  if (!per)
    return {
      error: `NEC 314.16 volume allowances only cover 14–6 AWG; ${p.wire_size_awg} is outside the table.`,
      guidance:
        "Conductors larger than 6 AWG are not sized by box fill — a junction or pull box for them is sized by NEC 314.28 (straight pulls: 8× the largest raceway; angle/U pulls: 6×). Do NOT estimate a standard device box for this. Ask the user, or size the pull box by 314.28.",
    };
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
    description:
      "Smallest copper/aluminum conductor for a circuit, honouring BOTH the NEC 310.16 ampacity tables AND the NEC 240.4(D) small-conductor rule. ALWAYS pass `method`: NM/Romex and UF are 60°C conductors (334.80/340.80) and give a LARGER wire than conduit for the same amperage — a 50A range circuit is #6 on NM but #8 in conduit. Returns the size plus the column and code rule it used; read that basis back to the user rather than the bare size.",
    input_schema: {
      type: "object",
      required: ["amps", "method"],
      properties: {
        amps: { type: "number", description: "the CIRCUIT/breaker rating in amps (e.g. 20 for a 20A circuit)" },
        metal: { type: "string", enum: ["cu", "al"], description: "copper (default) or aluminum" },
        method: { type: "string", enum: ["nm", "uf", "raceway"], description: "nm = NM-B/Romex (most residential branch circuits), uf = direct-burial UF, raceway = individual conductors (THHN/THWN) in conduit. Ask the user if it isn't clear." },
        termination_c: { type: "number", enum: [60, 75], description: "raceway only: termination temperature rating of the breaker/lugs. Default 75 (typical modern gear). Ignored for nm/uf, which are always 60°C." },
        derate: { type: "number", description: "combined ambient/bundling derate factor 0–1 (e.g. 0.8); omit if none" },
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
