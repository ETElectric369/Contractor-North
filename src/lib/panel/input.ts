/**
 * WHAT A PANEL OR CIRCUIT WRITE MAY CARRY (Panel plan, phase 1). Pure: the server actions call these
 * before any write, so a field the form never offered (a price, a part number, verified_by, org_id,
 * the provenance) cannot ride in on a hand-built request. The database says the same things again
 * (0333's checks and guard); this is where the sentence a person reads comes from.
 */
import type { CircuitKind, CircuitProgress, CircuitWork, JobCircuit, JobPanel, PanelNumbering, SpaceHalf } from "@/lib/types";

export const AMP_SIZES = [10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225] as const;
export const KINDS: CircuitKind[] = ["standard", "afci", "gfci", "dual_function", "spd"];
export const WORKS: CircuitWork[] = ["new", "existing", "reused", "removed"];
export const PROGRESSES: CircuitProgress[] = ["planned", "roughed", "done"];

/** The circuit fields a person edits. Nothing else is ever written from a form. */
export const CIRCUIT_FIELDS = [
  "room", "description", "panel_label", "amps", "poles", "kind", "wire", "wire_tag",
  "space", "half", "work", "progress", "panel_id", "sort_order",
] as const;
export type CircuitPatch = Partial<Pick<JobCircuit, (typeof CIRCUIT_FIELDS)[number]>>;

/** The panel fields a person edits. shown_on_portal is NOT here: the office's switch is its own door
 *  (phase 5), and the database refuses it from anyone else. */
export const PANEL_FIELDS = ["name", "brand", "bus_amps", "main_amps", "spaces", "numbering", "dead_spaces", "twin_spaces", "photo_document_id", "notes"] as const;
export type PanelPatch = Partial<Pick<JobPanel, (typeof PANEL_FIELDS)[number]>>;

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

function text(v: unknown, max: number, what: string): Ok<string | null> | Err {
  if (v == null) return { ok: true, value: null };
  if (typeof v !== "string" && typeof v !== "number") return { ok: false, error: `${what} has to be words.` };
  const s = String(v).replace(/\s+/g, " ").trim();
  if (s.length > max) return { ok: false, error: `${what} is too long. Keep it under ${max} characters.` };
  return { ok: true, value: s || null };
}

function int(v: unknown, lo: number, hi: number, what: string): Ok<number | null> | Err {
  if (v == null || v === "") return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) return { ok: false, error: `${what} has to be a whole number from ${lo} to ${hi}.` };
  return { ok: true, value: n };
}

/** "3, 5 7" or [3,5,7] → [3,5,7], sorted, once each. */
export function parseSpaceList(v: unknown, max = 84): Ok<number[]> | Err {
  const parts = Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/);
  const out = new Set<number>();
  for (const p of parts) {
    if (p === "" || p == null) continue;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false, error: `Spaces are numbers from 1 to ${max}. "${p}" isn't one.` };
    out.add(n);
  }
  return { ok: true, value: [...out].sort((a, b) => a - b) };
}

