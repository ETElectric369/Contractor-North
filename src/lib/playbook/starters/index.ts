import type { Playbook } from "../types";
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
 * DELIBERATELY SHORT. There is one, because one has been written against a real job by the person
 * who does that job. Inventing a plumbing playbook from what I imagine plumbers care about would
 * produce exactly the sheet this whole build replaced — plausible questions nobody chose, which is
 * the failure Erik hit at 13125 Moraine Rd. The starter sheets (lib/inspection/starter-sheets) are
 * still there for every other trade, and playbookForForm converts them, so nobody is left with
 * nothing while this list grows one honest entry at a time.
 */
export interface PlaybookStarter {
  key: string;
  label: string;
  /** Whose it is and what it was built against — shown when somebody is choosing. */
  blurb: string;
  playbook: Playbook;
}

export const PLAYBOOK_STARTERS: PlaybookStarter[] = [
  {
    key: "et-electric",
    label: "Electrical — residential service & remodel",
    blurb:
      "Erik's, built against a storage room being converted to living space: the panel fork first, " +
      "the run length only after it, and the outlet count derived from wall feet when the room was measured.",
    playbook: ET_ELECTRIC,
  },
  {
    key: "tahoe-deck",
    label: "Decks — build, resurface, railing & stairs",
    blurb:
      "Chris's, mirroring his own public estimator question for question so a customer's answers " +
      "carry in and he confirms rather than re-asks. Formula why lines throughout — each names the " +
      "price code it feeds, so the questions and the price list can be read against each other.",
    playbook: TAHOE_DECK,
  },
];

export const playbookStarter = (key: string): Playbook | null =>
  PLAYBOOK_STARTERS.find((s) => s.key === key)?.playbook ?? null;
