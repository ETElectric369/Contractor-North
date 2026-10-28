/**
 * THE TRADE-SHAPED PARTS OF NORT'S INSTRUCTIONS, kept out of the route so they can be tested.
 *
 * Erik: "Nort cant be giving examples that dont make sense like in the tour." Nort's own
 * instructions were the worst offender: every company's Nort was taught with ET's crew, jobs and
 * wire ("have Brian install the ground rod", "2 4S boxes at Acacia", "30 feet of 10/3 romex"), and
 * every company not pricing from a catalog was told to size its work by the electrical code.
 *
 * SINCE cn-v1135 THE WORDS LIVE IN ONE TABLE (lib/trade-nort, one row per trade, server-only, keyed on
 * the registry's TradeKey): this file only shapes them into Nort's sentences. Nothing here asks "is
 * it electrical?" — the table answers for every trade, and an electrician's words are its row, byte
 * for byte what they were.
 */
import type { TradeKey } from "@/lib/features";
import { CALC_TOOLS } from "@/lib/electrical-calc";
import { calculatorPackagesFor } from "@/lib/trade-package";
import { tradeNort, type TradeNortWords } from "@/lib/trade-nort";

/** Said to the model once, after the trade line: examples are the company's own, or shapes. */
export const NORT_EXAMPLES_RULE =
  "EXAMPLES: any example you give comes from THIS company: its own jobs, people, inspection " +
  "questions, price list and trade. The examples in these instructions are shapes (<job>, <name>, " +
  "<item>), never words to repeat. With nothing of theirs to draw on yet, show the shape and ask; " +
  "never borrow another company's names, places, part numbers or prices, and never make a number up.";

/**
 * THE ENGINEERING LINE of the research-mode estimating method: the trade's own (the electrician's
 * names the NEC and the four calculators it is offered), or the neutral line, which names no
 * calculator at all — a company that is not offered the calc tools (calcToolsFor) is not told
 * about them either.
 */
export function engineeringLine(key: TradeKey | ""): string {
  return tradeNort(key).engineering;
}

/**
 * THE ELECTRICIAN'S FIELD-TESTED WORDS, KEPT FOR ELECTRICAL WORK. Taking ET's examples out of every
 * company's Nort also took out a fix from a field test: an estimate priced out loud, line by line,
 * before anyone asked whether it was propane or natural gas (cn-v339). For an electrical company
 * those words are its own trade, so they stay word for word; every other trade (and a company
 * whose trade isn't known) gets the same rule in its own terms. Both sets are lib/trade-nort's.
 */
export type TradeRuleWords = Pick<TradeNortWords, "clarifying" | "webSpecs" | "cardFacts">;

export function tradeRuleWords(key: TradeKey | ""): TradeRuleWords {
  const { clarifying, webSpecs, cardFacts } = tradeNort(key);
  return { clarifying, webSpecs, cardFacts };
}

/** VOICE RULE 3: confirm the make-or-break assumptions before pricing a big list out loud. */
export function voiceEstimateRule(key: TradeKey | ""): string {
  return (
    "3. BUILDING AN ESTIMATE OUT LOUD: do NOT narrate each line as you add it — the screen fills in the lines. Jump to the KEY POINTS and the running/final TOTAL. And CONFIRM the make-or-break assumptions FIRST, before you price a big list on them — " +
    tradeNort(key).assumptions +
    " so they never have to sit through a whole list and then correct it. When it's built, say the total and one-line summary and ask if it's good — never recite it line by line.\n"
  );
}

/**
 * THE CALC TOOLS ARE THE ELECTRICAL CALCULATOR PACKAGE. Before cn-v1135 every company's Nort was
 * handed calc_wire_size, calc_voltage_drop, calc_conduit_fill and calc_box_fill, so a deck builder's
 * Nort could size conduit for a deck. They are offered to a company whose Tools page carries the
 * Electrical package (the registry's `calculators`), and to nobody else — the same rule as the
 * Tools page, read from the same row, so the two cannot drift. The route's tool_use handling keeps
 * its calc_* branch; a tool never offered is never called.
 */
export function calcToolsFor(key: TradeKey | ""): typeof CALC_TOOLS | [] {
  return calculatorPackagesFor(key).includes("Electrical") ? CALC_TOOLS : [];
}

/**
 * THE ESTIMATOR'S TRADE WORDS (quotes/actions.ts runEstimator): the research-mode QUANTITIES
 * sentence is the trade's own (the electrician's names the calculator tools it is handed); catalog
 * mode measures and applies no trade calculation at all, whatever the trade.
 */
export function estimatorQuantitiesLine(key: TradeKey | "", catalogMode: boolean): string {
  return catalogMode
    ? "QUANTITIES: compute from the measurements given — areas = length × width, linear feet, counts. Do NOT apply trade calculations that don't fit this work. "
    : tradeNort(key).estimatorQuantities;
}

/**
 * The calculators the estimator may call: only an electrical company in research mode. A catalog
 * company (whatever its trade) and a research company of any other trade get none — an electrical
 * tool array is noise on a deck or a plumbing bid and costs tokens. `undefined`, not `[]`: the call
 * passes no tools block at all.
 */
export function estimatorCalcTools(key: TradeKey | "", catalogMode: boolean): typeof CALC_TOOLS | undefined {
  if (catalogMode) return undefined;
  const tools = calcToolsFor(key);
  return tools.length ? tools : undefined;
}
