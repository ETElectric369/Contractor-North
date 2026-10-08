import { aliasKey, matchSupplierNames, normalizeSupplierName, suggestSupplierGroups, type SupplierMatch } from "@/lib/supplier-identity";

/**
 * "DID YOU MEAN?" FOR THE SUPPLIER BOX (Wednesday task 4, item D, 2026-10-07).
 *
 * Every supplier box was a plain text field: "CED" typed five ways made five suppliers, and the
 * Suppliers card had to explain them away afterwards. The fuzzy matcher already existed
 * (matchSupplierNames, pure) and no form asked it. Now one does, by supplier-identity's own rule:
 * an EXACT spelling of a known supplier (case, punctuation, an alias) is kept silently and the
 * server stores the supplier's one name; anything FUZZY only ASKS - "Did you mean X?" with a Use X
 * button - and is never written for him. A tie between two suppliers asks which.
 */

/** A supplier as the box knows one: its one name, and every spelling that already means it (its
 *  aliases, and the bill spellings an account resolves). */
export type KnownSupplier = { name: string; spellings: string[] };

export type SupplierSuggestion = { name: string; why: string } | { choices: string[] };

/** Every spelling a known supplier answers to, lowercased, for the exact test. */
const keysOf = (k: KnownSupplier) => [k.name, ...k.spellings].map(aliasKey).filter(Boolean);

/** The known supplier `typed` is an exact spelling of (case and punctuation aside), or null. */
export function exactKnownSupplier(typed: string, known: readonly KnownSupplier[]): KnownSupplier | null {
  const key = aliasKey(typed);
  if (!key) return null;
  const norm = normalizeSupplierName(typed);
  for (const k of known) {
    if (keysOf(k).includes(key)) return k;
    if (norm && [k.name, ...k.spellings].some((s) => normalizeSupplierName(s) === norm)) return k;
  }
  return null;
}

/**
 * The spelling the server stores: a known supplier's one name when `typed` is exactly one of its
 * spellings, else what was typed (trimmed). Exact only: a fuzzy write is never made for him.
 */
export function snapSupplierSpelling(typed: string, known: readonly KnownSupplier[]): string {
  const t = String(typed ?? "").trim();
  if (!t) return t;
  return exactKnownSupplier(t, known)?.name ?? t;
}

/**
 * What the box says under itself as he types: nothing on an exact known spelling (the server keeps
 * it), nothing under three letters, else the one supplier this looks like with the matcher's own
 * reason, or the two or three it could be. "likely" or better only: a "possible" match is the
 * matcher's own word for not worth asking.
 */
export function didYouMeanSupplier(typed: string, known: readonly KnownSupplier[]): SupplierSuggestion | null {
  const t = String(typed ?? "").trim();
  if (t.replace(/[^a-z0-9]/gi, "").length < 3) return null;
  if (exactKnownSupplier(t, known)) return null;
  const best: { name: string; match: SupplierMatch }[] = [];
  for (const k of known) {
    let top: SupplierMatch | null = null;
    for (const s of [k.name, ...k.spellings]) {
      const m = matchSupplierNames(t, s);
      if (m && m.confidence !== "possible" && (!top || m.score > top.score)) top = m;
    }
    if (top) best.push({ name: k.name, match: top });
  }
  if (!best.length) return null;
  best.sort((a, b) => b.match.score - a.match.score || a.name.localeCompare(b.name));
  const lead = best[0];
  const tied = best.filter((b) => Math.abs(b.match.score - lead.match.score) < 0.05);
  if (tied.length > 1) return { choices: tied.slice(0, 3).map((b) => b.name) };
  return { name: lead.name, why: lead.match.reasons[0] ?? "It looks like the same supplier." };
}

/**
 * THE KNOWN LIST, folded once on the server: every account under its one name with its aliases;
 * the bill spellings that resolve to an account join that account; the rest are grouped by the
 * identity rule (suggestSupplierGroups) under the group's fullest spelling, so the box offers the
 * one spelling a group would be retired into and never the five it is meant to retire.
 */
export function knownSuppliersFrom(
  accounts: readonly { id: string; name: string }[],
  aliases: readonly { alias: string; supplier_account_id: string }[],
  billSpellings: readonly (string | null | undefined)[],
): KnownSupplier[] {
  const byId = new Map<string, KnownSupplier>();
  for (const a of accounts) {
    const name = String(a.name ?? "").trim();
    if (name) byId.set(String(a.id), { name, spellings: [] });
  }
  for (const al of aliases) {
    const k = byId.get(String(al.supplier_account_id));
    const s = String(al.alias ?? "").trim();
    if (k && s && !k.spellings.includes(s)) k.spellings.push(s);
  }
  const known = [...byId.values()];
  const loose: string[] = [];
  const seen = new Set<string>();
  for (const raw of billSpellings) {
    const s = String(raw ?? "").trim();
    const key = aliasKey(s);
    if (!s || seen.has(key)) continue;
    seen.add(key);
    const k = exactKnownSupplier(s, known);
    if (k) {
      if (aliasKey(k.name) !== key && !k.spellings.some((x) => aliasKey(x) === key)) k.spellings.push(s);
      continue;
    }
    // A SPELLING THE IDENTITY RULE ALREADY READS AS AN ACCOUNT'S (likely or better: "C.E.D." against
    // the alias "CED") is not a supplier of its own. Left off the list, so typing it ASKS "Did you
    // mean <the account>?" - listed, it would be an exact known spelling and the box would keep
    // quiet over the very spelling the Suppliers card is trying to retire.
    const looksLikeAnAccount = known.some((a) => [a.name, ...a.spellings].some((x) => (matchSupplierNames(s, x)?.confidence ?? "possible") !== "possible"));
    if (looksLikeAnAccount) continue;
    loose.push(s);
  }
  const grouped = new Set<string>();
  for (const g of suggestSupplierGroups(loose).groups) {
    known.push({ name: g.suggestedName, spellings: g.members.filter((m) => m !== g.suggestedName) });
    for (const m of g.members) grouped.add(aliasKey(m));
  }
  for (const s of loose) if (!grouped.has(aliasKey(s))) known.push({ name: s, spellings: [] });
  return known;
}
