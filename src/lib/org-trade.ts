/**
 * THE ONE TRADE READER. Every place that decides something by what a company does reads it here.
 *
 * Sign-up keeps the trade as a KEY (settings.trade, 0352), and never writes the words
 * (settings.trade_label). Every guide read the words, so a company that signed up yesterday was
 * asked its trade again by the tour, got no trade line in Nort's instructions, and got a starter
 * inspection chosen by nothing. This reader closes that: the KEY decides, the words describe.
 *
 *   key    settings.trade when it is one of the app's trades; otherwise, as a LAST RESORT, the key
 *          read out of the words a person typed (tradeKeyFromWords). "" when neither says.
 *   label  settings.trade_label, the company's own words; when empty, the key's own words
 *          (TRADE_WORDS). "" only when nothing is known at all.
 *
 * Build for any company: nothing here names a company. ET, Tahoe and Vivian are fixtures in the
 * tests, never cases in the code.
 */
import { normalizeTradeKey, type TradeKey } from "@/lib/features";
import { TRADE_ORDER, TRADE_PACKAGES } from "@/lib/trade-package";

export type OrgTrade = {
  /** The trade key: what behaviour branches on. "" = not known. */
  key: TradeKey | "";
  /** The words a person would use for it: what prompts and screens say. "" = not known. */
  label: string;
};

/**
 * THE KEY'S OWN WORDS, for a company that never typed its own. The sign-up dropdown's labels
 * ("Deck / carpentry", "Electrical") name a menu row; these are what you'd call the person who does
 * it, so a sentence like "an estimator for a …" or "Need a …?" still reads. One per key, enforced
 * by the type — a VIEW of the registry's `words` (lib/trade-package), never a second list.
 */
export const TRADE_WORDS: Record<TradeKey, string> = Object.fromEntries(
  TRADE_ORDER.map((k) => [k, TRADE_PACKAGES[k].words]),
) as Record<TradeKey, string>;

/**
 * THE LAST RESORT: a key read out of free text ("I build decks", "electrical contractor"). Used only
 * when no key is stored. Same rule as 0355's backfill, with one deliberate change of order: an
 * explicit "general contractor" / "GC" is read FIRST, because "general contractor, I sub out
 * electrical" is a general contractor, not an electrician (setup-playbook's own warning). The loose
 * builder words ("construction", "builder", "remodel") come LAST, so "deck builder" stays a deck.
 */
export function tradeKeyFromWords(words: string | null | undefined): TradeKey | "" {
  const t = String(words ?? "").toLowerCase();
  if (!t.trim()) return "";
  if (/general contract|\bgc\b/.test(t)) return "general";
  if (/electric|sparky|low.?voltage|solar/.test(t)) return "electrical";
  if (/\bdeck|carpent/.test(t)) return "deck";
  if (/plumb|drain|sewer/.test(t)) return "plumbing";
  if (/hvac|heating|furnace|\bair\b|mechanical|refrigerat/.test(t)) return "hvac";
  if (/roof/.test(t)) return "roofing";
  if (/concrete|masonry|\bmason/.test(t)) return "concrete";
  if (/\btile|flooring/.test(t)) return "tile";
  if (/landscap|irrigat|\blawn/.test(t)) return "landscaping";
  if (/paint/.test(t)) return "painting";
  if (/construct|builder|remodel|handyman/.test(t)) return "general";
  return "";
}

/** The company's trade, from its settings (raw or normalized; only `trade` and `trade_label` are read). */
export function orgTrade(settings: { trade?: unknown; trade_label?: unknown } | null | undefined): OrgTrade {
  const words = typeof settings?.trade_label === "string" ? settings.trade_label.trim() : "";
  const key = normalizeTradeKey(settings?.trade) || tradeKeyFromWords(words);
  return { key, label: words || (key ? TRADE_WORDS[key] : "") };
}

/** "an electrical contractor", "a deck builder", "an HVAC contractor": the words with their article. */
export function withArticle(words: string): string {
  const w = words.trim();
  if (!w) return "";
  return `${/^(hvac\b|[aeiou])/i.test(w) ? "an" : "a"} ${w}`;
}

/** The words, for a prompt that needs SOME noun: the company's trade, or "contractor". */
export const tradeWordsOr = (settings: Parameters<typeof orgTrade>[0], fallback = "contractor"): string =>
  orgTrade(settings).label || fallback;

/**
 * THE ONE GATE on the public deck configurator (/estimate/<handle>), the header CTA (site-chrome), the
 * sitemap and the site chat's deck tool: a DECK company pricing from its CATALOG. Before cn-v1135 the
 * four gates read catalog mode alone, so a catalog-mode landscaper got a page titled "Deck Estimate"
 * (lib/estimate/deck is Tahoe-shaped by construction: DECK_ESTIMATE_CODES). One function, so the four
 * cannot drift.
 */
export function deckConfiguratorOn(
  settings: { trade?: unknown; trade_label?: unknown; estimating_mode?: unknown } | null | undefined,
): boolean {
  return orgTrade(settings).key === "deck" && settings?.estimating_mode === "catalog";
}
