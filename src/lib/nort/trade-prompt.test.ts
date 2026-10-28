import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CALC_TOOLS } from "@/lib/electrical-calc";
import { NEUTRAL_NORT } from "@/lib/trade-nort";
import {
  calcToolsFor,
  engineeringLine,
  estimatorCalcTools,
  estimatorQuantitiesLine,
  tradeRuleWords,
  voiceEstimateRule,
} from "./trade-prompt";

/**
 * THE TRADE-SHAPED PROMPT PIECES COME FROM lib/trade-nort (cn-v1135), and the calc tools follow
 * the trade. An electrician's words are byte for byte what they were (the field-tested cn-v339 and
 * cn-v1128 sentences); every other trade, and a company whose trade isn't known, gets the neutral
 * set — which names no calculator, because no other trade is handed one.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** The four, in the order electrical-calc defines them. */
const CALC_NAMES = CALC_TOOLS.map((t) => t.name);
const OTHERS = ["deck", "general", "plumbing", "hvac", "landscaping", "roofing", "concrete", "tile", "painting", ""] as const;

describe("Nort's trade-shaped sentences", () => {
  it("an electrician's ENGINEERING line is today's, byte for byte, and names the four calculators it is handed", () => {
    expect(engineeringLine("electrical")).toBe(
      "- ENGINEERING: calculate the real numbers per NEC — CALL the calc tools (calc_wire_size, calc_voltage_drop, calc_conduit_fill, calc_box_fill) for exact answers, don't eyeball sizes/quantities, and show what they returned so it's verifiable.",
    );
  });

  it("every other trade gets the neutral ENGINEERING line, which names no NEC and no calculator (none is offered)", () => {
    for (const k of OTHERS) {
      expect(engineeringLine(k), k).toBe(NEUTRAL_NORT.engineering);
      expect(engineeringLine(k), k).not.toContain("NEC");
      expect(engineeringLine(k), k).not.toContain("calc_");
      expect(engineeringLine(k), k).toContain("THIS trade's own rules and code");
    }
  });

  it("the rule words and the voice rule are the registry's: electrical's own, the neutral set for the rest", () => {
    expect(tradeRuleWords("electrical")).toEqual({
      clarifying: "residential vs commercial, panel size, etc.",
      webSpecs: "pull real specs like wire/breaker sizes",
      cardFacts: "gate/lockbox code, balance due, hours today, amp size, next appointment",
    });
    expect(voiceEstimateRule("electrical")).toContain("Ask 'Propane or natural gas?' up front");
    for (const k of OTHERS) {
      expect(tradeRuleWords(k), k).toEqual({ clarifying: NEUTRAL_NORT.clarifying, webSpecs: NEUTRAL_NORT.webSpecs, cardFacts: NEUTRAL_NORT.cardFacts });
      expect(voiceEstimateRule(k), k).toContain(NEUTRAL_NORT.assumptions);
      expect(voiceEstimateRule(k), k).not.toMatch(/propane|panel/i);
    }
  });

  it("nothing in the file asks whether the trade is electrical — the registry answers", () => {
    const file = src("src/lib/nort/trade-prompt.ts");
    expect(file).not.toContain('"electrical"');
    expect(file).toContain("tradeNort(key)");
  });
});

describe("the calc tools follow the trade (calcToolsFor)", () => {
  it("an electrical company's Nort still has all four", () => {
    expect(CALC_NAMES).toHaveLength(4);
    expect(CALC_NAMES.sort()).toEqual(["calc_box_fill", "calc_conduit_fill", "calc_voltage_drop", "calc_wire_size"]);
    expect(calcToolsFor("electrical").map((t) => t.name).sort()).toEqual(CALC_NAMES);
    expect(calcToolsFor("electrical")).toBe(CALC_TOOLS);
  });

  it("a deck company's Nort — and every other trade's, and an unknown trade's — has no calc_* tool", () => {
    for (const k of OTHERS) expect(calcToolsFor(k), k).toEqual([]);
  });

  it("the chat route offers them through the gate, never the whole list", () => {
    const route = src("src/app/api/chat/route.ts");
    expect(route).toContain("...calcToolsFor(trade.key)");
    expect(route).not.toContain("...CALC_TOOLS");
    expect(route).not.toMatch(/import \{[^}]*\bCALC_TOOLS\b[^}]*\} from "@\/lib\/electrical-calc"/);
    // The tool_use loop keeps its calc_* branch: a tool never offered is never called.
    expect(route).toContain("(CALC_TOOL_NAMES as ReadonlySet<string>).has(tu.name)");
  });
});

describe("the estimator's priced-lines prompt (quotes/actions.ts runEstimator)", () => {
  const ELECTRICAL_RESEARCH =
    "QUANTITIES: calculate per the governing code for this trade — don't eyeball. For anything the CALCULATOR TOOLS cover (wire size, voltage drop, conduit fill, box fill) CALL THE TOOL instead of working the tables from memory; they return the exact NEC answer plus the code rule behind it. Reasoning a table in your head is where wrong numbers come from. ";
  const CATALOG = "QUANTITIES: compute from the measurements given — areas = length × width, linear feet, counts. Do NOT apply trade calculations that don't fit this work. ";

  it("an electrical company in research mode: today's QUANTITIES sentence byte for byte, and the four calculators", () => {
    expect(estimatorQuantitiesLine("electrical", false)).toBe(ELECTRICAL_RESEARCH);
    expect(estimatorCalcTools("electrical", false)?.map((t) => t.name).sort()).toEqual(CALC_NAMES);
  });

  it("a general company in research mode: no NEC sentence and no tools", () => {
    const line = estimatorQuantitiesLine("general", false);
    expect(line).toBe(NEUTRAL_NORT.estimatorQuantities);
    expect(line).not.toMatch(/NEC|CALCULATOR TOOLS|governing code/);
    expect(estimatorCalcTools("general", false)).toBeUndefined();
    for (const k of OTHERS) expect(estimatorCalcTools(k, false), k).toBeUndefined();
  });

  it("catalog mode measures, whatever the trade, and gets no tools — an electrical catalog company included", () => {
    for (const k of ["electrical", ...OTHERS] as const) {
      expect(estimatorQuantitiesLine(k, true), k).toBe(CATALOG);
      expect(estimatorCalcTools(k, true), k).toBeUndefined();
    }
  });

  it("the action reads both through the helpers and keeps no copy of the electrician's sentence", () => {
    const actions = src("src/app/(app)/quotes/actions.ts");
    expect(actions).toContain("estimatorQuantitiesLine(tradeKey, catalogMode)");
    expect(actions).toContain("estimatorCalcTools(tradeKey, catalogMode)");
    expect(actions).toContain("const tradeKey = orgTrade(orgS).key;");
    expect(actions).not.toContain("governing code");
    expect(actions).not.toContain("CALC_TOOLS");
  });
});