export function normalizeCircuitPatch(input: Record<string, unknown>): Ok<CircuitPatch> | Err {
  const out: CircuitPatch = {};
  for (const k of Object.keys(input ?? {})) {
    if (!(CIRCUIT_FIELDS as readonly string[]).includes(k)) return { ok: false, error: "That isn't something a circuit keeps." };
  }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const texts: [keyof CircuitPatch, number, string][] = [
    ["room", 80, "The room"],
    ["description", 200, "What it feeds"],
    ["panel_label", 120, "The door label"],
    ["wire", 40, "The wire"],
    ["wire_tag", 40, "The wire tag"],
  ];
  for (const [k, max, what] of texts) {
    if (!has(k)) continue;
    const t = text(input[k], max, what);
    if (!t.ok) return t;
    (out as Record<string, unknown>)[k] = t.value;
  }
  if (has("amps")) {
    if (input.amps == null || input.amps === "") out.amps = null;
    else {
      const n = Number(input.amps);
      if (!(AMP_SIZES as readonly number[]).includes(n)) return { ok: false, error: `${input.amps} amps isn't a breaker size. Pick 15, 20, 30…` };
      out.amps = n;
    }
  }
  if (has("poles")) {
    const n = Number(input.poles);
    if (![1, 2, 3].includes(n)) return { ok: false, error: "A breaker is 1, 2 or 3 poles." };
    out.poles = n;
  }
  if (has("kind")) {
    if (input.kind == null || input.kind === "") out.kind = null;
    else if (KINDS.includes(input.kind as CircuitKind)) out.kind = input.kind as CircuitKind;
    else return { ok: false, error: "Pick the breaker type from the list." };
  }
  if (has("space")) {
    const s = int(input.space, 1, 84, "The space");
    if (!s.ok) return s;
    out.space = s.value;
    if (s.value == null) out.half = null; // no space, no half
  }
  if (has("half")) {
    if (input.half == null || input.half === "") out.half = null;
    else if (input.half === "A" || input.half === "B") out.half = input.half as SpaceHalf;
    else return { ok: false, error: "The half is A or B." };
  }
  if (has("work")) {
    if (!WORKS.includes(input.work as CircuitWork)) return { ok: false, error: "Pick New, Existing, Reused or Coming Out." };
    out.work = input.work as CircuitWork;
  }
  if (has("progress")) {
    if (!PROGRESSES.includes(input.progress as CircuitProgress)) return { ok: false, error: "Pick Planned, Roughed or Done." };
    out.progress = input.progress as CircuitProgress;
  }
  if (has("panel_id")) {
    if (input.panel_id == null || input.panel_id === "") out.panel_id = null;
    else if (isUuid(input.panel_id)) out.panel_id = input.panel_id;
    else return { ok: false, error: "That panel isn't on this job." };
  }
  if (has("sort_order")) {
    const s = int(input.sort_order, 0, 100000, "The order");
    if (!s.ok) return s;
    out.sort_order = s.value ?? 0;
  }
  return { ok: true, value: out };
}

export function normalizePanelPatch(input: Record<string, unknown>): Ok<PanelPatch> | Err {
  const out: PanelPatch = {};
  for (const k of Object.keys(input ?? {})) {
    if (!(PANEL_FIELDS as readonly string[]).includes(k)) return { ok: false, error: "That isn't something a panel keeps." };
  }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  if (has("name")) {
    const t = text(input.name, 60, "The panel's name");
    if (!t.ok) return t;
    if (!t.value) return { ok: false, error: "Give the panel a name (Main Panel)." };
    out.name = t.value;
  }
  for (const [k, max, what] of [["brand", 60, "The brand"], ["notes", 2000, "The notes"]] as const) {
    if (!has(k)) continue;
    const t = text(input[k], max, what);
    if (!t.ok) return t;
    out[k] = t.value;
  }
  for (const [k, what] of [["bus_amps", "The bus rating"], ["main_amps", "The main breaker"]] as const) {
    if (!has(k)) continue;
    const n = int(input[k], 30, 1200, what);
    if (!n.ok) return n;
    out[k] = n.value;
  }
  if (has("spaces")) {
    const n = int(input.spaces, 1, 84, "The number of spaces");
    if (!n.ok) return n;
    out.spaces = n.value;
  }
  if (has("numbering")) {
    if (input.numbering !== "top_down" && input.numbering !== "bottom_up") return { ok: false, error: "Space 1 is at the top or the bottom." };
    out.numbering = input.numbering as PanelNumbering;
  }
  for (const k of ["dead_spaces", "twin_spaces"] as const) {
    if (!has(k)) continue;
    const l = parseSpaceList(input[k]);
    if (!l.ok) return l;
    out[k] = l.value;
  }
  if (has("photo_document_id")) {
    if (input.photo_document_id == null || input.photo_document_id === "") out.photo_document_id = null;
    else if (isUuid(input.photo_document_id)) out.photo_document_id = input.photo_document_id;
    else return { ok: false, error: "Pick the photo from this job's Photos." };
  }
  return { ok: true, value: out };
}
