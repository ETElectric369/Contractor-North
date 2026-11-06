import { say, type Words } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";

/**
 * THE ONE LABOR-RATE RULE — for an hour he is QUOTING and for an hour somebody WORKED alike.
 *
 *   the person's own bill rate (Team page), when the row names a person and they have one (> 0),
 *     held under the customer's pricing-level rate when the level has one
 *     → else the customer's pricing-level labor rate (> 0)
 *     → else the org's default_labor_rate (Settings)
 *     → else 0, which every caller reads as "no rate set — say so, never guess one".
 *
 * Until cn-v1131 this file knew only the level and the default, and labor-billing.ts carried the
 * same ladder with the person on top, in its own words. The two disagreed on the one hour that
 * matters most: the owner's own. His Team rate billed his clocked hours at one figure while the
 * estimate quoted the same hour at the Settings default, and nothing on either screen said which
 * was which. One function, one arithmetic, called by the estimate seed, the estimator, the builder
 * and computeJobLaborBilling, so an hour prices the same on every door ([[two-doors-one-thing]]).
 *
 * `from` says where the figure came from, so a screen can name it beside the number ("company
 * default", "the Local level", "<name>'s rate") instead of leaving him to guess which card to open.
 */
export type LaborRateFrom = "person" | "level" | "default" | "none";

export interface LaborRateInput {
  /** The named person's own bill rate (profiles.bill_rate), when the labor row names a person. */
  personRate?: number | string | null;
  /** The customer's pricing-level labor rate (pricing_levels.labor_rate). */
  levelRate?: number | string | null;
  /** The company's default labor rate (settings.default_labor_rate). */
  orgDefault?: number | string | null;
}

const positive = (v: number | string | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function laborRateFor(input: LaborRateInput): { rate: number; from: LaborRateFrom } {
  const person = positive(input.personRate);
  const level = positive(input.levelRate);
  const def = positive(input.orgDefault);
  if (person > 0) return { rate: level > 0 ? Math.min(person, level) : person, from: "person" };
  if (level > 0) return { rate: level, from: "level" };
  if (def > 0) return { rate: def, from: "default" };
  return { rate: 0, from: "none" };
}

/** The words a screen prints beside a rate for where it came from (Title Case is for buttons;
 *  this sits in a sentence). `personName` is used only for "person". The English is inline, byte for
 *  byte; a Spanish reader's caller hands its `lang` and translator (lib/lang-words say), and the
 *  Spanish lives in lib/words/quotes-breakdown (qb_lib_rateFrom…). */
export function laborRateFromWords(from: LaborRateFrom, personName?: string | null, lang: Lang | string | null = "en", words?: Words): string {
  switch (from) {
    case "person":
      return personName
        ? say(lang, words, "qb_lib_rateFromPerson", `${personName}'s rate`, { name: personName })
        : say(lang, words, "qb_lib_rateFromTheirs", "their rate");
    case "level":
      return say(lang, words, "qb_lib_rateFromLevel", "the customer's level");
    case "default":
      return say(lang, words, "qb_lib_rateFromDefault", "company default");
    default:
      return say(lang, words, "qb_lib_rateFromNone", "no rate set");
  }
}
