import type { Answers, Need, Playbook } from "./types";

/**
 * THE SCOPE WORD, AND WHAT IT LIGHTS (Erik, 2026-10-13: "every job has a scope and this can be
 * the first why line … Deck/Remodel drops down the tasks preset with all the kits").
 *
 * The scope is a slot of its own (types.ts: `{ type: "scope" }`), set per company in the playbook
 * — typed freely or picked from the company's own words. Whichever mode, the answer is ONE word
 * or a few, and the Inspector offers the kits filed under it: a kit is offered as a task when
 * `kits.category` says the same word, compared blind to case, spacing and punctuation, so typed
 * "deck" and chosen "Deck" both light "Add The Deck Tasks". Nothing here invents a count or an
 * hour: an offered task arrives ASKING (no-speculation), with the kit's hours per unit and no units.
 */

/** The FIRST scope need in a playbook is the scope; a second one is a plain question. */
export function scopeNeed(pb: Playbook | null | undefined): Need | null {
  return pb?.needs.find((n) => n.slot?.type === "scope") ?? null;
}

/**
 * The longest a scope can be and still be a WORD: the same 60 a kit's category is cut at
 * (MAX_KIT_CATEGORY in lib/estimate/kit-from-task — a test holds the two together).
 */
export const MAX_SCOPE_WORD = 60;

/**
 * The scope as answered: a trimmed string, or null. A scope typed freely may be a whole paragraph
 * (answers.ts keeps it whole), but a paragraph is not a word: it offers no kit, and it is never
 * the category a kit files under — Remember As A Kit would store its first 60 characters, cut
 * mid-word, as the kit's scope. Null here leaves that box empty and ASKS for the word.
 */
export function scopeWord(pb: Playbook | null | undefined, answers: Answers | null | undefined): string | null {
  const n = scopeNeed(pb);
  if (!n) return null;
  const v = answers?.[n.key];
  const s = String((Array.isArray(v) ? v[0] : v) ?? "").trim();
  return s && s.length <= MAX_SCOPE_WORD ? s : null;
}

/**
 * The scope words that were RENAMED between two edits of the words box, paired by POSITION: the
 * line that stood at place i and the line that stands there now. Only an unambiguous edit counts —
 * the same number of words before as after, and a pair is a rename only when the old word is gone
 * from the list and the new one is new to it (so a reorder or a swap renames nothing, a word that
 * is added or deleted outright is left for the author to resolve, the same call the select editor
 * makes, and a reorder with two renames in one visit never crosses them: a line that moved is not
 * a rename). The editor feeds each pair to renameOptionInRules, so a question that waits on "Deck"
 * follows it to "Decking" instead of going quiet on every visit.
 */
export function scopeWordRenames(before: readonly string[], after: readonly string[]): { from: string; to: string }[] {
  const words = (list: readonly string[]) => list.map((w) => w.trim()).filter(Boolean);
  const b = words(before);
  const a = words(after);
  if (b.length !== a.length) return [];
  return b.flatMap((from, i) => (!a.includes(from) && !b.includes(a[i]) ? [{ from, to: a[i] }] : []));
}

/** "Deck", " deck ", "DECK", "deck." → "deck": the comparison key for a scope word or a kit category. */
export function scopeKey(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    // "Decks" and "Deck" are one scope (skeptic #5, carried): a plain trailing s folds off a word of
    // four letters or more that does not end in a double s — decks, wires, panels, remodels; never
    // glass, gas, bus. (A word like "boxes" keeps its e; that is a known limit, not a rule.)
    .split(" ")
    .map((w) => (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");
}

export const sameScope = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const ka = scopeKey(a);
  return !!ka && ka === scopeKey(b);
};

/** The kits filed under this scope word (kits.category), in the order given. */
export function kitsForScope<T extends { category?: string | null }>(kits: readonly T[], word: string | null | undefined): T[] {
  if (!scopeKey(word)) return [];
  return kits.filter((k) => sameScope(k.category, word));
}

/** His word, capitalized as a button is ("deck" → "Deck", "panel swap" → "Panel Swap"). */
export function scopeTitle(word: string): string {
  return word
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toLocaleUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** The one offer row above a task list: "Add The Deck Tasks (7)". */
export function offerLabel(word: string, count: number): string {
  return `Add The ${scopeTitle(word)} Tasks (${count})`;
}

/**
 * The kit picker's groups: the scope's kits first, then every other category by name, and the
 * kits with no category last under "Other Kits". Null when NO kit has a category — the picker
 * then stays the flat list it always was (nothing to group by).
 */
export function groupedKits<T extends { name: string; category?: string | null }>(
  kits: readonly T[],
  word: string | null | undefined,
): { label: string; kits: T[] }[] | null {
  if (!kits.some((k) => scopeKey(k.category))) return null;
  const byKey = new Map<string, { label: string; kits: T[] }>();
  for (const k of kits) {
    const key = scopeKey(k.category);
    const label = key ? scopeTitle(String(k.category ?? "").trim()) : "Other Kits";
    const g = byKey.get(key) ?? { label, kits: [] };
    g.kits.push(k);
    byKey.set(key, g);
  }
  const wk = scopeKey(word);
  return [...byKey.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (wk && ka === wk) return -1;
      if (wk && kb === wk) return 1;
      if (!ka) return 1;
      if (!kb) return -1;
      return a.label.localeCompare(b.label);
    })
    .map(([, g]) => g);
}
