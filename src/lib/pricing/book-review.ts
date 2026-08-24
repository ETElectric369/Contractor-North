/**
 * A SUPPLIER QUOTE, READ AGAINST THE PRICE BOOK — the review that keeps the book alive.
 *
 * Erik: "since prices are always fluctuating the quotes do provide updated pricing for the price
 * book and new products so how can we get this integrated … some people arent going to want
 * anything to override anything so maybe that should be handled lightly per org or a flag for
 * review to update/add products to price list."
 *
 * This module is the READ half: pure matching, no writes, fully testable. It takes the book and a
 * transcribed supplier quote and sorts every line into exactly one of three buckets:
 *
 *   UPDATES    — the line matches a book item and the supplier's net differs from the stored
 *                buy_price. Old and new shown side by side; applying is OPT-IN per row.
 *   ADDITIONS  — the line matches nothing. Offering to add it is how the book grows from real
 *                purchases instead of data entry; also opt-in per row.
 *   UNCHANGED  — matched, same price. Nothing to review, reported only as a count.
 *
 * NOTHING HERE OVERRIDES ANYTHING. The write half (applyPriceBookReview) only ever receives rows
 * a person ticked. A per-org "auto-apply" default can sit on top later, the day an org asks.
 *
 * ── MATCHING, DELIBERATELY CONSERVATIVE ─────────────────────────────────────────────────────
 *
 * A wrong match is a silently corrupted price on a REAL book row, which is the price-list-import
 * damage class all over again. So: exact CODE match first (the supplier's part number against the
 * book's code, case-insensitive), then exact NORMALIZED-DESCRIPTION match. No fuzzy rung — the
 * "Matched loosely" ladder exists for pricing a one-off line, where a bad guess costs one
 * estimate line somebody reviews; here it would cost the book itself. A near-miss lands in
 * ADDITIONS, where the worst outcome is a duplicate row a human declines.
 */

export type BookRowLite = {
  id: string;
  code: string | null;
  description: string | null;
  unit: string | null;
  buy_price: number | string | null;
};

export type SupplierLine = {
  description: string;
  quantity: number;
  unit: string;
  /** The supplier's NET each — pre-markup, pre-tax-share (the book stores cost, not landed). */
  net: number;
};

export type BookUpdate = {
  itemId: string;
  code: string | null;
  description: string;
  oldBuy: number;
  newBuy: number;
  matchedBy: "code" | "description";
  /** The unit each side of the price is quoted in. A supplier prints the COIL net for a part
   *  the book prices per FOOT — "$0.75 → $187.50" is then a 250x corruption of the book, and
   *  the review card showed neither unit (v800 audit). Carried so the human can see it. */
  oldUnit: string | null;
  newUnit: string | null;
  /** True when the two units disagree — the caller must NOT pre-tick this row, and should say
   *  why. We do not convert: nobody can safely infer that a "coil" is 250 feet. */
  unitMismatch: boolean;
};

export type BookAddition = { description: string; unit: string; newBuy: number };

export type BookReview = { updates: BookUpdate[]; additions: BookAddition[]; unchanged: number };

/** One normalization, both sides: case, whitespace, punctuation that suppliers vary freely. */
const norm = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[#.,()/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A part number embedded in the transcribed description ("QO120 ..." or "... [QO120]"). */
/** "20A", "240V", "12AWG", "3/4IN" — sizes and ratings that LEAD countless supplier lines and
 *  are also short enough to collide with a book code column (audit 7: a '20A' code row got a
 *  GFCI's price proposed onto a breaker). A rating token is never treated as a part number. */
const RATING_TOKEN = /^\d+(?:\/\d+)?(?:A|V|W|KW|HP|AWG|GA|FT|IN|MM|CM)$/i;

const codeCandidates = (desc: string): string[] => {
  const out: string[] = [];
  const bracket = desc.match(/\[([^\]]{2,20})\]/);
  if (bracket) out.push(bracket[1]); // explicit brackets are the transcriber SAYING "part number"
  const first = desc.trim().split(/\s+/)[0];
  if (first && /^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/.test(first) && !RATING_TOKEN.test(first)) out.push(first);
  return out.map((c) => c.toUpperCase());
};

export function reviewAgainstBook(book: BookRowLite[], lines: SupplierLine[]): BookReview {
  const byCode = new Map<string, BookRowLite>();
  const byDesc = new Map<string, BookRowLite>();
  for (const b of book) {
    if (b.code) byCode.set(String(b.code).toUpperCase(), b);
    const d = norm(b.description);
    // First writer wins: two book rows with one normalized description is the org's own
    // ambiguity, and guessing between them is exactly what this module refuses to do.
    if (d && !byDesc.has(d)) byDesc.set(d, b);
  }

  const updates: BookUpdate[] = [];
  const additions: BookAddition[] = [];
  let unchanged = 0;
  const claimed = new Set<string>(); // one quote line per book row — never two updates to one row

  for (const l of lines) {
    if (!l.description.trim() || l.net <= 0) continue;
    let hit: BookRowLite | undefined;
    let matchedBy: "code" | "description" = "description";
    for (const c of codeCandidates(l.description)) {
      const b = byCode.get(c);
      if (b) {
        hit = b;
        matchedBy = "code";
        break;
      }
    }
    if (!hit) hit = byDesc.get(norm(l.description));
    if (hit && !claimed.has(hit.id)) {
      claimed.add(hit.id);
      const oldBuy = Math.round((Number(hit.buy_price) || 0) * 100) / 100;
      const newBuy = Math.round(l.net * 100) / 100;
      const oldUnit = (hit.unit ?? "").trim() || null;
      const newUnit = (l.unit ?? "").trim() || null;
      // UNIT-BLIND WAS THE BUG (v800 audit): both sides carried a unit and neither was read, so
      // a per-coil net could silently overwrite a per-foot book price and every later estimate
      // using that item was wrong by the coil length. We compare, we surface, we never convert.
      const unitMismatch = !!oldUnit && !!newUnit && norm(oldUnit) !== norm(newUnit);
      if (Math.abs(oldBuy - newBuy) < 0.005 && !unitMismatch) unchanged++;
      else
        updates.push({
          itemId: hit.id,
          code: hit.code,
          description: hit.description ?? l.description,
          oldBuy,
          newBuy,
          matchedBy,
          oldUnit,
          newUnit,
          unitMismatch,
        });
    } else if (!hit) {
      additions.push({ description: l.description.trim(), unit: l.unit || "ea", newBuy: Math.round(l.net * 100) / 100 });
    } else {
      // Second line matching an already-claimed row: report as addition so a human decides.
      additions.push({ description: l.description.trim(), unit: l.unit || "ea", newBuy: Math.round(l.net * 100) / 100 });
    }
  }
  return { updates, additions, unchanged };
}
