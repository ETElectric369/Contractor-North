import type { Playbook } from "./types";

/**
 * THE MEASUREMENTS AN ORG CAN COUNT BY (0241). A price-list item is "counted per" one of these:
 * the two built-in dimensions the deck flow already derives (area, length), then every walk-through
 * need marked `measured` with a number slot — conduit run, device count, ceiling height, stair
 * steps, doors — whatever THIS company's own questions measure. Pure; the pages feed it the org's
 * playbooks (every form that has one), deduped by key, first label wins.
 */
export type MeasurementOption = { key: string; label: string; unit: string | null; builtIn?: boolean };

export const BUILT_IN_MEASUREMENTS: MeasurementOption[] = [
  { key: "area_sqft", label: "Square feet of the job", unit: "sq ft", builtIn: true },
  { key: "length_lf", label: "Linear feet of the job", unit: "ft", builtIn: true },
];

export function measurementOptions(playbooks: Array<Playbook | null | undefined>): MeasurementOption[] {
  const out: MeasurementOption[] = [...BUILT_IN_MEASUREMENTS];
  const seen = new Set(out.map((o) => o.key));
  for (const pb of playbooks) {
    for (const n of pb?.needs ?? []) {
      if (!n.measured || n.slot?.type !== "number" || !n.key || seen.has(n.key)) continue;
      seen.add(n.key);
      out.push({ key: n.key, label: n.label || n.key, unit: n.slot.unit?.trim() || null });
    }
  }
  return out;
}

/** The label to show for a key — a known measurement's label, else the key made readable. */
export function measurementLabel(key: string | null | undefined, options: MeasurementOption[]): string | null {
  if (!key) return null;
  const hit = options.find((o) => o.key === key);
  if (hit) return hit.unit && !hit.builtIn ? `${hit.label} (${hit.unit})` : hit.label;
  return key.replace(/_/g, " ");
}
