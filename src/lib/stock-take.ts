/**
 * TOOK FROM STOCK, THE WORDS AND THE SHAPES (Shop Stock, Phase 3). Pure: the sheet, the job's takes
 * list, the office's bell and Nort's fill all say the same thing from here, and tests read them
 * without a database.
 *
 * ── THE LAW THIS FILE KEEPS ─────────────────────────────────────────────────────────────────────
 * NOT ONE PRICE. The crew's view of the shelf is shelf_for_crew (0302: id, name, unit, on hand) and
 * the job's takes are stock_takes_for_job (0344: date, item, count, who, the claim). Neither shape
 * below has a field that could carry a cost, so no screen built on them can show one by accident.
 * The office reads what a take cost on Shop Stock and in the job's money, never here.
 */

/** One item on the shelf, as the crew (and this door, for everyone) sees it. */
export type ShelfRow = { id: string; name: string; unit: string; onHand: number };

/** One take on a job, as stock_takes_for_job (0344) hands it back. */
export type JobTake = {
  drawGroup: string;
  takenAt: string;
  itemId: string;
  item: string;
  unit: string;
  qty: number;
  /** Pieces taken past what the shelf showed, not settled from a roll yet. */
  short: number;
  /** Pieces the office brought back to the shelf from this take. */
  back: number;
  who: string;
  mine: boolean;
  /** The invoice number that bills this take, or null. */
  billedOn: string | null;
  /** The office's door to that invoice (null for the crew). */
  billedInvoiceId: string | null;
  canUndo: boolean;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A count the way a person says it: 60, 12.5, 0.125 (never 60.000). */
export function fmtQty(n: number): string {
  const r = Math.round(num(n) * 1000) / 1000;
  return String(r);
}

/** shelf_for_crew's rows, typed (numerics arrive as strings from PostgREST). */
export function parseShelf(raw: unknown): ShelfRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => r as Record<string, unknown>)
    .filter((r) => r && typeof r.id === "string")
    .map((r) => ({ id: String(r.id), name: String(r.name ?? "").trim() || "Unnamed item", unit: String(r.unit ?? "ea").trim() || "ea", onHand: num(r.on_hand) }));
}

/** stock_takes_for_job's rows, typed. Anything else in the payload is dropped, never passed on. */
export function parseTakes(raw: unknown): JobTake[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => r as Record<string, unknown>)
    .filter((r) => r && typeof r.draw_group === "string")
    .map((r) => ({
      drawGroup: String(r.draw_group),
      takenAt: String(r.taken_at ?? ""),
      itemId: String(r.item_id ?? ""),
      item: String(r.item ?? "").trim() || "an item",
      unit: String(r.unit ?? "ea").trim() || "ea",
      qty: num(r.qty),
      short: num(r.short),
      back: num(r.back),
      who: String(r.who ?? "").trim() || "Someone",
      mine: r.mine === true,
      billedOn: r.billed_on ? String(r.billed_on) : null,
      billedInvoiceId: r.billed_invoice_id ? String(r.billed_invoice_id) : null,
      canUndo: r.can_undo === true,
    }));
}

/** How many of `qty` go past what the shelf shows. A shelf already below zero shows none. */
export function shortOf(onHand: number, qty: number): number {
  const s = num(qty) - Math.max(num(onHand), 0);
  return s > 0 ? Math.round(s * 1000) / 1000 : 0;
}

/** THE SHORT, SAID BEFORE AND AFTER THE TAP. It still saves: nobody hits a dead end in the field. */
export function shortWords(short: number, unit: string): string {
  return `${fmtQty(short)} ${unit} more than the shelf shows — the office will recount`;
}

/** The toast after Take It. */
export function tookWords(t: { qty: number; unit: string; item: string; job: string; short?: number }): string {
  const base = `Took ${fmtQty(t.qty)} ${t.unit} of ${t.item} for ${t.job}`;
  return t.short && t.short > 0 ? `${base}. ${shortWords(t.short, t.unit)}.` : base;
}

