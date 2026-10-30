/**
 * THE PANEL DOOR, MEASURED (the panel-first wave, P0; migration 0402). Pure: no React, no Supabase.
 *
 * Two numbers make a label strip to scale: how tall one space is on the door (the PITCH: a single or
 * a 2-pole handle is one space tall, a tandem's two handles share one), and how wide the label area
 * is beside each column of breakers. A person measures them once with a tape and the panel keeps
 * them (job_panels.space_pitch_in, label_width_in, label_width_in_right). Until then the make's
 * default stands in, from the ONE table below, and nothing writes a default back: a stored number is
 * always one a person measured.
 *
 * The make is read the way the Breakers card reads it (breaker-catalog brandOf): only words that
 * NAME the family decide it, so "Eaton BR" and "Eaton CH" are told apart and a bare "Eaton" or
 * "Square D" falls to the unknown row (1 in). Murray is checked first: brandOf files it under
 * Siemens for ordering breakers, but its door is its own row here.
 */
import type { JobPanel } from "@/lib/types";
import { brandOf, type BrandKey } from "./breaker-catalog";

/** A make's door, in inches: the space pitch and the label area's width beside a column. */
export type DoorDefaults = { pitchIn: number; labelWidthIn: number };

/** A family this table knows: the Breakers card's families, plus Murray's own door. */
export type DoorFamily = BrandKey | "murray";

/**
 * THE ONE TABLE. Siemens, Square D QO, Square D Homeline, Eaton / Cutler-Hammer BR, Murray and GE
 * (PowerMark) are an inch a space; Eaton / Cutler-Hammer CH is three quarters. The label area is
 * 1.125 in on a Siemens door and 1 in on every other. A make not listed (or not named well enough to
 * tell, like a bare "Eaton") reads UNKNOWN_DOOR.
 */
export const DOOR_DEFAULTS: Record<DoorFamily, DoorDefaults> = {
  siemens: { pitchIn: 1, labelWidthIn: 1.125 },
  square_d_qo: { pitchIn: 1, labelWidthIn: 1 },
  square_d_homeline: { pitchIn: 1, labelWidthIn: 1 },
  eaton_br: { pitchIn: 1, labelWidthIn: 1 },
  eaton_ch: { pitchIn: 0.75, labelWidthIn: 1 },
  murray: { pitchIn: 1, labelWidthIn: 1 },
  ge: { pitchIn: 1, labelWidthIn: 1 },
};

/** A make nobody named, or one this table doesn't know: an inch a space, an inch of label. */
export const UNKNOWN_DOOR: DoorDefaults = { pitchIn: 1, labelWidthIn: 1 };

/** The family a panel's brand words name, for its door (null when they name none this table knows). */
export function doorFamily(brand: string | null | undefined): DoorFamily | null {
  if (/\bMURRAY\b/i.test(String(brand ?? ""))) return "murray";
  return brandOf(brand);
}

/** The make's door, from the panel's brand words. Case never matters ("SIEMENS", "siemens"). */
export function brandDefaults(brand: string | null | undefined): DoorDefaults {
  const f = doorFamily(brand);
  return { ...(f ? DOOR_DEFAULTS[f] : UNKNOWN_DOOR) };
}

/** What a panel's door measures: the panel's own numbers where a person measured them, else the
 *  make's. The right label area is the left one's unless it was measured on its own. */
export type PanelGeometry = { pitchIn: number; labelWidthLeftIn: number; labelWidthRightIn: number };

export type GeometryPanel = Pick<JobPanel, "brand"> & Partial<Pick<JobPanel, "space_pitch_in" | "label_width_in" | "label_width_in_right">>;

/** A stored measurement as a number, or null (a numeric column can come back as a string). */
function measured(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function panelGeometry(panel: GeometryPanel): PanelGeometry {
  const d = brandDefaults(panel.brand);
  const left = measured(panel.label_width_in) ?? d.labelWidthIn;
  return {
    pitchIn: measured(panel.space_pitch_in) ?? d.pitchIn,
    labelWidthLeftIn: left,
    labelWidthRightIn: measured(panel.label_width_in_right) ?? left,
  };
}

/** Inches as a person reads them: 1.125, 1, 0.75 (to a thousandth, no trailing zeros). The Door
 *  Labels fields, the Print card and the labels page all say a measurement this way. */
export const inchWords = (n: number): string => String(Math.round(n * 1000) / 1000);

/** The ceilings 0402's checks hold, said once for the form and the database alike. */
export const MAX_PITCH_IN = 3;
export const MAX_LABEL_WIDTH_IN = 6;

/**
 * A tape reading as inches: "1.125", "1 1/8", "1-1/8", "9/8", '1 1/8"', "1.125 in". Null when it
 * isn't a number of inches at all (the caller says so in words). A blank is not a reading: the
 * caller decides what blank means.
 */
export function parseInches(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v
    .trim()
    .replace(/\s*(?:"|''|”|in\.?|inch(?:es)?)$/i, "")
    .trim();
  if (!s) return null;
  if (/^\d*\.?\d+$/.test(s)) return Number(s);
  const mixed = /^(\d+)(?:\s+|\s*-\s*)(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (mixed) return Number(mixed[3]) > 0 ? Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]) : null;
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) return Number(frac[2]) > 0 ? Number(frac[1]) / Number(frac[2]) : null;
  return null;
}
