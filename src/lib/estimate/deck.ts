/**
 * Deck estimate engine — Tahoe Deck's bid model turned into a deterministic calculator, so
 * a homeowner on the public configurator gets an instant itemized ballpark and the office
 * gets a draft it can refine. It reads RATES from the org's own price list BY CODE (not
 * hardcoded numbers), so when Chris edits his price list the estimate moves with it. Pure +
 * testable: no I/O, no catalog fetch here — the caller passes a rate(code) lookup.
 *
 * This is Chris's business math; the assumptions it has to make (railing from the footprint,
 * footing count from area, which height band applies) are returned in `assumptions` so the
 * UI can show them and the office can adjust. Reusable shape for other trades later: a
 * different trade ships its own answers + compute fn, everything downstream is shared.
 */
import type { EstimateLine } from "@/lib/lead-triage";

export type DeckMaterial = "wood" | "composite";
export type DeckShape = "rectangle" | "irregular";

/** Every price-list code the deck estimate can reference. The public configurator exposes
 *  ONLY these rates to the browser (not the whole catalog). Keep in sync with the adds below. */
export const DECK_ESTIMATE_CODES = [
  "D1", "DS8", "DS2",
  "DS5A", "DS5B", "DS5C",
  "DS6C", "DS6D",
  "D2", "D5", "D4",
  "DS1B", "DS1A", "DS9",
  "DS3D", "DS3C",
] as const;

/** IRC R312.1: a guardrail is code-required only when the walking surface sits MORE than
 *  30 in above grade. Only an exact measured height may waive the derived railing (see
 *  heightIsExact) — band-representative heights keep the always-derive behavior. */
export const GUARDRAIL_REQUIRED_ABOVE_IN = 30;

/** What the configurator collects. Measurements are the homeowner's best guess; the office
 *  confirms on site. railingLf null → derive it from the footprint. */
export type DeckAnswers = {
  projectType: string; // matches lead-triage ProjectType
  material: DeckMaterial;
  lengthFt: number;
  widthFt: number;
  heightFt: number; // height at the tallest point
  /** true → heightFt is a MEASURED number (office custom input), so a deck at or under the
   *  30-in guardrail threshold skips the DERIVED railing (code doesn't require one; explicit
   *  railingLf still prices). Absent/false → a band representative: never waives railing, so
   *  the public configurator's prices are unchanged. */
  heightIsExact?: boolean;
  railingLf: number | null;
  stairFlights: number; // SETS of stairs — a second set implies a landing + extra engineering
  stairSteps?: number; // total individual steps across all sets — D4 bills per step (default 0)
  stairRailing?: boolean; // homeowner's yes/no — when true (and no measured LF) derive LF from steps
  stairRailingLf: number; // explicit measured LF (office path) — wins over the derivation
  shape: DeckShape;
  wrapAround: boolean;
  manDoors: number;
  sliderDoors: number;
  trpa: boolean; // property in the Tahoe basin / TRPA jurisdiction
};

/** catalog code → unit price (the org's price list). Returns 0 for an unknown/absent code,
 *  which makes the engine simply skip that line. */
export type Rate = (code: string) => number;

export type DeckEstimate = {
  lines: EstimateLine[];
  total: number;
  area: number;
  assumptions: string[];
};

const n = (x: unknown): number => {
  const v = Number(x);
  return Number.isFinite(v) && v > 0 ? v : 0;
};
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Railing when the homeowner didn't give a number: an attached rectangle has railing on 3
 *  sides (both lengths + the far width), a wrap-around on all 4. Rough, flagged, adjustable. */
function derivedRailingLf(L: number, W: number, wrap: boolean): number {
  if (L <= 0 || W <= 0) return 0;
  return wrap ? 2 * L + 2 * W : 2 * L + W;
}

export type DeckRateRow = { code: string | null; buy_price: number | null; markup_pct: number | null };

/**
 * Build the code→rate map from price-list rows with a CALLER-supplied markup rule: rate =
 * buy × (1 + markupPctFor(item markup_pct)%/100). Dedupes deterministically: pass rows
 * NEWEST-FIRST (order by updated_at desc) and the first row per code wins, so a duplicate
 * active code can't make two callers pick different prices.
 *
 * The office quote builder passes THE markup rule (effectiveMarkupPct with the selected
 * customer's level + org default) so generator lines price exactly like the hand-picker
 * beside them. The PUBLIC configurator + site-chat keep buildDeckRates below.
 */
export function buildDeckRatesWithMarkup(
  rows: DeckRateRow[],
  markupPctFor: (itemMarkupPct: number | null) => number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const code = String(r?.code ?? "");
    if (!code || code in out) continue; // first (newest) wins
    out[code] = (Number(r?.buy_price) || 0) * (1 + markupPctFor(r?.markup_pct ?? null) / 100);
  }
  return out;
}

/**
 * The PUBLIC deck-rate map: item markup only (buy × (1 + markup_pct%/100)) — DELIBERATELY
 * frozen without the customer-level/org-default rungs, pending Chris's sign-off, so the
 * public configurator's prices never move under him (regression-pinned in deck.test.ts).
 * Used by /estimate/[handle] and the site-chat deck tool; the office generator resolves
 * markup through buildDeckRatesWithMarkup instead.
 */
export function buildDeckRates(rows: DeckRateRow[]): Record<string, number> {
  return buildDeckRatesWithMarkup(rows, (pct) => Number(pct) || 0);
}

