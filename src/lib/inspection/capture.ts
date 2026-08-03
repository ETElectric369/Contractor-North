import type { DraftLineItem } from "@/lib/estimate/line-map";

/**
 * WHAT AN INSPECTION CARRIES BACK, as one typed thing.
 *
 * Erik: "there are notes, measurements, etc then there is the thing you built when in reality it
 * should all be one smart thing … all the things need to be available that could build an estimate
 * and they have to be in the inspector … no nothing gets ruled out but get smarter about
 * simplifying the process."
 *
 * So: nothing is removed. The three prose boxes stay, the photos stay, the typed sheet stays, and
 * this adds the two things that had nowhere to live — a materials LIST and measurements the
 * template never thought to ask for.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────────────────
 *
 * THE PROSE IS NEVER WRITTEN BY CODE.
 *
 * The obvious design is to regenerate `materials` from `items` so there is one apparent truth.
 * Three independent designs proposed exactly that and three independent reviews killed it, for a
 * reason that is specific to this app rather than theoretical: `saveAppointmentCapture` builds its
 * payload from a fixed whitelist and destroys unknown keys, and Erik runs a home-screen PWA whose
 * bundle can be hours stale. One save from a stale tab would regenerate an empty string over a
 * materials list he typed — silently, with `hasCaptureData` possibly flipping so the My Day money
 * item goes dark too.
 *
 * So the prose strings are HUMAN-AUTHORED, permanently. They are the escape hatch for the sentence
 * nobody anticipated ("the meter base is pulling away from the wall"), not a copy of anything. The
 * typed arrays are the typed truth. Where the estimator wants both, it COMPOSES them at the moment
 * of reading — the `subtotalTaxTotal` pattern from invoice-math.ts: computed at the point of use,
 * never a second stored copy that can drift.
 *
 * ── AND THE ONE THE SINGLE-SOURCE-OF-TRUTH LAW RESTS ON ─────────────────────────────────────
 *
 * NORT NEVER OVERWRITES SOMETHING A HAND TYPED. It fills holes. When it has heard a value for a
 * field the person already touched, it says so out loud and leaves the stored value alone. That is
 * what makes "I can do it manually and Nort fills in for me" one surface instead of two writers
 * fighting over one field.
 */

/** Stable-id maker. crypto.randomUUID is missing on older iOS in a PWA context. */
export function captureId(seed?: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!seed && c?.randomUUID) return c.randomUUID();
  return `c_${seed ?? ""}${Math.abs(hash(seed ?? String(idCounter++))).toString(36)}`;
}
let idCounter = 1;
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i), (h |= 0);
  return h;
};

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const clampList = <T>(a: T[], max: number) => (a.length > max ? a.slice(0, max) : a);

/**
 * A number as typed, spoken or left blank.
 *
 * null means "not answered", and it is NEVER 0. Number("") is 0, and a silent zero reads as a real
 * measurement all the way to a customer's dollar figure — the same law coerceAnswers enforces on
 * the typed sheet.
 */
export function looseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

/** One material line captured on site. */
export interface CaptureItem {
  id: string;
  description: string;
  /** null = "I know I need this, I haven't counted it". Never 0. */
  quantity: number | null;
  unit: string;
  /** Price-book code when the row came from the typeahead — so the estimator prices from the
   *  book instead of researching a description the app already owns. */
  code?: string | null;
  /** Set by CODE, never by the model, when a value arrived by voice and wasn't confirmed.
   *  Stripped before storage — see stripFlags. */
  flag?: string;
}

/** A number measured on site that the template has no field for. */
export interface CaptureMeasure {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  flag?: string;
}

/** Where a photo belongs. `photos` stays the canonical list; this is placement, not truth. */
export interface CapturePhotoMeta {
  caption?: string;
  /** The label of whatever field had focus when the shutter fired — so the panel shot ties itself
   *  to "Panel brand" rather than landing in an anonymous grid. */
  about?: string;
}

