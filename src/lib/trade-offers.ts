/**
 * WHAT A TRADE'S PACKAGE OFFERS A COMPANY THAT ALREADY EXISTS — the pure diff behind Settings ›
 * Features › Your Trade & Pricing (cn-v1135).
 *
 * Sign-up seeds a trade's package whole (the codes, the switches, the starter sheet). A company that
 * changes its trade later is not a blank company: it has codes it typed, switches its owner set and
 * maybe a sheet it rewrote. So a trade change moves NOTHING on its own (Erik: nothing automatic). It
 * OFFERS, and each offer is one button that says what it would do and how much of it is new:
 *
 *   codes     the registry's job codes the company lacks under EITHER spelling (lib/trade-package
 *             canonicalCode folds the pre-1135 packs' aliases: a company holding TRBL is not
 *             offered TROUB);
 *   switches  the keys the package turns on or off beyond the blank preset whose value differs from
 *             the company's own map today — only those keys, never the whole preset (a switch the
 *             owner set by hand and the package does not name stays as it is);
 *   sheet     one inspection sheet per company (forms.is_inspection): offered only when there is
 *             none, because a sheet that exists is the company's own and stays.
 *
 * The words are built here too, so the card and the actions say the same thing and one test holds
 * them. Every button's words are Title Case except the trade's menu row, which is the registry's.
 */
import { FEATURE_BY_KEY, type FeatureKey, type FeatureMap } from "@/lib/features";
import { canonicalCode, tradePackage, type JobCodeSeed, type TradeKey } from "@/lib/trade-package";

export type SwitchMove = { key: FeatureKey; on: boolean; words: string };

export type TradeOffers = {
  key: TradeKey;
  /** The trade's menu row ("Plumbing", "Deck / Carpentry"), as the registry spells it. */
  menu: string;
  /** The registry's codes the company does not have under either spelling. */
  codes: JobCodeSeed[];
  /** The switches the package would move, in FEATURES order. */
  switches: SwitchMove[];
  /** The company already has an inspection sheet: it stays, nothing is offered. */
  hasSheet: boolean;
};

/** What the company holds today, read by the server door. */
export type CompanyState = {
  /** Its job codes, any spelling (job_codes.code). */
  codes: string[];
  /** Its switches as the app reads them (normalizeFeatures(settings.features, settings.timeclock_job_codes)). */
  features: FeatureMap;
  hasSheet: boolean;
};

/** The three offers for one trade against one company. Pure. */
export function tradeOffersFor(key: TradeKey, company: CompanyState): TradeOffers {
  const pkg = tradePackage(key);
  if (!pkg) throw new Error(`There is no trade called "${String(key)}".`);
  const have = new Set(company.codes.map((c) => canonicalCode(key, c)));
  const codes = pkg.codes.filter((c) => !have.has(canonicalCode(key, c.code)));
  const switches: SwitchMove[] = [];
  for (const [k, on] of Object.entries(pkg.features) as [FeatureKey, boolean][]) {
    if (typeof on !== "boolean" || company.features[k] === on) continue;
    switches.push({ key: k, on, words: `${FEATURE_BY_KEY[k].label} ${on ? "on" : "off"}` });
  }
  return { key, menu: pkg.menu, codes, switches, hasSheet: company.hasSheet };
}

// ── THE WORDS, shared by the card and the actions ────────────────────────────────────────────────

/** The codes button, or the line that stands where it would be when there is nothing to add. */
export function codesOfferWords(o: Pick<TradeOffers, "menu" | "codes">): { button: string | null; line: string } {
  const n = o.codes.length;
  if (n === 0) return { button: null, line: `You already have all of ${o.menu}'s codes.` };
  return { button: `Add ${o.menu}'s Job Codes (${n} New)`, line: `${n} new: ${o.codes.map((c) => c.code).join(", ")}.` };
}

/** The switches button, or the line when the company's switches already match. */
export function switchesOfferWords(o: Pick<TradeOffers, "menu" | "switches">): { button: string | null; line: string } {
  if (o.switches.length === 0) return { button: null, line: "Your switches already match." };
  return { button: `Use ${o.menu}'s Usual Switches`, line: `${o.switches.map((s) => s.words).join(" · ")}.` };
}

/** The sheet button, or the line when a sheet already exists. */
export function sheetOfferWords(o: Pick<TradeOffers, "menu" | "hasSheet">): { button: string | null; line: string } {
  if (o.hasSheet) return { button: null, line: "You already have an inspection sheet; it stays." };
  return { button: `Start ${o.menu}'s Inspection Sheet`, line: "One router question, then the few that change the price. Edit it any time." };
}

/** What applyTradeSwitches says after it ran: the moves that landed, or that there were none. */
export function switchesMovedWords(moved: SwitchMove[]): string {
  return moved.length ? `${moved.map((s) => s.words).join(", ")}.` : "Nothing to change.";
}

/** What applyTradeCodes says after the import: how many landed, or that every one was there. */
export function codesAddedWords(menu: string, added: number, skipped: number): string {
  if (added === 0) return `You already had every one of ${menu}'s codes.`;
  const kept = skipped > 0 ? ` ${skipped} you already had stayed as they were.` : "";
  return `Added ${added} of ${menu}'s codes.${kept}`;
}
