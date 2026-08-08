import type { DraftLineItem } from "@/lib/estimate/line-map";

/**
 * THE SCOPE PICKER — the second pricing shape, and the one that makes the playbook turnkey.
 *
 * Erik, correcting me after I called Chris's zero-priced remodel codes a defect:
 *
 *   "they are based on calculations too, when he chooses remodel he needs to be able to choose
 *    from a dropdown of optional line items to add so he can add a value so it can be calculated,
 *    so yeah thats why they are at zero becuase it gets built with the inspection"
 *
 * ── TWO SHAPES, NOT ONE ─────────────────────────────────────────────────────────────────────
 *
 * Everything the playbook could express until now was RATE × MEASURED QUANTITY: ask a number, the
 * why line names the code it multiplies into, done. Chris's deck build is that shape and so is
 * Erik's wire run.
 *
 * A remodel isn't. There is no square-foot rate for "tear out whatever is behind that wall" —
 * the scope is CHOSEN on site from what the job turns out to need, and its value is set standing
 * there. R1–R8 sit at $0.00 in his price list for exactly that reason: they are named scopes
 * waiting for a number, not mispriced rows. So this is a pick-many-and-price-each question.
 *
 * ── WHY IT'S GENERAL, NOT A DECK FEATURE ────────────────────────────────────────────────────
 *
 * Every trade has assembled work. An electrician's service change is a set of chosen scopes; a
 * plumber's repipe is; a GC's remodel is nothing else. Encoding this as a SLOT TYPE — rather than
 * as another `src/lib/estimate/<trade>.ts` module — is what stops the next contractor needing a
 * hand-written pricing file. The picks come from THEIR price list, by their codes, in their words.
 *
 * A pick maps 1:1 onto a DraftLineItem, so an estimate built from a walk-through is line items the
 * office recognises rather than prose somebody re-types.
 */

/** One chosen scope: a price-list code, how many, and what it's worth on THIS job. */
export interface ScopePick {
  /** The org's own price-list code (R1, DS3B, …). Never a free-text description. */
  code: string;
  /** How many units. 1 for a lump sum, which is the common case for an assembled scope. */
  qty: number;
  /** Unit price for this job. Seeded from the book, EDITABLE — a $0.00 book row is the whole
   *  point: the number is discovered on site, not looked up. */
  price: number;
}

const num = (v: unknown, max: number): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n * 100) / 100, max);
};

/**
 * Validate a client-supplied pick list. Same law as every other answer: the SHAPE is proved here,
 * and a code that isn't in the org's book is dropped at the write boundary where the book is known
 * — this function deliberately doesn't know the catalogue.
 */
export function coerceScopes(v: unknown): ScopePick[] | null {
  if (!Array.isArray(v)) return null;
  const out: ScopePick[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const code = String(o.code ?? "").trim().slice(0, 40);
    // One row per code — picking the same scope twice is a mis-tap, and silently summing two rows
    // is how a total stops matching the list somebody read.
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, qty: num(o.qty, 100000) || 1, price: num(o.price, 1000000) });
    if (out.length >= 40) break;
  }
  return out.length ? out : null;
}

/** Keep only picks whose code exists in the org's own price list. The catalogue boundary. */
export const ownScopes = (picks: ScopePick[], codes: ReadonlySet<string>): ScopePick[] =>
  picks.filter((p) => codes.has(p.code));

export const scopeTotal = (picks: ScopePick[]): number =>
  Math.round(picks.reduce((sum, p) => sum + p.qty * p.price, 0) * 100) / 100;

/** A pick becomes a quote line with no re-typing — the point of choosing from the book at all. */
export function scopeLines(
  picks: ScopePick[],
  book: Map<string, { description?: string | null; unit?: string | null }>,
  group?: string,
): DraftLineItem[] {
  return picks.map((p) => ({
    description: book.get(p.code)?.description?.trim() || p.code,
    quantity: p.qty,
    unit: book.get(p.code)?.unit?.trim() || "EA",
    unit_price: p.price,
    ...(group ? { group } : {}),
  }));
}

/** One line of prose for the office summary / the estimator's given-facts block. */
export const scopeText = (
  picks: ScopePick[],
  book: Map<string, { description?: string | null }>,
): string =>
  picks
    .map((p) => {
      const name = book.get(p.code)?.description?.trim() || p.code;
      const money = p.price > 0 ? ` — $${(p.qty * p.price).toLocaleString()}` : " — not priced yet";
      return `${name}${p.qty !== 1 ? ` ×${p.qty}` : ""}${money}`;
    })
    .join("; ");