export interface InspectorCapture {
  // ── The existing contract. Unchanged in type, unchanged in meaning, never code-written. ──
  notes: string;
  measurements: string;
  materials: string;
  /** Storage paths, never URLs. */
  photos: string[];
  /** The write-up backlink, stamped only by saveQuote. Every writer must preserve it. */
  quote_id?: string;

  // ── Additive. Absent on every capture written before this shipped. ──
  items?: CaptureItem[];
  measures?: CaptureMeasure[];
  photo_meta?: Record<string, CapturePhotoMeta>;
  /** Monotonic write counter so a stale offline replay can merge additively instead of clobbering. */
  rev?: number;
  v?: 2;
}

export const MAX_ITEMS = 200;
export const MAX_MEASURES = 50;
export const MAX_PROSE = 8000;

/** Tolerant read. Anything unrecognised is dropped rather than trusted. */
export function parseInspectorCapture(raw: unknown): InspectorCapture {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const photos = Array.isArray(c.photos)
    ? clampList(c.photos.filter((p): p is string => typeof p === "string" && !!p.trim() && p.length < 2000), 60)
    : [];
  const photoSet = new Set(photos);

  const items = Array.isArray(c.items)
    ? clampList(
        (c.items as unknown[])
          .map((r) => {
            const o = (r ?? {}) as Record<string, unknown>;
            const description = str(o.description, 500).trim();
            if (!description) return null;
            const item: CaptureItem = {
              id: typeof o.id === "string" && o.id ? o.id : captureId(description),
              description,
              quantity: looseNumber(o.quantity),
              unit: str(o.unit, 12).trim() || "ea",
              ...(typeof o.code === "string" && o.code ? { code: o.code.slice(0, 64) } : {}),
            };
            return item;
          })
          .filter((x): x is CaptureItem => !!x),
        MAX_ITEMS,
      )
    : undefined;

  const measures = Array.isArray(c.measures)
    ? clampList(
        (c.measures as unknown[])
          .map((r) => {
            const o = (r ?? {}) as Record<string, unknown>;
            const label = str(o.label, 200).trim();
            if (!label) return null;
            const measure: CaptureMeasure = {
              id: typeof o.id === "string" && o.id ? o.id : captureId(label),
              label,
              value: looseNumber(o.value),
              unit: str(o.unit, 12).trim(),
            };
            return measure;
          })
          .filter((x): x is CaptureMeasure => !!x),
        MAX_MEASURES,
      )
    : undefined;

  // Placement for a photo that isn't there any more is noise that outlives its subject.
  let photo_meta: Record<string, CapturePhotoMeta> | undefined;
  if (c.photo_meta && typeof c.photo_meta === "object") {
    const out: Record<string, CapturePhotoMeta> = {};
    for (const [k, v] of Object.entries(c.photo_meta as Record<string, unknown>)) {
      if (!photoSet.has(k) || !v || typeof v !== "object") continue;
      const m = v as Record<string, unknown>;
      const caption = str(m.caption, 500).trim();
      const about = str(m.about, 200).trim();
      if (caption || about) out[k] = { ...(caption ? { caption } : {}), ...(about ? { about } : {}) };
    }
    if (Object.keys(out).length) photo_meta = out;
  }

  return {
    notes: str(c.notes, MAX_PROSE),
    measurements: str(c.measurements, MAX_PROSE),
    materials: str(c.materials, MAX_PROSE),
    photos,
    ...(typeof c.quote_id === "string" && c.quote_id ? { quote_id: c.quote_id } : {}),
    ...(items?.length ? { items } : {}),
    ...(measures?.length ? { measures } : {}),
    ...(photo_meta ? { photo_meta } : {}),
    ...(typeof c.rev === "number" && Number.isFinite(c.rev) ? { rev: c.rev } : {}),
    ...(items?.length || measures?.length ? { v: 2 as const } : {}),
  };
}