export function computeDeckEstimate(a: DeckAnswers, rate: Rate): DeckEstimate {
  const lines: EstimateLine[] = [];
  const assumptions: string[] = [];
  const L = n(a.lengthFt);
  const W = n(a.widthFt);
  const H = n(a.heightFt);
  const area = round2(L * W);

  const add = (code: string, description: string, quantity: number, unit: string) => {
    const unit_price = rate(code);
    if (quantity > 0 && unit_price > 0) {
      lines.push({ description, quantity: round2(quantity), unit, unit_price });
    }
  };

  const isResurface = a.projectType === "resurface";
  const isStainOnly = a.projectType === "staining";
  const isFullReplace = a.projectType === "full_replacement";
  const buildsDeck =
    a.projectType === "new_deck" || a.projectType === "extension" || isFullReplace || isResurface;

  // Base surface. Resurface reuses the frame (cheaper board-replacement rate); a full build
  // is the per-sq-ft deck rate. Railing/stairs/door lines below compose on top, so a
  // "railing only" or "stairs only" job still prices correctly with no base line.
  if (area > 0) {
    if (isResurface) add("DS8", "Deck resurface — replace decking on the existing frame", area, "SQ FT");
    else if (buildsDeck) add("D1", "Deck build", area, "SQ FT");
  }

  // Composite upgrade over wood.
  if (a.material === "composite" && buildsDeck && area > 0) {
    add("DS2", "Composite decking upgrade", area, "SQ FT");
  }

  // Height band — one band by the tallest point (higher deck = more structure/access cost).
  if (buildsDeck && area > 0) {
    if (H > 30) add("DS5C", "Height supplement — over 30 ft", area, "SQ FT");
    else if (H > 20) add("DS5B", "Height supplement — over 20 ft", area, "SQ FT");
    else if (H > 10) add("DS5A", "Height supplement — over 10 ft", area, "SQ FT");
  }

  // Shape complexity.
  if (buildsDeck && area > 0) {
    if (a.shape === "irregular") add("DS6C", "Irregular shape", area, "SQ FT");
    if (a.wrapAround) add("DS6D", "Wrap-around", area, "SQ FT");
  }

  // Railing: use the measured value; else derive from the footprint, but ONLY for a new
  // build — a resurface keeps its existing railing, so don't invent one. An exact measured
  // height at or under the 30-in guardrail threshold also skips the derivation (code doesn't
  // require a rail down there) — a measured LF still prices one when Chris wants it anyway.
  const belowGuardrail = a.heightIsExact === true && H > 0 && H <= GUARDRAIL_REQUIRED_ABOVE_IN / 12;
  const measuredRail = a.railingLf != null && a.railingLf > 0;
  const railingLf = measuredRail
    ? n(a.railingLf)
    : buildsDeck && !isResurface && !belowGuardrail
      ? derivedRailingLf(L, W, a.wrapAround)
      : 0;
  if (!measuredRail && railingLf > 0) {
    assumptions.push(`Railing estimated at ${Math.round(railingLf)} LF from the footprint — confirmed on site.`);
  } else if (!measuredRail && belowGuardrail && buildsDeck && !isResurface && L > 0 && W > 0) {
    assumptions.push(
      `${GUARDRAIL_REQUIRED_ABOVE_IN} in or less above grade — code doesn't require a guardrail, so none is included; enter railing LF to add one.`,
    );
  }
  add("D2", "Deck railing", railingLf, "LF");

  // Stairs. D4 = Chris's "Stairs >3 steps" rate, billed PER STEP — his real GiddyUp bid
  // carried qty 15 (a step count), which settled the old sets-vs-steps question. stairFlights
  // carries the SETS count separately: a second set implies a landing + extra engineering,
  // so we flag it rather than price it blind.
  const steps = n(a.stairSteps);
  const sets = steps > 0 ? Math.max(1, n(a.stairFlights)) : n(a.stairFlights);
  add("D4", "Stairs (>3 steps)", steps, "EA");
  if (steps > 0 && sets > 1) {
    assumptions.push("Multiple stair sets — landings and extra engineering are verified on-site.");
  }

  // Stair railing: an explicit measured LF (office path) wins; otherwise a homeowner "yes"
  // derives LF from the step count — both sides of the run, ~1.12 LF per step of going.
  const measuredStairRail = n(a.stairRailingLf);
  let stairRailLf = measuredStairRail;
  if (measuredStairRail <= 0 && a.stairRailing && steps > 0) {
    stairRailLf = Math.ceil(steps * 1.12 * 2);
    assumptions.push("Stair railing estimated both sides; final footage measured on-site.");
  }
  add("D5", "Stair railing", stairRailLf, "LF");

  // Door waterproofing where a deck meets the house.
  add("DS1B", "Man-door waterproofing", n(a.manDoors), "EA");
  add("DS1A", "Slider-door waterproofing", n(a.sliderDoors), "EA");

  // Footings — a size-based heuristic; the real count comes from the layout on site.
  if (buildsDeck && !isResurface && area > 0) {
    const footings = Math.max(4, Math.ceil(area / 60));
    assumptions.push(`Footings estimated at ${footings} (about 1 per 60 sq ft) — final count set on site.`);
    add("DS9", "Concrete footings & piers", footings, "EA");
  }

  // Tear-out on a full replacement.
  if (isFullReplace && area > 0) add("DS3D", "Demo & waste hauling", area, "SQ FT");

  // Regional compliance.
  if (a.trpa) add("DS3C", "TRPA compliance", 1, "EA");

  if (isStainOnly) {
    assumptions.push("Refinishing/staining jobs are priced after a quick look — we'll reach out.");
  }
  if (buildsDeck && area > 0) {
    assumptions.push("Permitting, engineering, and excavation (if the site needs them) are added after review.");
  }

  const total = Math.round(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0));
  return { lines, total, area, assumptions };
}
