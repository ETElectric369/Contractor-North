/**
 * FIND ANY PAPER ON /bills BY WHAT HE REMEMBERS ABOUT IT (Bills plan, Wave A, 2026-09-25).
 *
 * The page had no search at all, cut every list at six rows, and kept collapsed rows out of the
 * DOM, so Cmd-F missed them on a laptop and a phone has no find. He remembers a paper by one of
 * five things: its number ("1107820"), the street ("whitney"), the job ("J-028"), what CED wrote
 * on it ("85 WHITNEY"), or the money ("187.64"). Every one of those is in `words` below, over the
 * papers the page has ALREADY loaded: no new read, nothing sent anywhere, typed and answered on
 * the phone.
 *
 * Pure, so the matching is tested without a browser.
 */

export interface BillsSearchRow {
  key: string;
  /** A supplier's own document, a bill in his books, or a receipt/bill file on a job. */
  kind: "paper" | "bill" | "file";
  /** The line he reads first: "CED Invoice 8802-1107820". */
  title: string;
  /** Where it is and what it is: "Sep 16 · $187.64 · on J-028 85 Whitney Place · in your books". */
  sub: string;
  /** Everything it can be found by, folded (fold()). */
  words: string;
  /** Where a tap takes him: the job, the waiting card, or the file. Null when there is nowhere. */
  href: string | null;
}

/** Lowercase, and every run of anything that is not a letter, a digit or a decimal point is one
 *  space: "8802-1107820" is "8802 1107820", "$187.64" is "187.64", "J-028" is "j 028". */
export function fold(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    // "$1,062.18" is 1062.18: a thousands comma is not a word break.
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(^|\s)\.+|\.+(\s|$)/g, " ")
    .trim();
}

/** A money figure every way it gets typed: "187.64", and "1062.18" for "$1,062.18". */
export function moneyWords(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return Math.abs(v).toFixed(2);
}

/** Build the words a row is found by from any number of parts. */
export function wordsOf(...parts: unknown[]): string {
  return ` ${parts.map(fold).filter(Boolean).join(" ")} `;
}

/**
 * THE ROWS A QUERY FINDS. Every word he typed has to appear somewhere on the row, so "whitney 187"
 * narrows to the one paper. Fewer than two characters finds nothing (a single "8" would match the
 * whole book). `more` is how many matched beyond the ones shown, so the list never hides a count.
 */
export function searchBills(rows: BillsSearchRow[], query: string, limit = 25): { hits: BillsSearchRow[]; more: number } {
  const q = fold(query);
  if (q.replace(/\s/g, "").length < 2) return { hits: [], more: 0 };
  const tokens = q.split(" ").filter(Boolean);
  const all = (rows ?? []).filter((r) => tokens.every((t) => r.words.includes(t)));
  return { hits: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}