/** A flag is a live UI hint authored in code — it never reaches storage. */
export function stripFlags(c: InspectorCapture): InspectorCapture {
  return {
    ...c,
    ...(c.items ? { items: c.items.map(({ flag, ...rest }) => rest) } : {}),
    ...(c.measures ? { measures: c.measures.map(({ flag, ...rest }) => rest) } : {}),
  };
}

/** A patch names only the sections it touched. A section that is absent is UNCHANGED. */
export type CapturePatch = Partial<Pick<InspectorCapture, "notes" | "measurements" | "materials" | "photos" | "items" | "measures" | "photo_meta">>;

/**
 * Apply a patch to a stored capture.
 *
 * Per-section, never a full snapshot: an op queued in a crawlspace and replayed two hours later
 * must not resurrect stale notes just because it carried a materials change. And `quote_id` is
 * rescued unconditionally — it is stamped by a different writer entirely (saveQuote), so any
 * writer that rebuilds the object without it silently unfiles a written-up inspection.
 */
export function mergeCaptureSections(stored: unknown, patch: CapturePatch): InspectorCapture {
  const base = parseInspectorCapture(stored);
  const next: InspectorCapture = { ...base };

  // The prose sections are only ever set from an explicit human edit in the patch. Code paths
  // that touch items/measures/photos simply do not name them, so they cannot be clobbered.
  if (patch.notes !== undefined) next.notes = str(patch.notes, MAX_PROSE);
  if (patch.measurements !== undefined) next.measurements = str(patch.measurements, MAX_PROSE);
  if (patch.materials !== undefined) next.materials = str(patch.materials, MAX_PROSE);
  if (patch.photos !== undefined) next.photos = patch.photos.filter((p) => typeof p === "string" && !!p.trim());
  if (patch.items !== undefined) next.items = patch.items;
  if (patch.measures !== undefined) next.measures = patch.measures;
  if (patch.photo_meta !== undefined) next.photo_meta = patch.photo_meta;

  next.rev = (base.rev ?? 0) + 1;
  // Re-parse so clamping, orphan-dropping and the quantity law apply to whatever the patch brought.
  return stripFlags(parseInspectorCapture(next));
}

/**
 * Union a STALE replay into current storage instead of overwriting it.
 *
 * `runOnce` gives exactly-once, not last-write-correct. An op that read rev 3 and lands on rev 5
 * has no claim on anything it didn't touch: arrays union by id, scalars keep what is stored.
 */
export function mergeStaleReplay(stored: unknown, patch: CapturePatch): InspectorCapture {
  const base = parseInspectorCapture(stored);
  const incoming = parseInspectorCapture({ ...base, ...patch });
  const unionById = <T extends { id: string }>(a: T[] = [], b: T[] = []) => {
    const seen = new Set(a.map((x) => x.id));
    return clampList([...a, ...b.filter((x) => !seen.has(x.id))], MAX_ITEMS);
  };
  return stripFlags(
    parseInspectorCapture({
      ...base, // scalars: storage wins
      items: unionById(base.items, incoming.items),
      measures: unionById(base.measures, incoming.measures),
      photos: [...new Set([...(base.photos ?? []), ...(incoming.photos ?? [])])],
      rev: (base.rev ?? 0) + 1,
    }),
  );
}

/** Result of Nort proposing values into a capture. */
export interface FillResult {
  capture: InspectorCapture;
  /** Keys/labels left alone because a hand had already set them. */
  skipped: string[];
}

/**
 * Nort's write path: fill holes, never overwrite.
 *
 * `manual` is the set of item ids and measure ids the person has touched THIS SESSION. Session-
 * sticky rather than stored, because "I typed this" is about the conversation in progress: after a
 * reload, Nort proposing into a field is a fresh offer rather than a contradiction.
 */