/** THE OFFICE'S BELL, one per crew take. A short says what the shelf showed and what to do. */
export function officeBellWords(t: { who: string; qty: number; unit: string; item: string; job: string; short: number; onHandAfter: number }): {
  title: string;
  body: string;
} {
  const q = `${fmtQty(t.qty)} ${t.unit}`;
  if (t.short > 0) {
    const said = Math.max(Math.round((num(t.onHandAfter) + num(t.qty)) * 1000) / 1000, 0);
    return {
      title: `${t.who} took ${q} of ${t.item}, the shelf said ${fmtQty(said)} ${t.unit}`.slice(0, 140),
      body: `For ${t.job}. Count it or file the roll.`.slice(0, 140),
    };
  }
  return {
    title: `${t.who} took ${q} of ${t.item} for ${t.job}`.slice(0, 140),
    body: "From stock. It counts on the job now, with Undo on the job's Materials tab until it's billed.",
  };
}

/** What a take's row offers: Undo, the invoice to take it off first, or nothing (someone else's). */
export function takeDoor(t: Pick<JobTake, "canUndo" | "billedOn" | "back">): { kind: "undo" } | { kind: "billed"; label: string } | { kind: "none"; why: string | null } {
  if (t.billedOn) return { kind: "billed", label: `Take It Off ${t.billedOn} First` };
  if (t.canUndo) return { kind: "undo" };
  if (t.back > 0) return { kind: "none", why: "Some came back to the shelf, so the office undoes the rest." };
  return { kind: "none", why: null };
}

/** A take as one line on the job: "Brian took 60 ft of 12/2 NM-B". */
export function takeLine(t: Pick<JobTake, "who" | "qty" | "unit" | "item" | "short" | "back">): string {
  const parts = [`${t.who} took ${fmtQty(t.qty)} ${t.unit} of ${t.item}`];
  if (t.short > 0) parts.push(`${fmtQty(t.short)} ${t.unit} past the shelf, waiting on a recount`);
  if (t.back > 0) parts.push(`${fmtQty(t.back)} ${t.unit} brought back`);
  return parts.join(" · ");
}

// ── NORT'S FILL: which item did they mean? ─────────────────────────────────────────────────────

/** A spoken or typed unit, in the shelf's words. Unknown words pass through lowercased. */
export function normUnit(u: string | null | undefined): string {
  const s = String(u ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!s) return "";
  if (["ft", "feet", "foot", "'", "lf", "lin ft", "linear feet"].includes(s)) return "ft";
  if (["ea", "each", "pc", "pcs", "piece", "pieces", "count", "ct"].includes(s)) return "ea";
  return s;
}

const STOP = new Set(["of", "the", "a", "an", "some", "from", "stock", "shelf", "feet", "foot", "ft", "ea", "each"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9/.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

export type ShelfMatch = { kind: "one"; row: ShelfRow } | { kind: "many"; rows: ShelfRow[] } | { kind: "none" };

/**
 * WHICH ITEM, BY NAME. An exact name (case and punctuation aside) wins; otherwise every word they
 * said has to be in the item's name. One candidate is the item; two or more is a question back to
 * the person, never a pick ("the app suggests, a person decides"); none is said as none.
 */
export function matchShelfItem(rows: ShelfRow[], spoken: string): ShelfMatch {
  const said = words(spoken);
  if (!said.length) return { kind: "none" };
  const key = said.join(" ");
  const exact = rows.filter((r) => words(r.name).join(" ") === key);
  if (exact.length === 1) return { kind: "one", row: exact[0] };
  if (exact.length > 1) return { kind: "many", rows: exact };
  const needed = said.filter((w) => !STOP.has(w));
  if (!needed.length) return { kind: "none" };
  // A plural said is the item named in the singular ("wire nuts" is the "wire nut" box).
  const has = (name: string, w: string) => name.includes(w) || (w.length > 3 && w.endsWith("s") && name.includes(w.slice(0, -1)));
  const hits = rows.filter((r) => {
    const name = words(r.name).join(" ");
    return needed.every((w) => has(name, w));
  });
  if (hits.length === 1) return { kind: "one", row: hits[0] };
  if (hits.length > 1) return { kind: "many", rows: hits };
  return { kind: "none" };
}

/** The link that opens the job's Took From Stock sheet filled in (Nort's card, and nothing else). */
export function takeHref(jobId: string, itemId: string, qty?: number | null): string {
  const qs = new URLSearchParams({ tab: "materials", take: itemId });
  if (qty && qty > 0) qs.set("qty", fmtQty(qty));
  return `/jobs/${jobId}?${qs.toString()}`;
}
