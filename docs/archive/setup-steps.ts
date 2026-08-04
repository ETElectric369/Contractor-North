/**
 * WHAT A NEW COMPANY STILL NEEDS — the spine of the spoken setup.
 *
 * Erik: "we need an onboarding tutorial starting with something like 'press the talk button and
 * state your name and your trade' then Nort responds interactively setting up all the things."
 *
 * The first outside tenant signed up and landed on an empty My Day. Within sixty seconds the
 * product had already failed him twice: the weather widget threw (`weather fetch failed`, no
 * address on a brand-new org) and his inspection page had no questions on it, because the
 * onboarding seed creates job codes but no inspection sheet. Neither failure is visible to the
 * person it happens to — they just see a broken widget and an empty form and conclude the
 * software is thin.
 *
 * So this module answers one question — "what is still missing, and what is the single next thing
 * to say out loud?" — and it answers it as DATA, not as a wizard. That matters for three reasons:
 *
 *   1. It is PURE, so it can be tested and so both the card and Nort read the same truth. A
 *      checklist the UI computes one way and the assistant computes another is two checklists.
 *   2. It is ORDERED BY WHAT UNBLOCKS THE MOST. Trade first, because trade seeds job codes AND
 *      the inspection sheet AND tells the estimator what business it is in — one answer lights up
 *      three dead surfaces.
 *   3. Every step carries the words to SAY, not a form to fill. The whole point is that a
 *      contractor sets his company up while driving, in one breath per step.
 *
 * DELIBERATELY NOT A GATE. A half-finished setup never blocks the app. Someone who wants to skip
 * straight to writing an estimate can; the card just keeps offering the next thing.
 */

export type SetupStepKey = "identity" | "where" | "rate" | "first_customer";

export interface SetupStep {
  key: SetupStepKey;
  /** Shown on the card. */
  title: string;
  /** The exact sentence to say out loud. This is the product — not a field label. */
  say: string;
  /** Why it matters, in the user's terms. One line, no jargon. */
  because: string;
  done: boolean;
}

/** Everything the step calculation needs. Counts, not rows — this stays cheap and pure. */
export interface SetupFacts {
  fullName: string | null | undefined;
  tradeLabel: string | null | undefined;
  /** settings.public_city — also what the weather widget needs to stop throwing. */
  city: string | null | undefined;
  serviceArea: string | null | undefined;
  defaultLaborRate: number | null | undefined;
  /** forms rows with is_inspection = true. Zero means the inspector has no questions. */
  inspectionSheets: number;
  customers: number;
}

const has = (s: string | null | undefined) => !!(s && s.trim());

/**
 * The ordered checklist. Every step is returned, done or not, so the card can show progress —
 * "2 of 4" is motivating in a way that a shrinking list is not.
 */
export function setupSteps(f: SetupFacts): SetupStep[] {
  return [
    {
      key: "identity",
      title: "Your name and your trade",
      say: "My name is ___ and I'm a ___",
      // One answer, three dead surfaces lit: the job codes you clock time against, the questions
      // the inspector asks on site, and what the estimator thinks it is pricing.
      because: "Sets up your job codes, your walk-through questions, and how estimates get written.",
      done: has(f.fullName) && has(f.tradeLabel) && f.inspectionSheets > 0,
    },
    {
      key: "where",
      title: "Where you work",
      say: "I work out of ___ and I cover ___",
      because: "Puts the weather on your day and tells customers the area you serve.",
      done: has(f.city) || has(f.serviceArea),
    },
    {
      key: "rate",
      title: "What you charge",
      say: "I charge ___ an hour",
      because: "So an estimate can price labor without you doing the math.",
      done: (f.defaultLaborRate ?? 0) > 0,
    },
    {
      key: "first_customer",
      title: "Someone you're working for",
      say: "I'm working for ___ at ___",
      because: "The app has nothing to show you until there's one real job in it.",
      done: f.customers > 0,
    },
  ];
}

/** The next thing to say, or null when setup is done. */
export function nextStep(f: SetupFacts): SetupStep | null {
  return setupSteps(f).find((s) => !s.done) ?? null;
}

/** Progress, for the card. */
export function setupProgress(f: SetupFacts): { done: number; total: number; complete: boolean } {
  const steps = setupSteps(f);
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, complete: done === steps.length };
}

/**
 * The opening line. Deliberately ONE instruction and one sentence to repeat — a new user holding
 * a phone will not read a paragraph, and "state your name and your trade" is something a person
 * can say without thinking about what the software wants.
 */
export const SETUP_OPENER = "Press Talk and tell me your name and your trade.";
