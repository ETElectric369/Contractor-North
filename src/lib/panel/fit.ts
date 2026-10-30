/**
 * DOES THE NAME FIT ITS LABEL? (the panel-first wave, P0). Pure: no React, no Supabase.
 *
 * Every label box is exactly as wide as the strip and as tall as its handle, so the only thing that
 * can give is the size of the type. The words are set as large as they fit, wrapped on spaces, down
 * to a 6 pt floor; a name that still cannot fit at 6 pt is TIGHT, and the print page says so on
 * screen before anything is printed (shorten it, or widen the strip). Nothing is ever clipped.
 *
 * The measure is an estimate that errs WIDE, so a name the screen passes is a name the paper holds:
 * each character is measured by its class (CHAR_EM — a capital is wider than a lowercase letter, so
 * "REFRIGERATOR" is measured as the long word it is) and a line is 1.15 of the type tall (1 pt =
 * 1/72 in). What the words get is the box less its border (BORDER_PT, each side) and its inner
 * margin (LABEL_PAD_IN, each side), across AND down. The print page draws the boxes with exactly
 * that border and margin and sets the words at labelPt, so the screen's verdict and the paper's are
 * the same sum. The box never clips (a clipped name is the law broken): the tight warning is what
 * protects a name from spilling into the next box.
 */
import type { StripLine } from "./strip";

/**
 * THE CHARACTER TABLE: how wide a character sets, in ems of the type size, by its class. Set wide of
 * Arial's own widths on purpose (its capitals average about 0.66, its digits 0.556, its lowercase
 * about 0.5), so the estimate never passes a name the paper can't hold.
 */
export const CHAR_EM = {
  /** A–Z, and any other capital letter. */
  capital: 0.72,
  /** 0–9. */
  digit: 0.6,
  /** a–z, punctuation, and anything else. */
  lower: 0.52,
  /** The space between two words. */
  space: 0.28,
} as const;
/** One line's height, in ems. */
export const LINE_EM = 1.15;
/** The floor and the ceiling of the type, in points. */
export const MIN_PT = 6;
export const MAX_PT = 11;
/** The type steps down by half a point at a time. */
const STEP_PT = 0.5;
/** The space kept clear inside each box's edges, in inches (the print page's padding). */
export const LABEL_PAD_IN = 0.03;
/** Each box's border line, in points (the print page's border). */
export const BORDER_PT = 0.5;
const PT_PER_IN = 72;

/** One character's width, in ems (CHAR_EM). */
function charEm(ch: string): number {
  if (/\s/.test(ch)) return CHAR_EM.space;
  if (/\d/.test(ch)) return CHAR_EM.digit;
  if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) return CHAR_EM.capital;
  return CHAR_EM.lower;
}

/** A word's width, in ems. */
export function wordEm(word: string): number {
  return [...word].reduce((s, ch) => s + charEm(ch), 0);
}

/** What a box `widthIn` × `heightIn` leaves for its words, in points: less the border and the inner
 *  margin on every side. */
export function innerPt(widthIn: number, heightIn: number): { width: number; height: number } {
  const edge = 2 * BORDER_PT + 2 * LABEL_PAD_IN * PT_PER_IN;
  return { width: widthIn * PT_PER_IN - edge, height: heightIn * PT_PER_IN - edge };
}

/** How many rows these words take in a row `rowEm` ems wide, wrapped on spaces; null when one word
 *  alone is wider than the row. */
function rowsAt(words: number[], rowEm: number): number | null {
  let rows = 0;
  let used = 0;
  for (const w of words) {
    if (w > rowEm + 1e-9) return null;
    if (rows === 0 || used + CHAR_EM.space + w > rowEm + 1e-9) {
      rows++;
      used = w;
    } else {
      used += CHAR_EM.space + w;
    }
  }
  return rows;
}

/**
 * The largest type, in points, that sets `text` inside a label box `widthIn` × `heightIn` (its
 * border and inner margin taken off, wrapped on word boundaries), or null when even `minPt` cannot:
 * a word wider than the box at the floor, or more rows than the box is tall. Blank text fits at the
 * ceiling (there is nothing to set).
 */
export function fontPtFor(text: string, widthIn: number, heightIn: number, { minPt = MIN_PT, maxPt = MAX_PT }: { minPt?: number; maxPt?: number } = {}): number | null {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean).map(wordEm);
  if (!words.length) return maxPt;
  if (!(widthIn > 0) || !(heightIn > 0)) return null;
  const inner = innerPt(widthIn, heightIn);
  if (!(inner.width > 0) || !(inner.height > 0)) return null;
  for (let pt = maxPt; pt >= minPt - 1e-9; pt -= STEP_PT) {
    const rowsFit = Math.floor(inner.height / (LINE_EM * pt) + 1e-9);
    if (rowsFit < 1) continue;
    const rows = rowsAt(words, inner.width / pt);
    if (rows != null && rows <= rowsFit) return Math.round(pt * 2) / 2;
  }
  return null;
}

/** The type for one box of a strip `widthIn` wide and its own height. The print page sets the
 *  words at exactly this. */
export function labelPt(line: Pick<StripLine, "text" | "heightIn">, widthIn: number): number | null {
  return fontPtFor(line.text, widthIn, line.heightIn);
}

export type TightLine = Pick<StripLine, "space" | "half" | "text">;

/** The boxes of one strip whose words cannot fit at the floor. Empty, dead and no-box cells never count. */
export function fitCheck(lines: StripLine[], widthIn: number): { tight: TightLine[]; count: number } {
  const tight = lines
    .filter((l) => l.kind !== "empty" && l.kind !== "dead" && l.kind !== "none" && l.text.trim() !== "")
    .filter((l) => labelPt(l, widthIn) == null)
    .map((l) => ({ space: l.space, half: l.half, text: l.text }));
  return { tight, count: tight.length };
}

/** "3 labels are tight — shorten them or widen the strip." (null when none are). */
export function tightWords(count: number): string | null {
  if (!(count > 0)) return null;
  return count === 1
    ? "1 label is tight — shorten it or widen the strip."
    : `${count} labels are tight — shorten them or widen the strip.`;
}
