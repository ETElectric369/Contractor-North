import type { Need } from "./types";

/**
 * WHAT A WHY LINE ACTUALLY IS — and the reframe that finally made it teachable.
 *
 * Erik, after reading the onboarding that was supposed to explain them:
 *
 *   "the example in #7 makes no sense to me nor do my why lines, anyone including myself reviewing
 *    these proposed why lines is automatically confused as fuck … i kind of get it because my brain
 *    is a little more like yours but guaranteed this aint going nowhere"
 *
 * Then, the correction that fixed it:
 *
 *   "the why is important but how is this ultimately going to shape my estimate, what do i need to
 *    know (ie my brother is going to ask his set of questions they are firm so the why is: because
 *    this gets multiplied by that and = x and that feeds the board length generator) … we need
 *    precision for every single person and based in the simplest of simplicities. for me my
 *    questions need to be prompted around what i have to accomplish and what i need to do it"
 *
 * ── THE REFRAME ────────────────────────────────────────────────────────────────────────────
 *
 * I had been writing why lines as JUSTIFICATIONS — little essays about what a wrong answer costs.
 * That is why nobody could follow them, including the man who commissioned them. A justification is
 * a story, and stories are long, arguable and unverifiable.
 *
 * **A WHY LINE IS THE PATH FROM THE ANSWER TO THE NUMBER.** Not "why I ask" — "where this ends up
 * in my price". That is a mechanical fact about the estimate, and every contractor alive can state
 * it about his own trade in one breath.
 *
 * It also unifies the two brothers, who looked like they needed different systems and don't:
 *
 *   CHRIS (deck, catalog pricing)   "Length times width is the square footage, and that drives the
 *                                    board count." Firm questions, firm arithmetic. Get the
 *                                    question wrong and the CALCULATION is wrong.
 *   ERIK (electrical, judgement)    "Decides subpanel or home runs — sets every run length after
 *                                    it." A fork rather than a formula, but the same shape: this
 *                                    answer LANDS somewhere specific downstream.
 *
 * ── WHY THIS IS ARCHITECTURE AND NOT COPY ──────────────────────────────────────────────────
 *
 * Because it makes a why line CHECKABLE. A justification can only be admired; a path can be
 * examined for whether it actually names a destination. `whyProblems` below is the whole point:
 * it is the difference between "we hope people write good ones" and "we can tell them when they
 * haven't", which is what "precision for every single person" requires.
 */

/** The one question that produces a why line. Never "why do you ask this?" — that invites an essay. */
export const WHY_ASK = "Where does this end up in your price?";

/** The same question, said a few ways, for when the first phrasing doesn't land. */
export const WHY_ASK_ALTS = [
  "What does this number do in your estimate?",
  "What are you working out with this one?",
  "If this answer changed, what changes in the price?",
];

/**
 * THE THREE SHAPES A PATH TAKES. Not a setting anybody picks — a set of patterns to show, so the
 * first line somebody writes has something to be shaped like. One real example each, from real
 * playbooks in this app.
 */
export const WHY_SHAPES = [
  {
    key: "formula",
    label: "It goes into a calculation",
    hint: "…times… = …, and that gives me…",
    example: "Length × width is the square footage, and that drives the board count and the joists.",
  },
  {
    key: "fork",
    label: "It decides which way the job goes",
    hint: "Decides… , which sets…",
    example: "Decides subpanel or home runs — which sets every run length after it.",
  },
  {
    key: "trigger",
    label: "It turns something on",
    hint: "If it's… then I also need…",
    example: "Permitted means an inspection before cover — that's a second trip in the price.",
  },
] as const;

/** What Nort asks for THIS need, with the shape most likely to fit already suggested. */
export function whyHint(n: Need): { ask: string; shape: (typeof WHY_SHAPES)[number] } {
  // A measured number almost always lands in arithmetic; a pick almost always opens a branch;
  // anything else is usually a condition that switches extra work on.
  const shape =
    n.measured || n.slot?.type === "number"
      ? WHY_SHAPES[0]
      : n.slot?.type === "select"
        ? WHY_SHAPES[1]
        : WHY_SHAPES[2];
  return { ask: WHY_ASK, shape };
}

export type WhyProblem = "empty" | "too_long" | "no_destination" | "restates_the_question";

/**
 * IS THIS A PATH, OR JUST WORDS? The check that makes "precision for every single person" a thing
 * the app can actually help with rather than hope for.
 *
 * Deliberately forgiving — it flags shapes that are known to be useless, never style. A short blunt
 * line from a tradesman must always pass; the only failures are a line that names nothing
 * downstream, one long enough to be an essay, or one that just says the question again.
 */
export function whyProblems(why: string | undefined, need?: Need): WhyProblem[] {
  const t = (why ?? "").trim();
  if (!t) return ["empty"];
  const out: WhyProblem[] = [];

  // An essay is the failure mode this whole file exists to end. Erik's own drafted lines ran to
  // five sentences and he could not read fifteen of them.
  const sentences = t.split(/[.!?]+\s/).filter((s) => s.trim().length > 1).length;
  if (t.length > 220 || sentences > 3) out.push("too_long");

  // A PATH NAMES A DESTINATION. Either arithmetic, or a verb that lands somewhere.
  const arithmetic = /[×x*+]|times|multiplied|divided|per\s|square|sq\.?\s?ft|linear|total|adds? up/i.test(t);
  // VERB FORMS ONLY. `size` as a bare noun was matching — "I need the panel brand, size and room"
  // is the QUESTION said back, and it was passing as a destination because the ask itself contained
  // the word. A destination needs something that ACTS.
  const lands =
    /\b(decides?|drives?|sets?|feeds?|sizes|tells?|means|gives?|determines?|triggers?|turns?)\b/i.test(t) ||
    /\b(gets? me|comes? out|ends? up|goes into|adds? to)\b/i.test(t) ||
    // The nouns a contractor's price is actually made of. `prices?` not `price` — "prices nothing
    // like an open wall" is a destination and \bprice\b doesn't match inside "prices".
    /\b(prices?|costs?|labou?r|materials?|trips?|hours?|days?)\b/i.test(t);
  if (!arithmetic && !lands) out.push("no_destination");

  // "I ask this because I need to know the panel brand" — restating the question is the most common
  // first attempt, and it carries nothing.
  if (need?.ask) {
    const words = need.ask.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter((w) => w.length > 4);
    const overlap = words.filter((w) => t.toLowerCase().includes(w)).length;
    // 0.6, not 0.7: three long words from the ask is a common length, and two of three coming back
    // verbatim with no destination is already the failure — "I need to know the panel brand".
    if (words.length >= 3 && overlap / words.length >= 0.6 && !arithmetic && !lands) out.push("restates_the_question");
  }
  return out;
}

/** What to say when a line needs work — always a nudge toward the destination, never a grade. */
export function whyNudge(p: WhyProblem[], shape: (typeof WHY_SHAPES)[number]): string | null {
  if (!p.length) return null;
  if (p.includes("empty")) return `${WHY_ASK} Something like: "${shape.example}"`;
  if (p.includes("restates_the_question")) return `That's the question again — where does the ANSWER land? "${shape.hint}"`;
  if (p.includes("no_destination")) return `Say where it ends up: "${shape.hint}"`;
  if (p.includes("too_long")) return "Cut it to one line — the shortest version you'd say out loud.";
  return null;
}
