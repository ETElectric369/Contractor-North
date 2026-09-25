/**
 * WHAT AN IMPORT SAID BESIDES ITS COUNT (audit v994 SI5).
 *
 * The invoice importers return more than "N pulled in": `stats.warnings` is money a person should
 * look at before sending (an edited "Supplies & tax" row left behind by re-priced parts, INV-074;
 * a person billed at the level rate for want of a bill rate), and `stats.notes` is what the counts
 * don't say (a counter-preview price, a return not credited or held, the invoice's own markup
 * kept). An empty materials run can carry a reason worth passing on too (`emptyNote`: a supplier
 * return held back, with nothing else to bill).
 *
 * The invoice page and refreshActualsDraw said all of it; the job-level doors (New Invoice landing
 * on a draft, Add to INV-0xx, a fresh progress payment) kept only the count, so the INV-074
 * shortfall warning was computed and dropped, and the toast said "pulled in what's new".
 * One reader for all of them.
 */
export type ImportOutcomeLike = {
  ok: boolean;
  empty?: boolean;
  emptyNote?: string;
  stats?: { warnings?: string[]; notes?: string[] } | null;
};

export type ImportExtras = { warnings: string[]; notes: string[] };

export function importExtras(results: ImportOutcomeLike[]): ImportExtras {
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const r of results) {
    if (r.ok) {
      warnings.push(...(r.stats?.warnings ?? []));
      notes.push(...(r.stats?.notes ?? []));
    } else if (r.empty && r.emptyNote) {
      notes.push(r.emptyNote);
    }
  }
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim().replace(/\.$/, "")).filter(Boolean))];
  return { warnings: clean(warnings), notes: clean(notes) };
}

/** The extras as sentences to add after a door's own sentence: notes first, then the warnings
 *  (the heads-up a person must read before sending). Empty string when there is nothing to say. */
export function extrasSentence(x: ImportExtras): string {
  const all = [...x.notes, ...x.warnings];
  if (!all.length) return "";
  return ` ${all.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(". ")}.`;
}