export function fillFromAgent(
  stored: unknown,
  proposed: { items?: CaptureItem[]; measures?: CaptureMeasure[]; notesAppend?: string },
  manual: ReadonlySet<string> = new Set(),
): FillResult {
  const base = parseInspectorCapture(stored);
  const skipped: string[] = [];

  const items = [...(base.items ?? [])];
  for (const p of proposed.items ?? []) {
    const at = items.findIndex((x) => x.description.trim().toLowerCase() === p.description.trim().toLowerCase());
    if (at < 0) {
      items.push({ ...p, flag: p.flag ?? "heard" });
      continue;
    }
    const existing = items[at];
    // A hand-set quantity is untouchable. An empty one is a hole Nort may fill.
    if (manual.has(existing.id) || existing.quantity !== null) {
      if (p.quantity !== null && p.quantity !== existing.quantity) skipped.push(existing.description);
      continue;
    }
    items[at] = { ...existing, quantity: p.quantity, flag: "heard" };
  }

  const measures = [...(base.measures ?? [])];
  for (const p of proposed.measures ?? []) {
    const at = measures.findIndex((x) => x.label.trim().toLowerCase() === p.label.trim().toLowerCase());
    if (at < 0) {
      measures.push({ ...p, flag: p.flag ?? "heard" });
      continue;
    }
    const existing = measures[at];
    if (manual.has(existing.id) || existing.value !== null) {
      if (p.value !== null && p.value !== existing.value) skipped.push(existing.label);
      continue;
    }
    measures[at] = { ...existing, value: p.value, flag: "heard" };
  }

  // Anything Nort could not map lands in notes VERBATIM. Nothing said on site is ever discarded
  // just because the sheet had no box for it.
  const notes = proposed.notesAppend?.trim()
    ? `${base.notes}${base.notes.trim() ? "\n" : ""}${proposed.notesAppend.trim()}`.slice(0, MAX_PROSE)
    : base.notes;

  return {
    capture: { ...base, notes, items: clampList(items, MAX_ITEMS), measures: clampList(measures, MAX_MEASURES), v: 2 },
    skipped,
  };
}

/**
 * Materials as estimate lines.
 *
 * `unit_price` is 0, never a guess: the inspector rarely knows a price and inventing one would
 * ride into a customer's total as if somebody had checked. The estimator's sourcing ladder prices
 * it from the book. DraftLineItem requires a number, so 0 is the honest "unpriced".
 */
export function captureItemsToDraftLines(items: CaptureItem[] | undefined): DraftLineItem[] {
  return (items ?? [])
    .filter((i) => i.description.trim())
    .map((i) => ({
      description: i.description.trim(),
      quantity: i.quantity ?? 1,
      unit: i.unit || "ea",
      unit_price: 0,
      ...(i.flag ? { flag: i.flag } : {}),
    }));
}

/** Sizing from ad-hoc measures — deliberately narrow. */
export function adhocSizing(measures: CaptureMeasure[] | undefined): { sqft: number | null; linearFt: number | null } {
  let sqft: number | null = null;
  let linearFt: number | null = null;
  for (const m of measures ?? []) {
    if (m.value === null || m.value <= 0) continue;
    const l = m.label.toLowerCase();
    if (/\b(area|sq\.?\s?ft|square)\b/.test(l) || m.unit === "sqft") sqft ??= m.value;
    // A "run" or a "length of railing" is linear. A "trench width" is not — it is one side of
    // something, and treating it as a length is how a made-up number reaches a price.
    else if (/\b(run|linear|lf|perimeter|railing)\b/.test(l) || m.unit === "lf") linearFt ??= m.value;
  }
  return { sqft, linearFt };
}

/** What the person still hasn't given, for the one honest status line. */
export function inspectorReadiness(c: InspectorCapture): {
  items: number;
  measures: number;
  photos: number;
  toConfirm: number;
  hasProse: boolean;
} {
  const flagged = (c.items ?? []).filter((i) => i.flag).length + (c.measures ?? []).filter((m) => m.flag).length;
  return {
    items: (c.items ?? []).length,
    measures: (c.measures ?? []).length,
    photos: (c.photos ?? []).length,
    toConfirm: flagged,
    hasProse: !!(c.notes.trim() || c.materials.trim() || c.measurements.trim()),
  };
}
