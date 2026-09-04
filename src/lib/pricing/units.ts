/**
 * ONE UNIT VOCABULARY. Units were free text everywhere — "ea", "EA", "each", "sq ft", "sqft",
 * "SQ FT", "lf", "ft" all live in three companies' books — and nothing could compute with them
 * because nothing could compare them. This is the normalizer every unit field runs through on the
 * way in, and the suggestion list every unit field offers on the way out.
 *
 * Suggestions, never a limit (the invoice editor's rule): a contractor can type "pallet" and it is
 * kept verbatim, just trimmed and lower-cased. Only the KNOWN spellings collapse.
 */
export const UNIT_SUGGESTIONS = ["ea", "ft", "sq ft", "hr", "lot", "box", "roll", "day", "trip", "lb", "gal", "cu yd", "pk"] as const;

const ALIASES: Record<string, string> = {
  // each
  ea: "ea", each: "ea", pc: "ea", pcs: "ea", piece: "ea", pieces: "ea", unit: "ea", units: "ea", item: "ea",
  // linear feet — "lf" IS feet; a linear foot is a foot
  ft: "ft", feet: "ft", foot: "ft", lf: "ft", "lin ft": "ft", "linear ft": "ft", "linear feet": "ft", lft: "ft", "l.f.": "ft",
  // area
  "sq ft": "sq ft", sqft: "sq ft", sf: "sq ft", "sq.ft.": "sq ft", "sq. ft.": "sq ft", "square feet": "sq ft", "square foot": "sq ft", "sq feet": "sq ft",
  // time
  hr: "hr", hrs: "hr", hour: "hr", hours: "hr", "man-hr": "hr", manhr: "hr", "man hr": "hr",
  day: "day", days: "day",
  // lump / package
  lot: "lot", ls: "lot", "lump sum": "lot", allowance: "lot", job: "lot",
  box: "box", bx: "box", boxes: "box",
  roll: "roll", rolls: "roll",
  pk: "pk", pack: "pk", pkg: "pk", package: "pk",
  trip: "trip", trips: "trip",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  gal: "gal", gallon: "gal", gallons: "gal",
  "cu yd": "cu yd", cy: "cu yd", "cubic yard": "cu yd", "cubic yards": "cu yd", yd3: "cu yd",
};

/** Normalize a typed unit: trim, lower-case, collapse whitespace, map the known spellings.
 *  Empty → "ea" (the book's default). Unknown words survive verbatim. */
export function normalizeUnit(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return "ea";
  return ALIASES[s] ?? ALIASES[s.replace(/\./g, "")] ?? s;
}

/** Do two units mean the same thing? ("LF" vs "ft", "EA" vs "each"). */
export function sameUnit(a: unknown, b: unknown): boolean {
  return normalizeUnit(a) === normalizeUnit(b);
}

/** Is this an hours unit? (labor detection, one definition instead of three literal sets) */
export function isHoursUnit(raw: unknown): boolean {
  return normalizeUnit(raw) === "hr";
}

/** The id the shared <datalist> renders under, so every unit input can point at one list. */
export const UNIT_DATALIST_ID = "cn-units";
