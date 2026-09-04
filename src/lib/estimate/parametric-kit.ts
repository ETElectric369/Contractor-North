/**
 * PARAMETRIC KIT QUANTITIES — the generic engine that keeps determinism from costing a module per
 * trade (0166).
 *
 * lib/estimate/deck.ts proves deterministic estimating works: measurements in, exact itemized
 * quantities out, sub-millisecond, offline, fully tested. It also proves the trap — it serves ONE
 * trade, and writing it again for concrete, roofing and tile is O(trades).
 *
 * Almost all of that arithmetic is "so much of this per square foot / per linear foot", which is a
 * COEFFICIENT, not code. Expressed as data on a kit line, the same three numbers say
 * "footings: 0.0167 per sq ft, minimum 4, round up" for a deck builder and "thinset: 0.05 per
 * sq ft" for a tile setter. One engine, per-trade content.
 *
 * WHAT THIS IS NOT. It does not replace deck.ts. Real trade engines encode judgment a coefficient
 * can't — deck.ts changes its railing rule at the 30-inch guardrail threshold, bills stairs per
 * step, and flags engineering above a height. Those stay code. This covers the large, boring
 * majority underneath them, which is where the per-trade duplication actually lives.
 */

import { kitLineSizing, type KitLineRaw, type KitSizing } from "@/lib/kit-line";

export type QtyRound = "up" | "nearest" | "none";

/** A kit line that may carry coefficients. Superset of the flat kit_items row — and, since 0240,
 *  possibly LINKED to a price-list item that carries the coefficients instead (see sizingOf). */
export type ParametricKitItem = KitLineRaw;

/**
 * WHERE THE COEFFICIENTS LIVE (0240). A linked line sizes from its ITEM — the rule "footings:
 * 1 per 60 sq ft, minimum 4" belongs to the footing, not to one kit that happens to list it, so
 * every kit that links the same item sizes the same way and an edit lands once. An unlinked line
 * keeps sizing from its own columns, exactly as 0166 shipped it.
 */
export function sizingOf(item: ParametricKitItem): KitSizing {
  return kitLineSizing(item);
}

/** The job's measurements. Everything optional — an unmeasured dimension must not silently be 0. */
export type JobDimensions = {
  sqft?: number | null;
  linearFt?: number | null;
};

const num = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

function applyRound(v: number, how: QtyRound): number {
  switch (how) {
    case "none":
      return Math.round(v * 100) / 100;
    case "nearest":
      return Math.round(v);
    default:
      // UP is the default and the safe direction: you buy whole footings, whole sheets, whole
      // boxes, and under-ordering sends someone back to the supply house mid-job.
      return Math.ceil(v);
  }
}

export type ComputedQty = {
  quantity: number;
  /** How the number was reached — shown to the estimator so a surprising quantity is explainable. */
  basis: string;
  /** True when a coefficient produced this, rather than the kit's flat quantity. */
  parametric: boolean;
};

/**
 * The quantity for one kit line against a job's measurements.
 *
 * A line with no coefficients returns its flat quantity, byte-for-byte as before — every existing
 * kit keeps behaving exactly as it does today. A line WITH coefficients but whose driving
 * dimension wasn't measured also falls back to the flat quantity rather than computing from a
 * missing number, because treating "not measured" as zero is how a line silently disappears from
 * an estimate.
 */
export function kitItemQuantity(item: ParametricKitItem, dims: JobDimensions): ComputedQty {
  const flatRaw = num(item.quantity);
  const flat = flatRaw === null ? 1 : flatRaw;

  const sizing = sizingOf(item);
  const perSqft = sizing.qty_per_sqft;
  const perLf = sizing.qty_per_lf;
  const sqft = num(dims.sqft);
  const linearFt = num(dims.linearFt);

  const usesArea = perSqft !== null && perSqft > 0;
  const usesLength = perLf !== null && perLf > 0;
  if (!usesArea && !usesLength) {
    return { quantity: flat, basis: "kit quantity", parametric: false };
  }

  // A coefficient with nothing to multiply is not a zero — it's an unanswered question.
  const haveArea = usesArea && sqft !== null && sqft > 0;
  const haveLength = usesLength && linearFt !== null && linearFt > 0;
  if (!haveArea && !haveLength) {
    return {
      quantity: flat,
      basis: `needs ${usesArea ? "square feet" : "linear feet"} — not measured, using the kit quantity`,
      parametric: false,
    };
  }

  // Both may contribute: a deck needs decking by AREA and railing by PERIMETER, and a line can
  // legitimately depend on each.
  let raw = 0;
  const parts: string[] = [];
  if (haveArea) {
    raw += perSqft! * sqft!;
    parts.push(`${perSqft} × ${sqft} sq ft`);
  }
  if (haveLength) {
    raw += perLf! * linearFt!;
    parts.push(`${perLf} × ${linearFt} lf`);
  }

  const min = sizing.qty_min;
  const floored = min !== null && raw < min ? min : raw;
  const how = (sizing.qty_round === "nearest" || sizing.qty_round === "none" ? sizing.qty_round : "up") as QtyRound;
  const quantity = applyRound(floored, how);

  const basis =
    parts.join(" + ") +
    (min !== null && raw < min ? `, raised to the minimum of ${min}` : "") +
    (how === "up" ? ", rounded up" : how === "nearest" ? ", rounded" : "");

  return { quantity, basis, parametric: true };
}

/** Every line of a kit, sized to the job. Preserves the kit's authored order. */
export function kitQuantities(
  items: ParametricKitItem[],
  dims: JobDimensions,
): Array<ParametricKitItem & ComputedQty> {
  return (items ?? [])
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (num(a.it.sort_order) ?? 0) - (num(b.it.sort_order) ?? 0) || a.i - b.i)
    .map(({ it }) => ({ ...it, ...kitItemQuantity(it, dims) }));
}

/** True when any line of this kit is driven by measurements — the picker uses it to decide
 *  whether to ask for dimensions at all. */
export function kitIsParametric(items: ParametricKitItem[]): boolean {
  return (items ?? []).some((i) => {
    const s = sizingOf(i);
    return (s.qty_per_sqft ?? 0) > 0 || (s.qty_per_lf ?? 0) > 0;
  });
}
