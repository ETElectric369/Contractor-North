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
