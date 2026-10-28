import type { Playbook } from "../types";
import { tradePackage } from "@/lib/trade-package";
import { withArticle } from "@/lib/org-trade";
import { ET_ELECTRIC } from "./et-electric";
import { TAHOE_DECK } from "./tahoe-deck";

/**
 * THE STARTER LIBRARY — a playbook somebody can begin from instead of a blank page.
 *
 * A starter is a DRAFT to be argued with, not a template to be obeyed. The whole reason a playbook
 * beats a shared sheet is that the questions and the reasons are the contractor's own; a starter
 * only exists so the first version isn't empty, and every line in it is meant to be cut or
 * rewritten. That is also why each one carries `why` text in somebody's actual voice: a why
 * written in ours would be furniture, and furniture is what nobody edits.
 *
 * DELIBERATELY SHORT. There are two, electrical and deck, because each was written against real
 * jobs by the person who does that work. Inventing a plumbing playbook from what I imagine plumbers care about would
 * produce exactly the sheet this whole build replaced — plausible questions nobody chose, which is
 * the failure Erik hit at 13125 Mayfern Rd. The starter sheets (lib/inspection/starter-sheets) are
 * still there for every other trade, and playbookForForm converts them, so nobody is left with
 * nothing while this list grows one honest entry at a time.
 */
export interface PlaybookStarter {
  key: string;
  label: string;
  /** What kind of starter it is and what it was built against — shown when somebody is choosing.
   *  Every company sees it, so it names no company and no person (et-leaks.test). */
  blurb: string;
  playbook: Playbook;
}

export const PLAYBOOK_STARTERS: PlaybookStarter[] = [
  {
    key: "et-electric",
    label: "Electrical — residential service & remodel",
    blurb:
      "An electrical starter, built against a storage room being converted to living space: the panel " +
      "fork first, the run length only after it, and the outlet count derived from wall feet when the room was measured.",
    playbook: ET_ELECTRIC,
  },
  {
    key: "tahoe-deck",
    label: "Decks — build, resurface, railing & stairs",
    blurb:
      "A deck-builder starter that mirrors a public deck estimator question for question, so a customer's " +
      "answers carry in and are confirmed rather than re-asked. Formula why lines throughout — each names the " +
      "price code it feeds, so the questions and the price list can be read against each other.",
    playbook: TAHOE_DECK,
  },
];

export const playbookStarter = (key: string): Playbook | null =>
  PLAYBOOK_STARTERS.find((s) => s.key === key)?.playbook ?? null;

/**
 * THE COMPANY'S OWN TRADE FIRST (cn-v1135). The trade package names the starter written for each
 * trade (lib/trade-package playbookStarter — null for the trades nobody on North has written one
 * for yet); the Settings card leads with that one and lists the rest under the other trades. The
 * DATA above is unchanged: no starter is invented for a trade without one, and the card says so.
 */
export function startersForTrade(key: string): { own: PlaybookStarter | null; others: PlaybookStarter[] } {
  const ownKey = tradePackage(key)?.playbookStarter ?? null;
  const own = ownKey ? PLAYBOOK_STARTERS.find((s) => s.key === ownKey) ?? null : null;
  return { own, others: PLAYBOOK_STARTERS.filter((s) => s !== own) };
}

/** What the Settings page hands the browser for the picker: the words, never the playbook itself. */
export type StarterRow = Pick<PlaybookStarter, "key" | "label" | "blurb">;

export type StarterRows = {
  own: StarterRow | null;
  others: StarterRow[];
  /** "a plumber": the company's trade, with its article, for the line the card says when no starter
   *  is written for it; "" when the trade isn't known (then the card says nothing of the kind). */
  tradeWords: string;
};

export function starterRowsForTrade(key: string): StarterRows {
  const row = ({ key, label, blurb }: PlaybookStarter): StarterRow => ({ key, label, blurb });
  const { own, others } = startersForTrade(key);
  return { own: own ? row(own) : null, others: others.map(row), tradeWords: withArticle(tradePackage(key)?.words ?? "") };
}
