/**
 * THE TRADE-SHAPED PARTS OF NORT'S INSTRUCTIONS, kept out of the route so they can be tested.
 *
 * Erik: "Nort cant be giving examples that dont make sense like in the tour." Nort's own
 * instructions were the worst offender: every company's Nort was taught with ET's crew, jobs and
 * wire ("have Brian install the ground rod", "2 4S boxes at Apache", "30 feet of 10/3 romex"), and
 * every company not pricing from a catalog was told to size its work by the electrical code.
 */
import type { TradeKey } from "@/lib/features";

/** Said to the model once, after the trade line: examples are the company's own, or shapes. */
export const NORT_EXAMPLES_RULE =
  "EXAMPLES: any example you give comes from THIS company: its own jobs, people, walk-through " +
  "questions, price list and trade. The examples in these instructions are shapes (<job>, <name>, " +
  "<item>), never words to repeat. With nothing of theirs to draw on yet, show the shape and ask; " +
  "never borrow another company's names, places, part numbers or prices, and never make a number up.";

/**
 * THE ENGINEERING LINE of the research-mode estimating method. Electrical work keeps the NEC and
 * the four electrical calculators, word for word as before (an electrician's prompt is unchanged).
 * Every other trade, and a company whose trade isn't known, is told to use its own trade's rules
 * and to keep the electrical calculators for electrical work: never assume electrical.
 */
export function engineeringLine(key: TradeKey | ""): string {
  return key === "electrical"
    ? "- ENGINEERING: calculate the real numbers per NEC — CALL the calc tools (calc_wire_size, calc_voltage_drop, calc_conduit_fill, calc_box_fill) for exact answers, don't eyeball sizes/quantities, and show what they returned so it's verifiable."
    : "- ENGINEERING: work sizes and quantities out from the measurements and THIS trade's own rules and code — don't eyeball them, and show the arithmetic so it's verifiable. The calc tools (calc_wire_size, calc_voltage_drop, calc_conduit_fill, calc_box_fill) are for electrical work only.";
}

/**
 * THE ELECTRICIAN'S FIELD-TESTED WORDS, KEPT FOR ELECTRICAL WORK. Taking ET's examples out of every
 * company's Nort also took out a fix from a field test: an estimate priced out loud, line by line,
 * before anyone asked whether it was propane or natural gas (cn-v339). For an electrical company
 * those words are its own trade, so they stay word for word; every other trade (and a company
 * whose trade isn't known) gets the same rule in its own terms.
 */
export type TradeRuleWords = {
  /** The clarifying questions a good estimator asks before pricing. */
  clarifying: string;
  /** What web research pulls for a line the book can't price. */
  webSpecs: string;
  /** The facts worth a tile on the windshield card. */
  cardFacts: string;
};

export function tradeRuleWords(key: TradeKey | ""): TradeRuleWords {
  return key === "electrical"
    ? {
        clarifying: "residential vs commercial, panel size, etc.",
        webSpecs: "pull real specs like wire/breaker sizes",
        cardFacts: "gate/lockbox code, balance due, hours today, amp size, next appointment",
      }
    : {
        clarifying: "residential vs commercial, the size of what's there, etc.",
        webSpecs: "pull the real specs and sizes",
        cardFacts: "gate/lockbox code, balance due, hours today, next appointment",
      };
}

/** VOICE RULE 3: confirm the make-or-break assumptions before pricing a big list out loud. */
export function voiceEstimateRule(key: TradeKey | ""): string {
  const assumptions =
    key === "electrical"
      ? "the ones that change everything: fuel type (propane / natural gas), panel or service size, overhead vs underground, permitted or not. Ask 'Propane or natural gas?' up front"
      : "the ones that change everything in THIS trade (the kind of work, the size or type of what's there, permitted or not). Ask that one question up front";
  return (
    "3. BUILDING AN ESTIMATE OUT LOUD: do NOT narrate each line as you add it — the screen fills in the lines. Jump to the KEY POINTS and the running/final TOTAL. And CONFIRM the make-or-break assumptions FIRST, before you price a big list on them — " +
    assumptions +
    " so they never have to sit through a whole list and then correct it. When it's built, say the total and one-line summary and ask if it's good — never recite it line by line.\n"
  );
}
